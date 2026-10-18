/**
 * AI-driven intelligent routing — rule resolution and safe auto-assignment.
 *
 * WHAT THIS IS
 * ------------
 * When the AI detects a situation that needs a person (a supplier enquiry, a
 * photography request, a complaint, an explicit request for a human), this
 * decides WHICH TEAM should take it, and then WHICH MEMBER of that team is
 * actually eligible right now.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a second assignment system. It reuses the existing, audited
 * `assignConversation` transition and the existing brand-access rules. It never
 * writes `conversations.assigned_user_id` directly and never grants anybody
 * access to anything.
 *
 * THE THREE MODES
 * ---------------
 *   off      - default. `maybeAutoRoute` returns immediately and issues no
 *              query at all. Production behaviour is bit-for-bit unchanged.
 *   dry_run  - evaluates rules and picks a candidate, then returns a PLAN.
 *              It performs SELECTs only: no state change, no assignment, no
 *              customer message, and no audit row.
 *   live     - performs the assignment through the normal transition, with the
 *              same brand-access and eligibility checks, plus an audit row.
 *
 * The safe direction is deliberate: a misfiring rule can waste an employee's
 * attention, but `live` can never escalate a company's privileges, because
 * eligibility is re-proven inside the write transaction and a rule can only
 * ever name a TEAM, never a person.
 */

import { pool } from '../db/pg.js';
import { assignConversation, HANDLING_ROLES, CONVERSATION_STATES } from './handoff.js';
// `assignConversation` proves only tenant + active + handling role. The brand
// half of eligibility is asserted separately by `assertAssigneeBrandAccess`,
// which humanOperations exposes for exactly this reuse. Imported from there
// rather than reimplemented: one definition, one set of lock semantics, and no
// chance of the two drifting apart.
import { assertAssigneeBrandAccess, withTransaction } from './humanOperations.js';

/** Ordered so a numeric compare is never required. */
export const ROUTING_MODES = Object.freeze({
  OFF: 'off',
  DRY_RUN: 'dry_run',
  LIVE: 'live'
});

export const ROUTING_REASONS = Object.freeze({
  DISABLED: 'routing_disabled',
  NO_RULE: 'no_matching_rule',
  NO_TEAM_MEMBERS: 'team_has_no_members',
  NO_ELIGIBLE_EMPLOYEE: 'no_eligible_employee',
  CONVERSATION_NOT_QUEUED: 'conversation_not_assignable',
  ALREADY_ASSIGNED: 'conversation_already_assigned',
  ASSIGNMENT_REFUSED: 'assignment_refused'
});

/**
 * Current mode. Reads the environment on every call rather than caching at
 * import time, so a flag flip does not require a restart to be observed and so
 * tests can change it without re-importing the module.
 *
 * Anything unrecognised is treated as OFF. A typo in the flag can never turn
 * live routing on by accident.
 */
export function routingMode(env = process.env) {
  const raw = String(env.AI_ROUTING_MODE ?? '').trim().toLowerCase();
  if (raw === ROUTING_MODES.LIVE) return ROUTING_MODES.LIVE;
  if (raw === ROUTING_MODES.DRY_RUN) return ROUTING_MODES.DRY_RUN;
  return ROUTING_MODES.OFF;
}

/** A mode that is allowed to write. Used as the single gate on the write path. */
export function routingCanWrite(mode = routingMode()) {
  return mode === ROUTING_MODES.LIVE;
}

/* ------------------------------------------------------------------ rules */

/**
 * Pick the single rule that governs this conversation.
 *
 * DETERMINISM. Two rules can both match. The order is fully specified and
 * evaluated by the database:
 *   1. a rule scoped to THIS brand beats a company-wide rule,
 *   2. then the higher priority (lower number) wins,
 *   3. then rule_key ascending as a final tie-break.
 * Step 3 means the winner never depends on physical row order, so the same
 * inputs always produce the same decision.
 *
 * Company-wide rules are included through `brand_id = $3 OR brand_id IS NULL`
 * rather than a UNION, so the comparison happens inside one index scan.
 */
export async function resolveRoutingRule({ tenantId, brandId = null, detection, db }) {
  if (!tenantId || !detection?.kind) return { rule: null, reason: ROUTING_REASONS.NO_RULE };
  const executor = db ?? pool;

  const { rows } = await executor.query(
    `SELECT id, rule_key, priority, detection_kind, detection_value,
            target_team_id, brand_id, conditions
       FROM ai_routing_rules
      WHERE tenant_id = $1
        AND enabled
        AND (brand_id = $2 OR brand_id IS NULL)
        AND detection_kind = $3
        AND (
              detection_value IS NULL
           OR detection_value = ''
           OR detection_value = $4
        )
      ORDER BY (brand_id IS NULL) ASC, priority ASC, rule_key ASC
      LIMIT 1`,
    [tenantId, brandId, detection.kind, detection.value ?? null]
  );

  return rows[0]
    ? { rule: rows[0], reason: null }
    : { rule: null, reason: ROUTING_REASONS.NO_RULE };
}

/* ------------------------------------------------------- employee selection */

