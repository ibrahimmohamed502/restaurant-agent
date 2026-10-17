/**
 * P0.3 — the Platform Owner's narrow grant/revoke channel for `escalation.resolve`.
 *
 * WHY THIS EXISTS AS A SEPARATE SERVICE
 * ------------------------------------
 * `escalation.resolve` is held by NO built-in role (see ESCALATION_MANAGER_ROLE in
 * auth/abilities.js). That was deliberate — it means a company cannot grant itself
 * the power to discharge its own customer complaints — but it has a cost: with
 * nobody holding it, escalation closure is unusable until the Platform Owner acts.
 *
 * This module is that action, and it is deliberately the ONLY way it happens in
 * this codebase. There is no general "give a role to a user" endpoint, no role
 * builder, and no tenant-facing route that can reach this role.
 *
 * WHAT IT CAN DO, EXACTLY
 * -----------------------
 * Assign, or remove, the `Escalation Manager` role for ONE explicitly named user in
 * ONE explicitly named tenant. That is the whole surface.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION
 * ----------------------------------
 *  - It cannot grant any other role. The role name is a module constant, not a
 *    parameter, so no caller can point it at `Company Admin`.
 *  - It cannot grant a different permission set. The stored `permissions` of the
 *    role row are RE-READ and COMPARED against exactly ["escalation.resolve"]
 *    before the assignment happens. If anyone ever edited that JSONB to add
 *    `conversation.reply` or `*`, the grant is REFUSED rather than handed over —
 *    the endpoint verifies what it is about to give away instead of trusting a row
 *    it did not write.
 *  - It cannot confer brand scope. `user_brand_grants` / `user_brand_scope_all`
 *    are not touched, so a manager still cannot reach a conversation outside the
 *    brands they were separately granted.
 *  - It cannot be done by a company. The route is behind `requirePlatformSuperAdmin`,
 *    which requires BOTH a row in the authoritative `platform_super_admins` table
 *    AND the platform role. A role name alone is not accepted, so inventing the
 *    role locally does not get anyone in.
 *  - It cannot be done silently. A mandatory reason is stored with the assignment.
 *  - It cannot be granted to the Platform Owner themselves, refused explicitly
 *    below: the Platform Owner's job here is to delegate complaint discharge to a
 *    named employee, not to acquire customer-data access by default.
 *
 * IDEMPOTENCY
 * -----------
 * Granting twice is not an error and not a second `user_roles` row: the INSERT
 * carries ON CONFLICT DO NOTHING and the zero-row case is reported as
 * `alreadyGranted`. Revoking a role that is not held reports `alreadyRevoked`. A
 * retried request after a network timeout therefore always converges, and never
 * presents a success that did not happen as a failure.
 */

import { pool } from '../db/pg.js';
import {
  ESCALATION_MANAGER_ROLE,
  ESCALATION_RESOLVE_ABILITY,
  BUILT_IN_ROLES
} from '../auth/abilities.js';

/**
 * The ONE permission set this endpoint is allowed to hand out.
 *
 * Compared as a SET, not as a string: `["escalation.resolve"]` and the same array
 * reordered are equal, while `["escalation.resolve","conversation.reply"]` is not.
 */
const EXPECTED_PERMISSIONS = Object.freeze([ESCALATION_RESOLVE_ABILITY]);

const MIN_REASON_CHARS = 8;
const MAX_REASON_CHARS = 500;

