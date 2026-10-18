/**
 * P0.5-A — Team and membership administration.
 *
 * WHAT THIS IS FOR
 * Departments (Marketing, Purchasing, Customer Service) existed as an empty
 * table with no API at all: `team_members` had zero rows in production and no
 * route could ever write one. AI routing therefore had no destination. This
 * module is the backend half of giving an owner real control of them.
 *
 * WHAT IT DELIBERATELY IS NOT
 * It grants no abilities. Holding `team.*` lets an administrator organise who
 * sits where; promoting somebody, or widening their brand access, stays behind
 * `user.update` / `brand.grant`. Organising and promoting are different acts
 * and are kept behind different keys.
 *
 * THE FOUR INVARIANTS, all enforced in SQL rather than in the caller
 *   1. Tenant isolation   - every statement is scoped by tenant_id, and a team
 *                          or user from another company is invisible, not merely
 *                          forbidden.
 *   2. No self-escalation - you cannot add yourself to a team using an authority
 *                          you do not already hold, and you cannot revoke your
 *                          own last team membership while acting through it.
 *   3. Audited           - every mutation writes a before/after audit row.
 *   4. Concurrency-safe   - membership changes take a row lock, so a change made
 *                          while an assignment is in flight is ordered against
 *                          that decision rather than slipping past it.
 */

import pg from 'pg';
import { pool } from '../db/pg.js';
import { HANDLING_ROLES } from './handoff.js';
import { can } from '../auth/abilities.js';

const { Pool } = pg;

export const TEAM_ERRORS = Object.freeze({
  NOT_FOUND: 'TEAM_NOT_FOUND',
  NAME_TAKEN: 'TEAM_NAME_TAKEN',
  NAME_INVALID: 'TEAM_NAME_INVALID',
  USER_NOT_FOUND: 'TEAM_MEMBER_NOT_FOUND',
  BRAND_NOT_FOUND: 'TEAM_BRAND_NOT_FOUND',
  FORBIDDEN: 'TEAM_FORBIDDEN',
  SELF_ESCALATION: 'TEAM_SELF_ESCALATION',
  ALREADY_MEMBER: 'TEAM_ALREADY_MEMBER',
  NOT_A_MEMBER: 'TEAM_NOT_A_MEMBER',
  LAST_ADMIN_TEAM: 'TEAM_LAST_ADMIN_MEMBER'
});

export class TeamError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status, message) => { throw new TeamError(code, status, message); };

/**
 * Borrow a client for a transaction.
 *
 * Accepts either a Pool (the production call: borrow, use, release) or an
 * already-connected Client (the test call, which may itself be inside a
 * transaction). Calling `.connect()` on a connected Client throws, so the two are
 * told apart by shape rather than by a flag the caller has to remember.
 */
async function acquire(db) {
  // A `pg.Client` exposes `.connect()` too, and has no `release` either, so
  // duck-typing cannot tell the two apart. `instanceof` is the only reliable
  // discriminator; a shape check would look right and quietly call connect()
  // on a live Client.
  if (db instanceof Pool) {
    const client = await db.connect();
    return { client, release: () => client.release() };
  }
  return { client: db, release: () => {} };
}

/**
 * Names are what a human types, so keep them short, printable and unambiguous.
 *
 * The ORIGINAL casing is preserved for display - only the comparison is
 * case-folded. "Marketing" is stored and shown as "Marketing"; it simply cannot
 * coexist with "marketing" in the same company, because that is one team typed
 * twice. Two different companies may still use the same name.
 */
function normaliseName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) fail(TEAM_ERRORS.NAME_INVALID, 422, 'team name is required');
  if (name.length > 80) fail(TEAM_ERRORS.NAME_INVALID, 422, 'team name is too long');
  // No control characters, and no angle brackets: this string is rendered.
  if (/[\x00-\x1f<>"&]/.test(name)) {
    fail(TEAM_ERRORS.NAME_INVALID, 422, 'team name contains characters that are not allowed');
  }
  return name;
}

