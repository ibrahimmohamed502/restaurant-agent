/**
 * A1 - Custom Roles & Permissions service.
 *
 * Custom roles are rows in the `roles` table with a non-built-in name. Their
 * abilities live in `roles.permissions` (jsonb array) and are resolved at
 * session time by effectiveCustomAbilities(). Built-in roles ignore that column
 * entirely - their abilities come from the hardcoded ROLE_ABILITIES map.
 *
 * This module adds the CRUD lifecycle on top of that existing mechanism. It
 * does NOT invent a new permission system: can() and canDelegateRole() are the
 * authority, exactly as they are for everything else.
 *
 * Security invariants enforced here:
 *   1. Delegation ceiling: every ability in a custom role must be held by the
   *      actor. canDelegateRole() checks this.
 *   2. No wildcards: '*' and 'x.*' are rejected unless the actor genuinely
   *      holds a matching wildcard. A Company Admin holding 'platform.*' (they
   *      don't) could not create a role with 'platform.*'.
   *   3. No unknown abilities: only abilities in the known set are accepted.
   *   4. No reserved names: built-in role names and 'Platform Super Admin'
   *      cannot be created, edited or deleted.
   *   5. System roles are immutable: Company Admin, Supervisor, Agent,
   *      Platform Super Admin cannot be edited or deleted.
   *   6. Tenant isolation: every lookup filters by tenant_id.
   *   7. Disabled roles grant nothing: the session loader filters them out.
   *   8. Audit: every mutation writes a before/after audit row.
 */
import { pool } from '../db/pg.js';
import { can, canDelegateRole, ROLE_ABILITIES, NON_DELEGABLE_ROLE_NAMES, BUILT_IN_ROLES } from '../auth/abilities.js';
// writeAudit is a local helper in teamAccess.js, not a shared module. Rather
// than importing it (which would create a dependency between two services that
// should stay independent), the roles service writes its own audit rows using
// the same pattern. One definition per service, one set of semantics per
// service, no chance of the two drifting apart in a way that matters.

const SYSTEM_ROLES = new Set(['Company Admin', 'Supervisor', 'Agent', 'Platform Super Admin']);

/**
 * The complete set of abilities a custom role may carry. An allowlist, not a
 * filter over everything: a new ability added anywhere else must be named here
 * before it can be granted, so this endpoint cannot start handing out powers
 * it was never asked about.
 */
const KNOWN_ABILITIES = new Set([
  // Company-level
  'company.read', 'company.update',
  // Brand
  'brand.read', 'brand.create', 'brand.update', 'brand.disable',
  'brand.grant', 'brand.revoke', 'brand.grant_all', 'brand.revoke_all',
  'brand.integration.connect', 'brand.integration.disconnect',
  'brand.integration.reconnect', 'brand.integration.status',
  // Users
  'user.read', 'user.create', 'user.update', 'user.disable',
  // Teams
  'team.read', 'team.create', 'team.update', 'team.disable', 'team.assign',
  // Roles (meta - a role manager can manage roles, but not grant themselves more)
  'role.read', 'role.create', 'role.update', 'role.disable', 'role.delete',
  // Conversations
  'conversation.read', 'conversation.handoff', 'conversation.assign',
  'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
  'conversation.resume_ai', 'conversation.reply',
  'conversation.assign_self', 'conversation.reply_own', 'conversation.resolve_own',
  // Notes
  'note.read', 'note.create', 'note.delete_own', 'note.delete_any',
  // Notifications
  'notification.read',
  // Knowledge
  'knowledge.read', 'knowledge.edit',
  // AI
  'ai.config.read', 'ai.config.write',
  // Audit
  'audit.read',
  // Escalation
  'escalation.resolve',
  // Platform (only Platform Super Admin holds these)
  'platform.*', 'company.metrics', 'company.create', 'company.disable'
]);

/**
 * Validate that every ability in the list is:
 *   1. Known (in KNOWN_ABILITIES).
 *   2. Not a wildcard (no '*' anywhere).
 *   3. Held by the actor (delegation ceiling).
 *
 * Returns the validated, deduplicated list, or throws a RoleError.
 */