/**
 * Reject a malformed id BEFORE it reaches a query.
 *
 * Without this, a non-uuid string makes PostgreSQL raise `invalid input syntax for
 * type uuid` (22P02), which is an unexpected error and becomes an opaque 500 that
 * tells an operator nothing about what they actually sent.
 *
 * It also keeps the status semantics honest: a well-formed id that does not exist
 * is a 404, a malformed one is a 400, and those are genuinely different facts.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new PlatformRoleError(400, 'BAD_REQUEST', `${field} must be a uuid`);
  }
  return value;
}

export const PLATFORM_ROLE_ERRORS = Object.freeze({
  REASON_REQUIRED: 'REASON_REQUIRED',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_INACTIVE: 'USER_INACTIVE',
  USER_WRONG_TENANT: 'USER_WRONG_TENANT',
  ROLE_NOT_SEEDED: 'ROLE_NOT_SEEDED',
  ROLE_PERMISSIONS_UNEXPECTED: 'ROLE_PERMISSIONS_UNEXPECTED',
  TARGET_IS_PLATFORM_ADMIN: 'TARGET_IS_PLATFORM_ADMIN'
});

export class PlatformRoleError extends Error {
  constructor(status, code, message, detail = {}) {
    super(message);
    this.name = 'PlatformRoleError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function normaliseReason(reason) {
  if (typeof reason !== 'string') return null;
  const text = reason.trim().replace(/\s+/g, ' ');
  if (text.length < MIN_REASON_CHARS) return null;
  return text.slice(0, MAX_REASON_CHARS);
}

function samePermissionSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const a = actual.map(String).sort();
  const e = [...expected].map(String).sort();
  return a.length === e.length && a.every((v, i) => v === e[i]);
}

/* ------------------------------------------------------------- inspection */

/**
 * Who currently holds the role in this tenant.
 *
 * Read-only, brand-agnostic, and deliberately exposes the role's STORED
 * permissions so an operator can see what would be handed out rather than trusting
 * the UI to describe it.
 */
export async function listEscalationManagers({ tenantId, db = pool } = {}) {
  assertUuid(tenantId, 'tenantId');
  // `user_roles` has no timestamp column — it is only (user_id, role_id). The grant
  // time therefore comes from the audit row, which is written in the same
  // transaction as the assignment and so cannot disagree with it.
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.status,
            r.name AS role, r.permissions,
            (SELECT max(a.created_at) FROM audit_logs a
              WHERE a.object_id = u.id
                AND a.tenant_id = u.tenant_id
                AND a.action = 'platform.escalation_manager.grant') AS granted_at
       FROM user_roles ur
       JOIN roles  r ON r.id = ur.role_id
       JOIN users  u ON u.id = ur.user_id
      WHERE r.tenant_id = $1
        AND r.name     = $2
      ORDER BY u.name NULLS LAST, u.email`,
    [tenantId, ESCALATION_MANAGER_ROLE]
  );
  return rows;
}

/**
 * Every active user in the tenant, as grant targets.
 *
 * Deliberately NOT filtered to existing holders: the point of the picker is to
 * choose somebody new. Brand grants are NOT shown as a criterion, because this
 * endpoint does not confer brand scope and implying it does would be a lie in the
 * UI.
 */
export async function listGrantableUsers({ tenantId, db = pool } = {}) {
  assertUuid(tenantId, 'tenantId');
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name,
            EXISTS (SELECT 1 FROM user_roles ur
                      JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND r.tenant_id = u.tenant_id
                       AND r.name = $2) AS already_granted
       FROM users u
      WHERE u.tenant_id = $1 AND u.status = 'active'
      ORDER BY u.name NULLS LAST, u.email`,
    [tenantId, ESCALATION_MANAGER_ROLE]
  );
  return rows;
}

/* ------------------------------------------------------------ grant/revoke */

/**
 * Load and validate the role row, refusing anything unexpected.
 *
 * This is the security-critical read. Two independent reasons to refuse:
 *
 *   - the row is missing, which means migration 017 has not been applied and there
 *     is nothing legitimate to assign;
 *   - the row's permissions are not EXACTLY the approved set, which means somebody
 *     changed a role that this endpoint is about to hand to a real person. The
 *     safe move is to stop, not to grant a widened version of it.
 */