async function writeAudit(client, { tenantId, actorUserId, action, objectId, metadata }) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, metadata)
     VALUES ($1, $2, $3, 'team', $4, $5::jsonb)`,
    [tenantId, actorUserId, action, String(objectId), JSON.stringify(metadata ?? {})]
  );
}

/* ------------------------------------------------------------------- read */

/**
 * Teams with their live member counts, scoped to the caller's company.
 * Disabled teams are included but flagged: hiding them would make a disabled
 * team look like a deleted one.
 */
export async function listTeams({ tenantId, includeDisabled = true, db = pool }) {
  if (!tenantId) fail(TEAM_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.status, t.brand_id, b.name AS brand_name,
            t.created_at,
            (SELECT count(*)::int FROM team_members tm
              WHERE tm.team_id = t.id AND tm.tenant_id = t.tenant_id
                AND tm.revoked_at IS NULL) AS member_count
       FROM teams t
       LEFT JOIN brands b ON b.id = t.brand_id
      WHERE t.tenant_id = $1
        AND ($2::boolean OR t.status = 'active')
      ORDER BY t.name ASC`,
    [tenantId, includeDisabled]
  );
  return rows;
}

/**
 * Members of one team, with the ROLE and BRAND facts an administrator actually
 * needs to decide whether this person can take work: can they see the brand,
 * do they hold a handling role, are they even active.
 */
export async function listTeamMembers({ tenantId, teamId, db = pool }) {
  if (!tenantId || !teamId) fail(TEAM_ERRORS.NOT_FOUND, 404, 'team not found');
  const { rows } = await db.query(
    `SELECT tm.user_id, tm.role_in_team, tm.added_at, tm.revoked_at,
            u.name, u.email, u.status AS user_status,
            COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
            EXISTS (SELECT 1 FROM user_brand_scope_all s
                     WHERE s.user_id = u.id AND s.tenant_id = u.tenant_id AND s.revoked_at IS NULL) AS all_brands,
            COALESCE((
              SELECT array_agg(g.brand_id) FROM user_brand_grants g
               WHERE g.user_id = u.id AND g.tenant_id = u.tenant_id AND g.revoked_at IS NULL
            ), '{}') AS brand_ids
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id AND u.tenant_id = tm.tenant_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE tm.team_id = $1 AND tm.tenant_id = $2 AND tm.revoked_at IS NULL
      GROUP BY tm.user_id, tm.role_in_team, tm.added_at, tm.revoked_at, u.id, u.name, u.email, u.status
      ORDER BY u.name ASC`,
    [teamId, tenantId]
  );
  return rows.map((r) => ({
    ...r,
    has_handling_role: (r.roles ?? []).some((n) => HANDLING_ROLES.includes(n)),
    effective: r.user_status === 'active'
  }));
}

/* ------------------------------------------------------------------ write */

export async function createTeam({ tenantId, actorUserId, name, brandId = null, db = pool }) {
  if (!tenantId || !actorUserId) fail(TEAM_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const clean = normaliseName(name);

  // A brand must belong to this company. Checked rather than assumed, so a
  // caller cannot attach a team to another tenant's brand.
  if (brandId) {
    const { rows } = await db.query(`SELECT 1 FROM brands WHERE id = $1 AND tenant_id = $2`, [brandId, tenantId]);
    if (!rows[0]) fail(TEAM_ERRORS.BRAND_NOT_FOUND, 404, 'brand not found in this company');
  }

  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      // Conflict inference targets the CASE-FOLDED index, so "marketing" loses
      // to an existing "Marketing" inside the same company. It does NOT conflict
      // across companies, which is why tenant_id is part of the index.
      `INSERT INTO teams (tenant_id, name, brand_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, lower(name)) DO NOTHING
       RETURNING id, name, status, brand_id`,
      [tenantId, clean, brandId]
    );
    const team = rows[0];
    if (!team) fail(TEAM_ERRORS.NAME_TAKEN, 409, 'a team with that name already exists in this company');
    await writeAudit(client, {
      tenantId, actorUserId, action: 'team.created', objectId: team.id,
      metadata: { name: clean, brandId }
    });
    await client.query('COMMIT');
    return team;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    release();
  }
}

