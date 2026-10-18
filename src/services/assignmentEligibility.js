/**
 * The single definition of "may this employee be assigned this conversation",
 * and the locks that make it true at the moment of the commit.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Assignment eligibility has two halves that live in different places:
 *   - HANDLING eligibility: active employee, same company, holds a handling role
 *   - BRAND eligibility:   can reach this conversation's brand
 * The human path asserted both. The AI path only got the first one, because
 * `assignConversation` proves handling eligibility and the brand half lived in a
 * separate function nobody on that path called. That gap is exactly how a
 * conversation ended up assigned to somebody whose brand access had been
 * revoked in the meantime.
 *
 * Both halves now live here, so every path that assigns shares one contract.
 *
 * THE LOCKS, AND WHY ORDER MATTERS
 * --------------------------------
 * A check inside a transaction is NOT by itself concurrency safety: under READ
 * COMMITTED each statement sees a fresh snapshot, so a change committed after
 * our SELECT is invisible to it. Every row this module reads for the decision is
 * therefore locked `FOR UPDATE` first.
 *
 * A concurrent change is always an INSERT/UPDATE/DELETE of exactly the rows we
 * locked - a revocation rewrites `revoked_at`, a deactivation rewrites
 * `status`, a role removal deletes from `user_roles`. All of those now block
 * until we commit. So exactly one of two things happens:
 *
 *   we win  - we read a live row, hold its lock, and the change waits. At the
 *             instant of our commit the permission genuinely existed.
 *   they win - they commit first, we block, then we read their row and refuse.
 *
 * There is no third outcome in which we commit against a permission that had
 * already been taken away.
 *
 * LOCK ORDER IS GLOBAL AND FIXED: users -> user_roles -> roles ->
 * brand grants -> team membership. Two transactions that lock overlapping rows
 * in the same order can never deadlock, and the human path (grants only) is a
 * suffix of it, so it cannot form a cycle with this path either.
 */

import { pool } from '../db/pg.js';
import { HANDLING_ROLES } from './handoff.js';

export const ELIGIBILITY_ERRORS = Object.freeze({
  MISSING_CONTEXT: 'ASSIGNEE_CONTEXT_REQUIRED',
  NOT_ELIGIBLE: 'ASSIGNEE_NOT_ELIGIBLE',
  NO_BRAND_ACCESS: 'ASSIGNEE_NO_BRAND_ACCESS',
  NOT_IN_TEAM: 'ASSIGNEE_NOT_IN_TEAM'
});

export class EligibilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EligibilityError';
    this.code = code;
  }
}

/**
 * Lock and prove the HANDLING half: active, same company, holds a handling role.
 *
 * Users, their role rows and the role rows are all locked, so a concurrent
 * deactivation, role change or deletion is ordered against this decision rather
 * than racing past it.
 *
 * @returns {Promise<{userId: string, roleNames: string[]}>}
 * @throws {EligibilityError} NOT_ELIGIBLE
 */