async function loadAndVerifyRole({ tenantId, db }) {
  if (BUILT_IN_ROLES.includes(ESCALATION_MANAGER_ROLE)) {
    // Defence in depth. A built-in name has its stored permissions IGNORED, so the
    // ability would silently never apply — verified in abilities.js. If someone
    // ever adds this name to BUILT_IN_ROLES, granting it would appear to work and
    // do nothing, which is the exact failure this whole design avoids.
    throw new PlatformRoleError(500, 'ROLE_NAME_COLLISION',
      'the escalation manager role must not be a built-in role name');
  }

  const { rows } = await db.query(
    `SELECT id, name, permissions FROM roles WHERE tenant_id = $1 AND name = $2`,
    [tenantId, ESCALATION_MANAGER_ROLE]
  );
  const role = rows[0];
  if (!role) {
    throw new PlatformRoleError(409, PLATFORM_ROLE_ERRORS.ROLE_NOT_SEEDED,
      'the escalation manager role has not been created for this company yet');
  }
  if (!samePermissionSet(role.permissions, EXPECTED_PERMISSIONS)) {
    throw new PlatformRoleError(409, PLATFORM_ROLE_ERRORS.ROLE_PERMISSIONS_UNEXPECTED,
      'the escalation manager role carries unexpected permissions and will not be assigned',
      { expected: EXPECTED_PERMISSIONS, actual: role.permissions });
  }
  return role;
}

/**
 * Validate the target user: exists, is in THIS tenant, and is active.
 *
 * The tenant check is the cross-tenant isolation boundary. It is stated as an
 * explicit predicate rather than as a query filter so that "wrong tenant" and
 * "no such user" are distinguishable in the audit trail without telling an
 * unauthenticated caller which — both refuse identically from the outside.
 */
async function loadAndVerifyTarget({ tenantId, userId, db }) {
  const { rows } = await db.query(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.status,
            EXISTS (SELECT 1 FROM platform_super_admins p WHERE p.user_id = u.id) AS is_platform_admin
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  const user = rows[0];
  if (!user) {
    throw new PlatformRoleError(404, PLATFORM_ROLE_ERRORS.USER_NOT_FOUND, 'no such user');
  }
  if (user.tenant_id !== tenantId) {
    throw new PlatformRoleError(404, PLATFORM_ROLE_ERRORS.USER_WRONG_TENANT,
      'that user does not belong to this company');
  }
  if (user.status !== 'active') {
    throw new PlatformRoleError(409, PLATFORM_ROLE_ERRORS.USER_INACTIVE,
      'that user account is not active');
  }
  if (user.is_platform_admin) {
    // "Never grant customer-data access automatically to the Platform Owner."
    // Refused explicitly rather than silently ignored, so if this is ever reached
    // by mistake the reason is obvious instead of the grant appearing to work.
    throw new PlatformRoleError(409, PLATFORM_ROLE_ERRORS.TARGET_IS_PLATFORM_ADMIN,
      'the escalation role cannot be granted to a platform super admin');
  }
  return user;
}

/**
 * Grant the escalation role. Transactional, idempotent, audited in the same
 * transaction as the write.
 *
 * The audit row is written with the transaction's own client on purpose. The
 * shared `audit()` helper is fire-and-forget on a separate pool and swallows its
 * own errors, which is fine for telemetry and wrong here: an attribution that can
 * silently not exist is not attribution.
 */
export async function grantEscalationManager({ tenantId, userId, reason, actorUserId, ip = null, db = pool }) {
  assertUuid(tenantId, 'tenantId');
  assertUuid(userId, 'userId');
  const reasonText = normaliseReason(reason);
  if (!reasonText) {
    throw new PlatformRoleError(422, PLATFORM_ROLE_ERRORS.REASON_REQUIRED,
      `a reason of at least ${MIN_REASON_CHARS} characters is required to grant this role`);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: tenantRows } = await client.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (!tenantRows[0]) {
      throw new PlatformRoleError(404, PLATFORM_ROLE_ERRORS.TENANT_NOT_FOUND, 'no such company');
    }

    const role = await loadAndVerifyRole({ tenantId, db: client });
    const user = await loadAndVerifyTarget({ tenantId, userId, db: client });

    // `user_roles` is only (user_id, role_id) — it carries no timestamp, so the
    // RETURNING cannot name one. rowCount alone decides whether this was a real
    // change, which is all the idempotency contract needs.
    const ins = await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING
       RETURNING role_id`,
      [user.id, role.id]
    );
    const granted = ins.rowCount > 0;

    const auditAction = granted
      ? 'platform.escalation_manager.grant'
      : 'platform.escalation_manager.grant.noop';
    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
       VALUES ($1,$2,$3,'user',$4,$5,$6)
       RETURNING created_at`,
      [
        tenantId,
        actorUserId ?? null,
        auditAction,
        user.id,
        ip,
        JSON.stringify({
          role: ESCALATION_MANAGER_ROLE,
          permissions: EXPECTED_PERMISSIONS,
          targetEmail: user.email,
          reason: reasonText,
          granted
        })
      ]
    );

    await client.query('COMMIT');
    return {
      granted,
      alreadyGranted: !granted,
      tenantId,
      userId: user.id,
      email: user.email,
      role: ESCALATION_MANAGER_ROLE,
      permissions: EXPECTED_PERMISSIONS,
      reason: reasonText
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release?.();
  }
}