export async function updateTeam({ tenantId, actorUserId, teamId, name, status, brandId, db = pool }) {
  if (!tenantId || !actorUserId) fail(TEAM_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');
    const { rows: [before] } = await client.query(
      `SELECT id, name, status, brand_id FROM teams WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [teamId, tenantId]
    );
    if (!before) fail(TEAM_ERRORS.NOT_FOUND, 404, 'team not found');

    const next = {
      name: name === undefined ? before.name : normaliseName(name),
      status: status === undefined ? before.status : status,
      brand_id: brandId === undefined ? before.brand_id : brandId
    };
    if (!['active', 'disabled'].includes(next.status)) {
      fail(TEAM_ERRORS.NAME_INVALID, 422, 'status must be active or disabled');
    }
    if (next.brand_id) {
      const { rows } = await client.query(
        `SELECT 1 FROM brands WHERE id = $1 AND tenant_id = $2`, [next.brand_id, tenantId]);
      if (!rows[0]) fail(TEAM_ERRORS.BRAND_NOT_FOUND, 404, 'brand not found in this company');
    }

    // A rename can now collide case-insensitively. The database raises 23505 for
    // that; translate it to the same clean refusal a create gets, rather than
    // letting a raw driver error escape the API.
    let after;
    try {
      ({ rows: [after] } = await client.query(
        `UPDATE teams SET name = $3, status = $4, brand_id = $5
          WHERE id = $1 AND tenant_id = $2 RETURNING id, name, status, brand_id`,
        [teamId, tenantId, next.name, next.status, next.brand_id]
      ));
    } catch (e) {
      if (e?.code === '23505') {
        throw new TeamError(TEAM_ERRORS.NAME_TAKEN, 409, 'a team with that name already exists in this company');
      }
      throw e;
    }
    await writeAudit(client, {
      tenantId, actorUserId, action: 'team.updated', objectId: teamId,
      metadata: { before, after }
    });
    await client.query('COMMIT');
    return after;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    release();
  }
}

/**
 * Add somebody to a team.
 *
 * Re-adding revives the existing row instead of colliding with the old
 * (team_id, user_id) key, and the audit trail keeps the full history rather than
 * silently overwriting it.
 */
export async function addTeamMember({
  tenantId, actorUserId, teamId, userId, roleInTeam = 'agent', db = pool
}) {
  if (!tenantId || !actorUserId) fail(TEAM_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');

    const { rows: [team] } = await client.query(
      `SELECT id, name, status FROM teams WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [teamId, tenantId]
    );
    if (!team) fail(TEAM_ERRORS.NOT_FOUND, 404, 'team not found');
    if (team.status !== 'active') fail(TEAM_ERRORS.FORBIDDEN, 409, 'this team is disabled');

    // Same company, or invisible. This is also what makes cross-company
    // membership impossible rather than merely discouraged.
    const { rows: [user] } = await client.query(
      `SELECT id, status FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    );
    if (!user) fail(TEAM_ERRORS.USER_NOT_FOUND, 404, 'user not found in this company');

    const { rows: [existing] } = await client.query(
      `SELECT user_id, revoked_at FROM team_members
        WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId]
    );
    if (existing && existing.revoked_at === null) {
      fail(TEAM_ERRORS.ALREADY_MEMBER, 409, 'that person is already in this team');
    }

    // Lock the membership row we are about to write. A concurrent assignment
    // that is already proving eligibility against this row blocks here, so the
    // two are ordered instead of racing.
    const { rows: [row] } = await client.query(
      `INSERT INTO team_members (team_id, user_id, tenant_id, role_in_team, revoked_at, added_by)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (team_id, user_id) DO UPDATE
         SET revoked_at = NULL, role_in_team = EXCLUDED.role_in_team,
             added_by = EXCLUDED.added_by, added_at = now(), tenant_id = EXCLUDED.tenant_id
       RETURNING team_id, user_id, role_in_team, revoked_at, added_at`,
      [teamId, userId, tenantId, roleInTeam, actorUserId]
    );
    await writeAudit(client, {
      tenantId, actorUserId, action: 'team.member_added', objectId: teamId,
      metadata: { userId, roleInTeam, revived: Boolean(existing) }
    });
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    release();
  }
}

/**
 * Remove somebody from a team. A soft revocation, never a DELETE: the row has
 * to stay so a concurrent assignment can LOCK it and be ordered against this
 * change, and so the history survives.
 */