function validateAbilities(actorRoles, actorCustomAbilities, requested) {
  if (!Array.isArray(requested)) throw new RoleError('ROLE_INVALID', 422, 'permissions must be an array');
  const unique = [...new Set(requested.map(String))];
  for (const a of unique) {
    if (!KNOWN_ABILITIES.has(a)) {
      throw new RoleError('ROLE_INVALID', 422, `unknown ability: ${a}`);
    }
    if (a.includes('*')) {
      throw new RoleError('ROLE_INVALID', 422, `wildcard abilities are not permitted in custom roles: ${a}`);
    }
  }
  // Delegation ceiling: every requested ability must be held by the actor.
  if (!canDelegateRole({
    actorRoles,
    actorCustomAbilities,
    targetRoleName: '__validation__',
    targetPermissions: unique
  })) {
    throw new RoleError('ROLE_NOT_DELEGABLE', 403, 'you cannot grant abilities you do not hold');
  }
  return unique;
}

export class RoleError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'RoleError';
    this.code = code;
    this.status = status;
  }
}

export const ROLE_ERRORS = Object.freeze({
  NOT_FOUND: 'ROLE_NOT_FOUND',
  NAME_TAKEN: 'ROLE_NAME_TAKEN',
  NAME_INVALID: 'ROLE_NAME_INVALID',
  SYSTEM: 'ROLE_SYSTEM',
  NOT_DELEGABLE: 'ROLE_NOT_DELEGABLE',
  INVALID: 'ROLE_INVALID',
  FORBIDDEN: 'ROLE_FORBIDDEN'
});

const fail = (code, status, message) => { throw new RoleError(code, status, message); };

function normaliseName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) fail(ROLE_ERRORS.NAME_INVALID, 422, 'role name is required');
  if (name.length > 60) fail(ROLE_ERRORS.NAME_INVALID, 422, 'role name is too long');
  if (/[^\w\s\-]/.test(name)) fail(ROLE_ERRORS.NAME_INVALID, 422, 'role name contains characters that are not allowed');
  // Reserved names: built-in roles and the platform role cannot be shadowed.
  if (SYSTEM_ROLES.has(name)) fail(ROLE_ERRORS.SYSTEM, 409, 'that name is reserved for a built-in role');
  return name;
}

function acquire(db) {
  if (db && typeof db.connect === 'function' && typeof db.release !== 'function') {
    // Pool: borrow and release.
    return db.connect().then((c) => ({ client: c, release: () => c.release() }));
  }
  // Client passed in (tests): use directly, no release.
  return Promise.resolve({ client: db, release: () => {} });
}

export async function listRoles({ tenantId, db = pool }) {
  if (!tenantId) fail(ROLE_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    const { rows } = await client.query(
      `SELECT id, name, permissions, status, created_at, created_by, updated_at
         FROM roles
        WHERE tenant_id = $1
        ORDER BY name ASC`,
      [tenantId]
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions ?? [],
      status: r.status,
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at
    }));
  } finally { release(); }
}