/**
 * Revoke the escalation role. Transactional, idempotent, audited.
 *
 * Removing access is never an error when the access was already absent: a retried
 * revoke must converge rather than alarm the operator.
 */
export async function revokeEscalationManager({ tenantId, userId, reason, actorUserId, ip = null, db = pool }) {
  assertUuid(tenantId, 'tenantId');
  assertUuid(userId, 'userId');
  const reasonText = normaliseReason(reason);
  if (!reasonText) {
    throw new PlatformRoleError(422, PLATFORM_ROLE_ERRORS.REASON_REQUIRED,
      `a reason of at least ${MIN_REASON_CHARS} characters is required to revoke this role`);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: tenantRows } = await client.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (!tenantRows[0]) {
      throw new PlatformRoleError(404, PLATFORM_ROLE_ERRORS.TENANT_NOT_FOUND, 'no such company');
    }

    // Read the role row WITHOUT the expected-permissions check: a tampered role must
    // still be revocable. Refusing to remove access because the grant was malformed
    // would be the wrong direction to fail in.
    const { rows: roleRows } = await client.query(
      `SELECT id, name FROM roles WHERE tenant_id = $1 AND name = $2`,
      [tenantId, ESCALATION_MANAGER_ROLE]
    );
    const role = roleRows[0];

    const { rows: userRows } = await client.query(
      'SELECT id, email FROM users WHERE id = $1 AND tenant_id = $2',
      [userId, tenantId]
    );
    const user = userRows[0];
    if (!user) {
      throw new PlatformRoleError(404, PLATFORM_ROLE_ERRORS.USER_NOT_FOUND,
        'no such user in this company');
    }

    let rowCount = 0;
    if (role) {
      const del = await client.query(
        'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
        [user.id, role.id]
      );
      rowCount = del.rowCount;
    }

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
       VALUES ($1,$2,$3,'user',$4,$5,$6)`,
      [
        tenantId,
        actorUserId ?? null,
        rowCount > 0 ? 'platform.escalation_manager.revoke' : 'platform.escalation_manager.revoke.noop',
        user.id,
        ip,
        JSON.stringify({
          role: ESCALATION_MANAGER_ROLE,
          targetEmail: user.email,
          reason: reasonText,
          revoked: rowCount > 0
        })
      ]
    );

    await client.query('COMMIT');
    return {
      revoked: rowCount > 0,
      alreadyRevoked: rowCount === 0,
      tenantId,
      userId: user.id,
      email: user.email,
      role: ESCALATION_MANAGER_ROLE,
      reason: reasonText
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release?.();
  }
}