export async function assertHandlingEligibility(client, { tenantId, userId }) {
  if (!tenantId || !userId) {
    throw new EligibilityError(ELIGIBILITY_ERRORS.MISSING_CONTEXT,
      'tenant and user are required to prove assignment eligibility');
  }

  // 1. The user row itself - this is what `status = 'inactive'` rewrites.
  const { rows: users } = await client.query(
    `SELECT id, status FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [userId, tenantId]
  );
  const member = users[0];
  if (!member || member.status !== 'active') {
    throw new EligibilityError(ELIGIBILITY_ERRORS.NOT_ELIGIBLE,
      'the target user cannot be assigned this conversation');
  }

  // 2. The membership rows and the role rows. A role removal DELETEs from
  //    user_roles, so locking those rows is what orders it against us.
  const { rows: grants } = await client.query(
    `SELECT r.name
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND r.name = ANY($2::text[])
      FOR UPDATE OF ur, r`,
    [userId, [...HANDLING_ROLES]]
  );
  if (!grants.length) {
    throw new EligibilityError(ELIGIBILITY_ERRORS.NOT_ELIGIBLE,
      'the target user cannot be assigned this conversation');
  }

  return { userId, roleNames: grants.map((g) => g.name) };
}

/**
 * Lock and prove the BRAND half.
 *
 * Unchanged in behaviour from the original humanOperations implementation, and
 * deliberately so: the error is uniform, so this endpoint can never be used to
 * enumerate users, discover which brand somebody lacks, or tell "no such user"
 * apart from "wrong company".
 *
 * @throws {EligibilityError} NO_BRAND_ACCESS
 */
export async function assertBrandEligibility(client, { tenantId, userId, brandId }) {
  if (!tenantId || !userId) {
    throw new EligibilityError(ELIGIBILITY_ERRORS.MISSING_CONTEXT,
      'tenant and user are required to prove brand access');
  }

  // Active membership is part of THIS function's contract, exactly as it was
  // before the split. Dropping it here would silently widen what the human
  // assignment path accepts, because that path reaches brand eligibility
  // through this door.
  const { rows: members } = await client.query(
    `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
    [userId, tenantId]
  );
  if (!members[0]) {
    throw new EligibilityError(ELIGIBILITY_ERRORS.NOT_ELIGIBLE,
      'the target user cannot be assigned this conversation');
  }

  // A company-wide channel is reachable only through an all-brands delegation.
  if (!brandId) {
    const { rows } = await client.query(
      `SELECT 1 FROM user_brand_scope_all
        WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL
        FOR UPDATE`,
      [userId, tenantId]
    );
    if (!rows[0]) {
      throw new EligibilityError(ELIGIBILITY_ERRORS.NO_BRAND_ACCESS,
        'the target user cannot be assigned this conversation');
    }
    return true;
  }

  const { rows: allBrands } = await client.query(
    `SELECT 1 FROM user_brand_scope_all
      WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL
      FOR UPDATE`,
    [userId, tenantId]
  );
  if (allBrands[0]) return true;

  const { rows: perBrand } = await client.query(
    `SELECT 1 FROM user_brand_grants
      WHERE user_id = $1 AND tenant_id = $2 AND brand_id = $3 AND revoked_at IS NULL
      FOR UPDATE`,
    [userId, tenantId, brandId]
  );
  if (!perBrand[0]) {
    throw new EligibilityError(ELIGIBILITY_ERRORS.NO_BRAND_ACCESS,
      'the target user cannot be assigned this conversation');
  }
  return true;
}

/**
 * Lock the team-membership row.
 *
 * Separate from the other two because membership is a ROUTING concern, not a
 * general assignment rule: a Supervisor may legitimately hand work to somebody
 * outside any team. The AI routing path opts in by passing a teamId, so a
 * membership revoked mid-assignment is ordered against the decision instead of
 * slipping through after the shortlist was built.
 *
 * @throws {EligibilityError} NOT_IN_TEAM
 */
export async function assertTeamMembership(client, { tenantId, teamId, userId }) {
  if (!teamId) return true;                       // caller did not opt in
  const { rows } = await client.query(
    `SELECT 1 FROM team_members
      WHERE team_id = $1 AND user_id = $2
        AND tenant_id = $3
        AND (revoked_at IS NULL OR revoked_at > now())
      FOR UPDATE`,
    [teamId, userId, tenantId]
  );
  if (!rows[0]) {
    throw new EligibilityError(ELIGIBILITY_ERRORS.NOT_IN_TEAM,
      'the target user is no longer a member of that team');
  }
  return true;
}

/**
 * The full contract, in the one lock order, for any path that assigns.
 *
 * Call this INSIDE the transaction that performs the write, immediately before
 * it. Calling it outside buys nothing.
 */
export async function assertAssignmentEligible(client, { tenantId, userId, brandId = null, teamId = null }) {
  const handling = await assertHandlingEligibility(client, { tenantId, userId });
  await assertBrandEligibility(client, { tenantId, userId, brandId });
  await assertTeamMembership(client, { tenantId, userId, teamId });
  return handling;
}

/**
 * Same contract, opening and committing its own transaction.
 *
 * Provided so a caller that cannot supply a client still gets the locking
 * semantics rather than silently falling back to lock-free reads.
 */
export async function withEligibilityTransaction(pool_, fn) {
  const executor = pool_ ?? pool;
  const client = await executor.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    committed = true;
    return out;
  } finally {
    if (!committed) { try { await client.query('ROLLBACK'); } catch { /* gone */ } }
    client.release();
  }
}