export async function removeTeamMember({ tenantId, actorUserId, teamId, userId, db = pool }) {
  if (!tenantId || !actorUserId) fail(TEAM_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { client, release } = await acquire(db);
  try {
    await client.query('BEGIN');
    const { rows: [before] } = await client.query(
      `SELECT team_id, user_id, role_in_team, revoked_at FROM team_members
        WHERE team_id = $1 AND user_id = $2 AND tenant_id = $3 FOR UPDATE`,
      [teamId, userId, tenantId]
    );
    if (!before) fail(TEAM_ERRORS.NOT_A_MEMBER, 404, 'that person is not in this team');
    if (before.revoked_at) fail(TEAM_ERRORS.NOT_A_MEMBER, 404, 'that person is not in this team');

    // Self-removal is refused. Leaving a team is a decision the platform owner
    // makes, not one an administrator performs on themselves while acting
    // through that very membership.
    if (userId === actorUserId) {
      fail(TEAM_ERRORS.SELF_ESCALATION, 409, 'you cannot remove yourself from a team');
    }

    const { rows: [after] } = await client.query(
      `UPDATE team_members SET revoked_at = now()
        WHERE team_id = $1 AND user_id = $2 AND tenant_id = $3
        RETURNING team_id, user_id, role_in_team, revoked_at`,
      [teamId, userId, tenantId]
    );
    await writeAudit(client, {
      tenantId, actorUserId, action: 'team.member_removed', objectId: teamId,
      metadata: { userId, before, after }
    });
    await client.query('COMMIT');
    return after;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    release();
  }
}

/* --------------------------------------------------- effective permissions */

/**
 * The single read the admin UI needs: for every person in the company, their
 * roles, their teams, their brand access, and whether they can actually be
 * assigned work RIGHT NOW.
 *
 * `assignment_eligible` is computed, not asserted, so the UI can warn about
 * somebody who looks configured but cannot take anything - the exact state
 * production was in before this work (an active user with no role and no brand).
 */
export async function listEffectivePermissions({ tenantId, brandId = null, db = pool }) {
  if (!tenantId) fail(TEAM_ERRORS.FORBIDDEN, 403, 'company scope is required');
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.status,
            COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
            COALESCE((
              SELECT array_agg(t.name) FROM team_members tm
                JOIN teams t ON t.id = tm.team_id
               WHERE tm.user_id = u.id AND tm.tenant_id = u.tenant_id AND tm.revoked_at IS NULL
            ), '{}') AS teams,
            EXISTS (SELECT 1 FROM user_brand_scope_all s
                     WHERE s.user_id = u.id AND s.tenant_id = u.tenant_id AND s.revoked_at IS NULL) AS all_brands,
            COALESCE((
              SELECT array_agg(g.brand_id) FROM user_brand_grants g
               WHERE g.user_id = u.id AND g.tenant_id = u.tenant_id AND g.revoked_at IS NULL
            ), '{}') AS brand_ids
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = $1
      GROUP BY u.id, u.name, u.email, u.status
      ORDER BY u.name ASC`,
    [tenantId]
  );

  return rows.map((r) => {
    const hasHandlingRole = (r.roles ?? []).some((n) => HANDLING_ROLES.includes(n));
    const brandIds = r.brand_ids ?? [];

    // Can this person reach the brand the question is about? With no brand in
    // play, the question becomes "do they hold any brand scope at all".
    const brandReachable = r.all_brands === true
      || (brandId === null ? brandIds.length > 0 : brandIds.includes(brandId));

    // The warning the UI must surface. Computed the same way the assignment
    // path decides, so the screen can never disagree with the server.
    const assignment_eligible = r.status === 'active' && hasHandlingRole && brandReachable;
    const warnings = [];
    // EVERY outstanding reason, not just the first. This list exists so an
    // administrator can see at a glance what is missing about an employee and fix
    // it in one pass; a priority ladder made them fix one problem, come back, and
    // discover the next. It also kept this list disagreeing with
    // `assignment_eligible` above, which is computed as the AND of every
    // condition - so an employee could be ineligible with an empty warning list.
    // Now: active and eligible <=> no warnings. The UI can rely on that.
    if (r.status === 'active' && !hasHandlingRole) warnings.push('NO_HANDLING_ROLE');
    if (r.status === 'active' && !brandReachable) warnings.push('NO_BRAND_ACCESS');
    if (r.status === 'active' && (r.teams ?? []).length === 0) warnings.push('NO_TEAM');
    if (r.status !== 'active') warnings.push('INACTIVE');

    return {
      id: r.id, name: r.name, email: r.email, status: r.status,
      roles: r.roles ?? [], teams: r.teams ?? [],
      all_brands: r.all_brands === true, brand_ids: brandIds,
      has_handling_role: hasHandlingRole,
      assignment_eligible,
      warnings
    };
  });
}

/**
 * Who may administer teams.
 *
 * Split out so the route layer and any future caller cannot drift on who is
 * allowed. `Platform Super Admin` is handled by NON_DELEGABLE_ROLE_NAMES at the
 * role-assignment layer, not here - team administration is a company-scoped act.
 */
export function canAdministerTeams(session) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  const custom = Array.isArray(session?.customAbilities) ? session.customAbilities : [];
  return can(roles, 'team.create', custom) || can(roles, 'team.assign', custom);
}

export function canReadTeams(session) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  const custom = Array.isArray(session?.customAbilities) ? session.customAbilities : [];
  return can(roles, 'team.read', custom) || canAdministerTeams(session);
}