/**
 * Choose ONE eligible member of a team.
 *
 * ELIGIBILITY, all proven in SQL and all required. These are the SAME
 * conditions `performAssign` enforces, so the engine can never nominate
 * somebody the real assignment path would then refuse:
 *   1. an active member of the SAME company holding a HANDLING role
 *      (`HANDLING_ROLES`, imported rather than re-listed, so the two can never
 *      drift apart),
 *   2. able to reach THIS brand — either an all-brands delegation or a live
 *      per-brand grant, exactly as `assertAssigneeBrandAccess` requires,
 *   3. a company-wide (NULL brand) conversation needs the all-brands
 *      delegation, matching the rest of the product.
 *
 * NO LOCK IS TAKEN HERE, AND THAT IS CORRECT. This is a candidate shortlist,
 * not the decision. Locking rows here would be wrong twice over: the pool call
 * is outside any transaction (a row lock would be released immediately, giving
 * the *appearance* of safety), and it would serialise a read that is allowed to
 * be stale.
 *
 * The guarantee lives in `maybeAutoRoute`'s write path instead: selection and
 * assignment run in ONE transaction, and `assertAssigneeBrandAccess` reads both
 * grant tables `FOR UPDATE` immediately before the mutation. A stale pick here
 * is caught there - a grant revoked in the meantime is refused, and a concurrent
 * revoke blocks on that lock until the assignment commits.
 *
 * WHAT IS *NOT* LOCKED, stated honestly: `users.status`, `user_roles` and
 * `team_members` are re-read inside the write transaction but without a row
 * lock. `isEligibleAssignee` re-checks active + handling role as its own
 * statement, so a deactivation or role removal committed BEFORE that statement
 * is caught; one committed after it is not, and the assignment lands. Closing
 * that window means locking those rows too, or running the check at a stronger
 * isolation level - tracked before AI_ROUTING_MODE can be set to live. It does
 * not affect off or dry_run.
 *
 * LOAD BALANCING is best-effort and deterministic: fewest open assignments
 * first, then role_in_team (a team lead is preferred over a newcomer), then
 * user_id. Ties never depend on row order.
 */
export async function selectEligibleAssignee({ tenantId, brandId = null, teamId, db }) {
  if (!tenantId || !teamId) return { userId: null, reason: ROUTING_REASONS.NO_ELIGIBLE_EMPLOYEE };
  const executor = db ?? pool;

  const { rows } = await executor.query(
    `WITH candidates AS (
        SELECT u.id AS user_id,
               tm.role_in_team,
               (SELECT count(*) FROM conversations c
                 WHERE c.assigned_user_id = u.id
                   AND c.state = ANY($4::text[])) AS open_load
          FROM teams t
          JOIN team_members tm ON tm.team_id = t.id
          JOIN users u ON u.id = tm.user_id
          -- Same handling-role requirement the real assignment path enforces,
          -- so routing never nominates somebody it would then have to refuse.
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id AND r.name = ANY($5::text[])
          LEFT JOIN user_brand_scope_all s
                 ON s.user_id = u.id AND s.tenant_id = t.tenant_id AND s.revoked_at IS NULL
          LEFT JOIN user_brand_grants g
                 ON g.user_id = u.id AND g.tenant_id = t.tenant_id AND g.revoked_at IS NULL
         WHERE t.id = $3 AND t.tenant_id = $1
           AND u.tenant_id = $1 AND u.status = 'active'
           AND (
                 ($2::uuid IS NULL AND s.user_id IS NOT NULL)
              OR ($2::uuid IS NOT NULL AND (s.user_id IS NOT NULL OR g.brand_id = $2))
           )
         ORDER BY open_load ASC, tm.role_in_team ASC, u.id ASC
         LIMIT 1
     )
     SELECT user_id, role_in_team, open_load FROM candidates`,
    [tenantId, brandId, teamId, [
      CONVERSATION_STATES.ASSIGNED,
      CONVERSATION_STATES.HUMAN_ACTIVE
    ], [...HANDLING_ROLES]]
  );

  if (!rows[0]) return { userId: null, reason: ROUTING_REASONS.NO_ELIGIBLE_EMPLOYEE };
  return {
    userId: rows[0].user_id,
    roleInTeam: rows[0].role_in_team,
    openLoad: Number(rows[0].open_load),
    reason: null
  };
}

/* ------------------------------------------------------------- the planner */

/**
 * Decide what WOULD happen. SELECTs only — this is what dry-run returns and it
 * is safe to call on live traffic because it cannot write anything.
 *
 * The returned `applied: false` is not a label, it is the only thing the
 * caller is allowed to act on in dry-run.
 */