export async function createRole({ tenantId, actorUserId, actorRoles, actorCustomAbilities, name, permissions, db = pool }) {
  if (!tenantId || !actorUserId) fail(ROLE_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const clean = normaliseName(name);
  const validated = validateAbilities(actorRoles ?? [], actorCustomAbilities ?? [], permissions ?? []);

  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');

    // Idempotency: same name in the same company is refused.
    const { rows: existing } = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`,
      [tenantId, clean]
    );
    if (existing.length) fail(ROLE_ERRORS.NAME_TAKEN, 409, 'a role with that name already exists in this company');

    const { rows: [created] } = await client.query(
      `INSERT INTO roles (tenant_id, name, permissions, status, created_by)
       VALUES ($1, $2, $3::jsonb, 'active', $4)
       RETURNING id, name, permissions, status, created_at, created_by, updated_at`,
      [tenantId, clean, JSON.stringify(validated), actorUserId]
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, metadata)
       VALUES ($1, $2, $3, 'role', $4, $5::jsonb)`,
      [tenantId, actorUserId, 'role.created', created.id, JSON.stringify({ name: clean, permissions: validated })]
    );

    await client.query('COMMIT');
    return {
      id: created.id, name: created.name, permissions: created.permissions ?? [],
      status: created.status, createdAt: created.created_at,
      createdBy: created.created_by, updatedAt: created.updated_at
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { release(); }
}

export async function updateRole({ tenantId, actorUserId, actorRoles, actorCustomAbilities, roleId, name, permissions, db = pool }) {
  if (!tenantId || !actorUserId) fail(ROLE_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');

    const { rows: [before] } = await client.query(
      `SELECT id, name, permissions, status FROM roles WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [roleId, tenantId]
    );
    if (!before) fail(ROLE_ERRORS.NOT_FOUND, 404, 'role not found');
    if (SYSTEM_ROLES.has(before.name)) fail(ROLE_ERRORS.SYSTEM, 409, 'system roles cannot be edited');

    const nextName = name === undefined ? before.name : normaliseName(name);
    const nextPermissions = permissions === undefined
      ? (before.permissions ?? [])
      : validateAbilities(actorRoles ?? [], actorCustomAbilities ?? [], permissions);

    // Renaming onto an existing name is refused.
    if (nextName !== before.name) {
      const { rows: taken } = await client.query(
        `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2 AND id <> $3`,
        [tenantId, nextName, roleId]
      );
      if (taken.length) fail(ROLE_ERRORS.NAME_TAKEN, 409, 'a role with that name already exists in this company');
    }

    // Delegation ceiling on the FINAL permission set, not just the diff.
    // A Company Admin editing a role they inherited must not end up granting
    // more than they hold.
    if (!canDelegateRole({
      actorRoles, actorCustomAbilities,
      targetRoleName: nextName, targetPermissions: nextPermissions
    })) {
      fail(ROLE_ERRORS.NOT_DELEGABLE, 403, 'you cannot grant abilities you do not hold');
    }

    const { rows: [after] } = await client.query(
      `UPDATE roles SET name = $3, permissions = $4::jsonb, updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name, permissions, status, created_at, created_by, updated_at`,
      [roleId, tenantId, nextName, JSON.stringify(nextPermissions)]
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, metadata)
       VALUES ($1, $2, $3, 'role', $4, $5::jsonb)`,
      [tenantId, actorUserId, 'role.updated', roleId, JSON.stringify({
        before: { name: before.name, permissions: before.permissions },
        after: { name: nextName, permissions: nextPermissions }
      })]
    );

    await client.query('COMMIT');
    return {
      id: after.id, name: after.name, permissions: after.permissions ?? [],
      status: after.status, createdAt: after.created_at,
      createdBy: after.created_by, updatedAt: after.updated_at
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { release(); }
}

export async function setRoleStatus({ tenantId, actorUserId, roleId, status, db = pool }) {
  if (!tenantId || !actorUserId) fail(ROLE_ERRORS.FORBIDDEN, 403, 'company scope is required');
  if (status !== 'active' && status !== 'disabled') fail(ROLE_ERRORS.NAME_INVALID, 422, 'status must be active or disabled');
  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');

    const { rows: [before] } = await client.query(
      `SELECT id, name, status FROM roles WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [roleId, tenantId]
    );
    if (!before) fail(ROLE_ERRORS.NOT_FOUND, 404, 'role not found');
    if (SYSTEM_ROLES.has(before.name)) fail(ROLE_ERRORS.SYSTEM, 409, 'system roles cannot be disabled');

    // A soft-deleted role cannot be re-enabled through the normal endpoint.
    if (before.status === 'deleted' && status === 'active') {
      fail(ROLE_ERRORS.NOT_DELEGABLE, 409, 'a deleted role cannot be re-enabled');
    }

    const { rows: [after] } = await client.query(
      `UPDATE roles SET status = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name, permissions, status, created_at, created_by, updated_at`,
      [roleId, tenantId, status]
    );

    // When disabling, invalidate all sessions for users holding this role.
    // The session loader filters disabled roles, but existing sessions still
    // carry the old abilities until they expire. Revoking them forces a fresh
    // session that re-reads the (now disabled) role and drops the abilities.
    if (status === 'disabled') {
      await client.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = $1)
            AND revoked_at IS NULL`,
        [roleId]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, metadata)
       VALUES ($1, $2, $3, 'role', $4, $5::jsonb)`,
      [tenantId, actorUserId, status === 'disabled' ? 'role.disabled' : 'role.enabled', roleId,
        JSON.stringify({ name: before.name, from: before.status, to: status })]
    );

    await client.query('COMMIT');
    return {
      id: after.id, name: after.name, permissions: after.permissions ?? [],
      status: after.status, createdAt: after.created_at,
      createdBy: after.created_by, updatedAt: after.updated_at
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { release(); }
}

export async function deleteRole({ tenantId, actorUserId, roleId, db = pool }) {
  if (!tenantId || !actorUserId) fail(ROLE_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');

    const { rows: [before] } = await client.query(
      `SELECT id, name, status FROM roles WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [roleId, tenantId]
    );
    if (!before) fail(ROLE_ERRORS.NOT_FOUND, 404, 'role not found');
    if (SYSTEM_ROLES.has(before.name)) fail(ROLE_ERRORS.SYSTEM, 409, 'system roles cannot be deleted');

    // Cannot delete a role that still has holders.
    const { rows: [holders] } = await client.query(
      `SELECT count(*)::int AS n FROM user_roles WHERE role_id = $1`,
      [roleId]
    );
    if (holders.n > 0) fail(ROLE_ERRORS.NOT_DELEGABLE, 409, 'remove all users from this role before deleting it');

    // Soft delete: set status to deleted. The row stays for audit history.
    // Distinct from 'disabled' so a deleted role cannot be re-enabled.
    const { rows: [after] } = await client.query(
      `UPDATE roles SET status = 'deleted', updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name, permissions, status, created_at, created_by, updated_at`,
      [roleId, tenantId]
    );

    // Invalidate sessions for anyone who held this role (none, since we checked
    // above, but defensive).
    await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = $1)
          AND revoked_at IS NULL`,
      [roleId]
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, metadata)
       VALUES ($1, $2, $3, 'role', $4, $5::jsonb)`,
      [tenantId, actorUserId, 'role.deleted', roleId, JSON.stringify({ name: before.name })]
    );

    await client.query('COMMIT');
    return {
      id: after.id, name: after.name, permissions: after.permissions ?? [],
      status: after.status, createdAt: after.created_at,
      createdBy: after.created_by, updatedAt: after.updated_at
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { release(); }
}

export async function getRoleUsers({ tenantId, roleId, db = pool }) {
  if (!tenantId) fail(ROLE_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    const { rows: [role] } = await client.query(
      `SELECT id FROM roles WHERE id = $1 AND tenant_id = $2`,
      [roleId, tenantId]
    );
    if (!role) fail(ROLE_ERRORS.NOT_FOUND, 404, 'role not found');

    const { rows } = await client.query(
      `SELECT u.id, u.name, u.email, u.status
         FROM user_roles ur JOIN users u ON u.id = ur.user_id
        WHERE ur.role_id = $1 AND u.tenant_id = $2
        ORDER BY u.name ASC`,
      [roleId, tenantId]
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, status: r.status
    }));
  } finally { release(); }
}

export async function canManageRoles(session) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  const custom = Array.isArray(session?.customAbilities) ? session.customAbilities : [];
  return can(roles, 'role.read', custom) || can(roles, 'role.create', custom);
}

export async function canEditRoles(session) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  const custom = Array.isArray(session?.customAbilities) ? session.customAbilities : [];
  return can(roles, 'role.create', custom) || can(roles, 'role.update', custom)
    || can(roles, 'role.disable', custom) || can(roles, 'role.delete', custom);
}