export async function planAutoAssignment({ tenantId, conversationId, detection, db }) {
  if (!tenantId || !conversationId) {
    return { applied: false, reason: ROUTING_REASONS.CONVERSATION_NOT_QUEUED, rule: null, userId: null };
  }
  const executor = db ?? pool;

  // Conversation facts, read first so an unassignable conversation never even
  // consults the rules. NOTE: `conversations` has no brand column — brand scope
  // lives on the CHANNEL, which is how the rest of the product reads it too.
  const { rows: [conv] } = await executor.query(
    `SELECT c.state, c.assigned_user_id, c.channel_id
       FROM conversations c
      WHERE c.id = $2 AND c.tenant_id = $1`,
    [tenantId, conversationId]
  );
  if (!conv) {
    return { applied: false, reason: ROUTING_REASONS.CONVERSATION_NOT_QUEUED, rule: null, userId: null };
  }
  if (conv.state === CONVERSATION_STATES.RESOLVED) {
    return { applied: false, reason: ROUTING_REASONS.CONVERSATION_NOT_QUEUED, rule: null, userId: null };
  }
  if (conv.assigned_user_id) {
    return { applied: false, reason: ROUTING_REASONS.ALREADY_ASSIGNED, rule: null, userId: conv.assigned_user_id };
  }
  if (conv.state !== CONVERSATION_STATES.QUEUED) {
    return { applied: false, reason: ROUTING_REASONS.CONVERSATION_NOT_QUEUED, rule: null, userId: null };
  }

  // Brand scope comes from the channel. A company-wide channel has brand_id
  // NULL and is therefore visible only to an all-brands delegate.
  const { rows: [chan] } = await executor.query(
    `SELECT brand_id FROM channels WHERE id = $1 AND tenant_id = $2`,
    [conv.channel_id, tenantId]
  );
  const brandId = chan?.brand_id ?? null;

  const { rule, reason: ruleReason } = await resolveRoutingRule({
    tenantId, brandId, detection, db: executor
  });
  if (!rule) {
    return { applied: false, reason: ruleReason, rule: null, userId: null, brandId };
  }

  const { rows: [teamSize] } = await executor.query(
    `SELECT count(*)::int AS n FROM team_members WHERE team_id = $1`, [rule.target_team_id]
  );
  if (!teamSize?.n) {
    return { applied: false, reason: ROUTING_REASONS.NO_TEAM_MEMBERS, rule, userId: null, brandId };
  }

  const pick = await selectEligibleAssignee({
    tenantId, brandId, teamId: rule.target_team_id, db: executor
  });

  return {
    applied: false,
    reason: pick.userId ? null : pick.reason,
    rule,
    brandId,
    userId: pick.userId,
    roleInTeam: pick.roleInTeam ?? null,
    openLoad: pick.openLoad ?? null
  };
}

/* ------------------------------------------------------------ the entry point */

/**
 * The single call site. Injected into the webhook so routing can never run
 * without passing through this gate.
 *
 * `off` returns before touching the database, so the flag is provably inert
 * rather than merely intended to be.
 */
export async function maybeAutoRoute({ tenantId, conversationId, detection, env = process.env, db } = {}) {
  const mode = routingMode(env);

  if (mode === ROUTING_MODES.OFF) {
    return { mode, applied: false, reason: ROUTING_REASONS.DISABLED, rule: null, userId: null };
  }

  const plan = await planAutoAssignment({ tenantId, conversationId, detection, db });

  if (mode === ROUTING_MODES.DRY_RUN) {
    return { mode, ...plan };
  }

  // ---- live -------------------------------------------------------------
  // Only a CLEAN plan may reach the write. A plan that carries a reason is
  // already a refusal — notably ALREADY_ASSIGNED, which still reports the
  // current assignee as `userId`. Gating on `userId` alone would let a replayed
  // event re-attempt the assignment and be thrown out by the real transition.
  if (plan.reason || !plan.userId) {
    return { mode, ...plan };
  }

  try {
    // SELECTION AND ASSIGNMENT ARE ONE TRANSACTION.
    //
    // Selecting on one connection and assigning on another left a window in
    // which a brand grant could be revoked in between: the selection had already
    // seen it, and `assignConversation` does not check brand access at all, so
    // the assignment still went through. Inside a transaction that window is
    // closed, because `assertAssigneeBrandAccess` reads both grant tables
    // `FOR UPDATE`. A concurrent revocation is an UPDATE of exactly those rows,
    // so it now blocks until this commits: either we saw the grant and lock it
    // first, or the revoke won and this read sees `revoked_at` and refuses.
    // Whichever way the race lands, a conversation is never assigned to
    // somebody who lacks brand access at the moment of the commit.
    const result = await withTransaction(db ?? pool, async (client) => {
      await assertAssigneeBrandAccess(client, {
        tenantId,
        userId: plan.userId,
        brandId: plan.brandId
      });
      return assignConversation(
        {
          tenantId,
          conversationId,
          userId: plan.userId,
          teamId: plan.rule.target_team_id,
          reason: `ai_routing:${plan.rule.rule_key}`
        },
        { db: client, actorUserId: null }
      );
    });
    return { mode, ...plan, applied: true, state: result.state, action: result.action };
  } catch (e) {
    // A refused assignment must NEVER be retried silently and must never be
    // reported as a success. The conversation stays queued for a human.
    return {
      mode, applied: false, reason: ROUTING_REASONS.ASSIGNMENT_REFUSED,
      rule: plan.rule, userId: null, errorCode: e?.code ?? null
    };
  }
}