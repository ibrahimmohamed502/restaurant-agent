/**
 * P0.3-A — Human Operations: claim / assign / unassign / resolve / resume-AI.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * `src/services/handoff.js` already implements the whole state machine, and it is
 * correct: every transition is guarded by `state = ANY(from)` inside a single
 * UPDATE, so the DATABASE decides the winner of a race. Nothing here re-implements
 * it, and nothing here duplicates `TRANSITIONS`.
 *
 * What handoff.js does NOT do is answer three questions that an HTTP caller must
 * have answered before any of it runs:
 *
 *   1. BRAND SCOPE. `handoff.js` locates a conversation by `id + tenant_id` ONLY.
 *      A Supervisor whose brand delegation covers brand A could therefore claim,
 *      assign, unassign or resolve a conversation belonging to brand B inside the
 *      same company. Tenant isolation alone is not enough for a multi-brand SaaS.
 *      `loadScopedConversation()` applies the R1 brand scope INSIDE the same
 *      transaction that performs the mutation, so an out-of-scope conversation is
 *      never selected and is reported as 404 — identical to "does not exist", so
 *      this is not an existence oracle.
 *
 *   2. ATOMICITY. The handoff functions issue three separate statements (state
 *      UPDATE, `assignments` INSERT, `escalations` sync) against `deps.db`. Pass
 *      them a transaction client and they become one atomic unit — the state can
 *      never move without its history row, and the audit row commits or rolls back
 *      with them.
 *
 *   3. RESUME-AI SAFETY. `handoff.js:resumeAi()` CLOSES every open escalation
 *      (`UPDATE escalations SET status='done' ... WHERE resolved_at IS NULL`).
 *      Exposed over HTTP as-is, it would let a single click silently discard an
 *      unresolved customer complaint or an unanswered "get me a human" request.
 *      `resumeAiOperation()` therefore refuses BEFORE calling it. See
 *      RESUME_AI_BLOCKERS below. There is deliberately NO override parameter: an
 *      override that discards unresolved escalations needs its own owner approval.
 *
 * AUDIT
 * -----
 * Every operation writes an `audit_logs` row through the transaction client, so
 * the audit record and the state change share one commit. `audit_logs.metadata`
 * carries previousState / newState / reason / brandId / brandName, which is what
 * makes the history explainable after the fact. No migration is required: the
 * columns already exist in `001_init.sql`.
 *
 * IDEMPOTENCY
 * -----------
 * These operations are safe under network retry WITHOUT an idempotency key,
 * because the state guard in `applyTransition` makes a duplicate attempt a
 * no-op conflict rather than a second effect. To avoid showing the operator an
 * error for an action that actually succeeded, each operation first checks
 * whether its POSTCONDITION already holds inside the same transaction and, if so,
 * returns the current state with `duplicate: true` instead of a 409.
 *
 * SIDE EFFECTS
 * ------------
 * None of these operations send anything. Not a Meta call, not a queue publish,
 * not a provider call. Moving a conversation between states is a bookkeeping
 * act; a customer-visible message is only ever produced by the P0.2 reply route
 * or the AI pipeline, both of which re-check state for themselves.
 */
import { pool } from '../db/pg.js';
import { can } from '../auth/abilities.js';
import { brandScopeSql } from '../api/v1/brandAccess.js';
import { humanReplyInFlight } from './manualReplies.js';
import {
  claimConversation,
  assignConversation,
  unassignConversation,
  resolveConversation,
  resumeAi,
  getConversationHandoffView,
  listAssignmentHistory,
  listEligibleMembers,
  CONVERSATION_STATES
} from './handoff.js';

/* ------------------------------------------------------------------ errors */

export const OPS_ERRORS = Object.freeze({
  FORBIDDEN: 'OPS_FORBIDDEN',
  NOT_FOUND: 'OPS_NOT_FOUND',
  VALIDATION: 'OPS_VALIDATION_FAILED',
  OPEN_ESCALATIONS: 'OPS_OPEN_ESCALATIONS',
  HUMAN_ENGAGED: 'OPS_HUMAN_ENGAGED',
  REPLY_IN_FLIGHT: 'OPS_REPLY_IN_FLIGHT',
  NOT_ASSIGNED: 'OPS_NOT_ASSIGNED',
  INTERNAL: 'OPS_INTERNAL'
});

export class OpsError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'OpsError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Reasons a Resume-AI request is refused. Surfaced to the UI, never guessed around. */
export const RESUME_AI_BLOCKERS = Object.freeze({
  OPEN_ESCALATIONS: 'open_escalations',
  HUMAN_ENGAGED: 'human_engaged',
  REPLY_IN_FLIGHT: 'reply_in_flight',
  NO_ABILITY: 'no_ability'
});

/* --------------------------------------------------------------- authority */

/**
 * The caller's authority, derived from the authenticated session ONLY.
 *
 * Mirrors `manualReplies.resolveReplyAuthority` deliberately: a missing or
 * malformed session yields every flag false, so the request fails closed rather
 * than defaulting to "permitted".
 *
 * Note the deliberate absence of any new ability. Every operation maps onto an
 * ability that ALREADY exists in `src/auth/abilities.js`, so this file grants
 * nothing implicitly and changes no delegation surface:
 *
 *   conversation.assign_self  -> claim          (Agent)
 *   conversation.assign       -> assign         (Supervisor, Company Admin)
 *   conversation.reassign     -> reassign       (Supervisor, Company Admin)
 *   conversation.unassign     -> unassign       (Supervisor, Company Admin)
 *   conversation.resolve      -> resolve anyone (Supervisor, Company Admin)
 *   conversation.resolve_own  -> resolve own    (Agent)
 *   conversation.resume_ai    -> resume AI      (Supervisor, Company Admin)
 *
 * `Platform Super Admin` holds NO conversation ability in that map, so platform
 * privilege can never reach a customer's conversations. P0.1 is untouched: this
 * file never reads a role name as an authorisation source, and never consults
 * `isPlatformSuperAdmin`.
 */
export function resolveOpsAuthority(session) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  const custom = Array.isArray(session?.customAbilities) ? session.customAbilities : [];
  const tenantWide = session?.brandIds === null && session?.allBrandsInCompany === true;
  return {
    tenantId: session?.tenantId ?? null,
    userId: session?.user?.id ?? null,
    brandIds: tenantWide ? null : (Array.isArray(session?.brandIds) ? session.brandIds : []),
    allBrandsInCompany: tenantWide,
    canClaim: can(roles, 'conversation.assign_self', custom),
    canAssign: can(roles, 'conversation.assign', custom),
    canReassign: can(roles, 'conversation.reassign', custom),
    canUnassign: can(roles, 'conversation.unassign', custom),
    canResolveAny: can(roles, 'conversation.resolve', custom),
    canResolveOwn: can(roles, 'conversation.resolve_own', custom),
    canResumeAi: can(roles, 'conversation.resume_ai', custom)
  };
}

/** A session must carry BOTH a tenant and a user; anything less is refused. */
function requireContext(authority) {
  if (!authority.tenantId || !authority.userId) {
    throw new OpsError(401, OPS_ERRORS.FORBIDDEN, 'an authenticated session is required');
  }
}

/** Normalise a free-text reason. Never throws on absence — it simply defaults. */
function normalizeReason(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const t = String(value).trim();
  if (!t) return fallback;
  return t.slice(0, 500);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/* ------------------------------------------------------------ transactions */

/**
 * Run `fn` inside one transaction, handing it the client.
 *
 * `handoff.js` threads `deps.db` through every statement it issues, so passing
 * this client makes its state UPDATE, its `assignments` INSERT, its
 * `escalations` sync and our audit row a single atomic unit. Any throw rolls the
 * whole thing back, which is what makes "the state can never move without its
 * history row" true rather than merely intended.
 */
async function withTransaction(db, fn) {
  const client = await db.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    }
    client.release();
  }
}

/** Audit row written ON the transaction client, so it shares the commit. */
async function writeAuditRow(client, { tenantId, actorUserId, action, objectId, ip, metadata }) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
     VALUES ($1, $2, $3, 'conversation', $4, $5, $6)`,
    [tenantId, actorUserId, action, objectId, ip ?? null, JSON.stringify(metadata ?? {})]
  );
}

/** A refusal is audited too — "who tried what and was stopped" is part of the record. */
async function writeDeniedRow(client, { tenantId, actorUserId, action, objectId, ip, metadata }) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
     VALUES ($1, $2, $3, 'conversation', $4, $5, $6)`,
    [tenantId, actorUserId, action, objectId, ip ?? null, JSON.stringify({ ...(metadata ?? {}), denied: true })]
  );
}

/* --------------------------------------------------------- scoped loading */

/**
 * Load a conversation the caller is ALLOWED to see, applying brand scope in SQL.
 *
 * Returns null for "not visible" and "does not exist" alike, so a caller cannot
 * probe for the existence of another brand's conversation.
 */
async function loadScopedConversation(client, { tenantId, conversationId, scope }) {
  const bs = brandScopeSql('ch', { tenantWideParam: 1, brandIdsParam: 2 });
  const { rows } = await client.query(
    `SELECT c.id, c.tenant_id, c.state, c.assigned_user_id, c.assigned_team_id,
            c.priority, c.resolved_at, c.channel_id,
            ch.provider AS channel_provider, ch.status AS channel_status, ch.brand_id,
            b.name AS brand_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN brands  b  ON b.id = ch.brand_id
      WHERE c.id = $3 AND c.tenant_id = $4 AND ${bs.sql}`,
    [...bs.params(scope), conversationId, tenantId]
  );
  return rows[0] ?? null;
}

/** Open escalations = rows with no resolved_at. Same definition the codebase uses. */
async function loadOpenEscalations(client, { tenantId, conversationId }) {
  const { rows } = await client.query(
    `SELECT id, category, reason, priority, status, created_at
       FROM escalations
      WHERE conversation_id = $1 AND tenant_id = $2 AND resolved_at IS NULL
      ORDER BY created_at ASC`,
    [conversationId, tenantId]
  );
  return rows;
}

/** A teamId from a request body must belong to the caller's own tenant. */
async function assertTeamInTenant(client, { tenantId, teamId }) {
  if (teamId === undefined || teamId === null || teamId === '') return null;
  if (!isUuid(teamId)) {
    throw new OpsError(422, OPS_ERRORS.VALIDATION, 'teamId must be a uuid');
  }
  const { rows } = await client.query(
    `SELECT id FROM teams WHERE id = $1 AND tenant_id = $2`,
    [teamId, tenantId]
  );
  if (!rows[0]) {
    throw new OpsError(422, OPS_ERRORS.VALIDATION, 'team not found in this company');
  }
  return teamId;
}

/**
 * Convert a handoff.js error into the shape the API returns.
 *
 * HandoffError already carries a status and a stable code, so its semantics are
 * preserved exactly. Anything unexpected becomes a generic 500 — a driver message
 * can carry connection strings, so internals are never echoed.
 */
function translate(err) {
  if (err instanceof OpsError) return err;
  if (err && typeof err.status === 'number' && typeof err.code === 'string') {
    return new OpsError(err.status, err.code, err.message);
  }
  return new OpsError(500, OPS_ERRORS.INTERNAL, 'unexpected error');
}

/* ------------------------------------------------------- shared audit meta */

/**
 * Audit metadata: what changed, why, and which brand/company it touched.
 *
 * "Company" here means the TENANT. There is no `companies` table and `brands` has
 * no `company_id` column in this schema — verified against production — so
 * `tenantId` is the company identifier, and inventing a `b.company_id` join would
 * have made every operation fail with `column b.company_id does not exist`.
 */
function auditMeta(conv, { fromState, toState, reason, extra = {} }) {
  return {
    previousState: fromState,
    newState: toState,
    reason: reason ?? null,
    tenantId: conv?.tenant_id ?? null,
    brandId: conv?.brand_id ?? null,
    brandName: conv?.brand_name ?? null,
    channelProvider: conv?.channel_provider ?? null,
    ...extra
  };
}

/** The shape every operation resolves with, so the UI has one contract. */
function operationResult(conv, { state, assignedUserId, duplicate = false, action, extra = {} }) {
  return {
    conversationId: conv.id,
    state,
    assignedUserId: assignedUserId ?? null,
    brandId: conv.brand_id ?? null,
    duplicate,
    action: action ?? null,
    ...extra
  };
}

/* ================================================================ claim === */

/**
 * CLAIM — QUEUED -> ASSIGNED, self-service.
 *
 * `handoff.claimConversation` guards on `state = 'QUEUED'` only, so two agents
 * claiming the same conversation cannot both win: the loser gets 409
 * HANDOFF_CONFLICT. This wrapper additionally returns success-with-`duplicate`
 * when the postcondition (assigned to me) already holds, so a retried request
 * does not surface as a failure for work that actually completed.
 */
export async function claimConversationOperation({ session, conversationId, body = {}, deps = {} }) {
  const db = deps.db ?? pool;
  const authority = resolveOpsAuthority(session);
  requireContext(authority);
  if (!isUuid(conversationId)) {
    throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');
  }
  if (!authority.canClaim) {
    throw new OpsError(403, OPS_ERRORS.FORBIDDEN, 'your role cannot claim conversations');
  }
  const reason = normalizeReason(body.reason, 'claimed');
  const scope = deps.scope ?? null;

  return withTransaction(db, async (client) => {
    const conv = await loadScopedConversation(client, {
      tenantId: authority.tenantId, conversationId, scope
    });
    if (!conv) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

    // Idempotent replay: I already own it.
    if (conv.state === CONVERSATION_STATES.ASSIGNED && conv.assigned_user_id === authority.userId) {
      await writeAuditRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.claim', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: conv.state, reason, extra: { duplicate: true } })
      });
      return operationResult(conv, {
        state: conv.state, assignedUserId: authority.userId, duplicate: true, action: 'assigned'
      });
    }

    const teamId = await assertTeamInTenant(client, { tenantId: authority.tenantId, teamId: body.teamId });

    let result;
    try {
      result = await claimConversation(
        {
          tenantId: authority.tenantId,
          conversationId,
          // Always the caller. A claim is self-service by definition, so a
          // userId from the request body could only ever widen access.
          userId: authority.userId,
          teamId,
          reason
        },
        { db: client, actorUserId: authority.userId }
      );
    } catch (e) {
      const t = translate(e);
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.claim.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: null, reason, extra: { code: t.code } })
      });
      throw t;
    }

    await writeAuditRow(client, {
      tenantId: authority.tenantId, actorUserId: authority.userId,
      action: 'conversation.claim', objectId: conversationId, ip: deps.ip ?? null,
      metadata: auditMeta(conv, {
        fromState: conv.state, toState: result.state, reason,
        extra: { assignedUserId: result.assignedUserId, previousAssignee: result.previousAssignee }
      })
    });

    return operationResult(conv, {
      state: result.state,
      assignedUserId: result.assignedUserId,
      duplicate: false,
      action: result.action
    });
  });
}

/* =============================================================== assign === */

/**
 * ASSIGN / REASSIGN — QUEUED | ASSIGNED -> ASSIGNED, supervisor operation.
 *
 * Reassigning away from an existing owner additionally requires
 * `conversation.reassign`, so a role that may place work but may not take it away
 * cannot quietly strip another agent's conversation.
 *
 * The assignee's OWN brand scope is reported (`assigneeCanSee`) but is NOT
 * enforced: blocking on it would be a policy decision about who may receive work,
 * which is not implied by the ability list. Assignment confers no data access by
 * itself — the assignee still has to pass the same brand scope on every read.
 */
export async function assignConversationOperation({ session, conversationId, body = {}, deps = {} }) {
  const db = deps.db ?? pool;
  const authority = resolveOpsAuthority(session);
  requireContext(authority);
  if (!isUuid(conversationId)) {
    throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');
  }
  if (!isUuid(body.userId)) {
    throw new OpsError(422, OPS_ERRORS.VALIDATION, 'userId is required and must be a uuid');
  }
  const reason = normalizeReason(body.reason, body.userId === authority.userId ? 'claimed' : 'assigned');
  const scope = deps.scope ?? null;

  return withTransaction(db, async (client) => {
    const conv = await loadScopedConversation(client, {
      tenantId: authority.tenantId, conversationId, scope
    });
    if (!conv) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

    const isReassign = Boolean(conv.assigned_user_id) && conv.assigned_user_id !== body.userId;
    if (!authority.canAssign) {
      throw new OpsError(403, OPS_ERRORS.FORBIDDEN, 'your role cannot assign conversations');
    }
    if (isReassign && !authority.canReassign) {
      throw new OpsError(403, OPS_ERRORS.FORBIDDEN, 'your role cannot reassign an owned conversation');
    }
    if (conv.state === CONVERSATION_STATES.RESOLVED) {
      throw new OpsError(409, 'HANDOFF_INVALID_TRANSITION', 'this conversation is closed');
    }

    // Idempotent replay: already sitting with the requested assignee.
    if (conv.state === CONVERSATION_STATES.ASSIGNED && conv.assigned_user_id === body.userId) {
      await writeAuditRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.assign', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: conv.state, reason, extra: { duplicate: true } })
      });
      return operationResult(conv, {
        state: conv.state, assignedUserId: body.userId, duplicate: true, action: conv.assigned_user_id ? 'reassigned' : 'assigned'
      });
    }

    const teamId = await assertTeamInTenant(client, { tenantId: authority.tenantId, teamId: body.teamId });
    const assigneeCanSee = await assigneeHasBrandAccess(client, {
      tenantId: authority.tenantId, userId: body.userId, brandId: conv.brand_id
    });

    let result;
    try {
      result = await assignConversation(
        { tenantId: authority.tenantId, conversationId, userId: body.userId, teamId, reason },
        { db: client, actorUserId: authority.userId }
      );
    } catch (e) {
      const t = translate(e);
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.assign.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: null, reason, extra: { targetUserId: body.userId, code: t.code } })
      });
      throw t;
    }

    await writeAuditRow(client, {
      tenantId: authority.tenantId, actorUserId: authority.userId,
      action: isReassign ? 'conversation.reassign' : 'conversation.assign',
      objectId: conversationId, ip: deps.ip ?? null,
      metadata: auditMeta(conv, {
        fromState: conv.state, toState: result.state, reason,
        extra: {
          assignedUserId: result.assignedUserId,
          previousAssignee: result.previousAssignee,
          assigneeCanSee
        }
      })
    });

    return operationResult(conv, {
      state: result.state,
      assignedUserId: result.assignedUserId,
      duplicate: false,
      action: result.action,
      extra: { assigneeCanSee }
    });
  });
}

/**
 * Does this assignee hold a brand grant that covers this conversation's brand?
 *
 * Advisory only. Returns true for a company-wide delegation row and for a
 * NULL-brand (company-wide) channel, matching how `brandScopeSql` treats them.
 */
async function assigneeHasBrandAccess(client, { tenantId, userId, brandId }) {
  if (!brandId) return true;
  const { rows } = await client.query(
    `SELECT 1
       FROM users u
      WHERE u.id = $1 AND u.tenant_id = $2 AND u.status = 'active'
        AND (
          EXISTS (SELECT 1 FROM user_brand_scope_all a
                   WHERE a.user_id = u.id AND a.tenant_id = u.tenant_id AND a.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM user_brand_grants g
                   WHERE g.user_id = u.id AND g.tenant_id = u.tenant_id AND g.revoked_at IS NULL
                     AND g.brand_id = $3)
        )
      LIMIT 1`,
    [userId, tenantId, brandId]
  );
  return rows.length > 0;
}

/* ============================================================= unassign === */

/**
 * UNASSIGN — ASSIGNED | HUMAN_ACTIVE -> QUEUED.
 *
 * Requires `conversation.unassign` (Supervisor / Company Admin) in every case.
 * Self-unassign is deliberately NOT enabled: Agent holds
 * `conversation.assign_self` but not `conversation.unassign`, and allowing an
 * agent to release their own work would grant a permission that is not in the
 * ability map. Granting it is a product decision, not an implementation detail.
 */
export async function unassignConversationOperation({ session, conversationId, body = {}, deps = {} }) {
  const db = deps.db ?? pool;
  const authority = resolveOpsAuthority(session);
  requireContext(authority);
  if (!isUuid(conversationId)) {
    throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');
  }
  if (!authority.canUnassign) {
    throw new OpsError(403, OPS_ERRORS.FORBIDDEN, 'your role cannot unassign conversations');
  }
  const reason = normalizeReason(body.reason, 'unassigned');
  const scope = deps.scope ?? null;

  return withTransaction(db, async (client) => {
    const conv = await loadScopedConversation(client, {
      tenantId: authority.tenantId, conversationId, scope
    });
    if (!conv) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

    // Idempotent replay: already unassigned and back in the queue.
    if (!conv.assigned_user_id && conv.state === CONVERSATION_STATES.QUEUED) {
      await writeAuditRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.unassign', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: conv.state, reason, extra: { duplicate: true } })
      });
      return operationResult(conv, { state: conv.state, assignedUserId: null, duplicate: true, action: 'unassigned' });
    }

    const previousAssignee = conv.assigned_user_id;
    let result;
    try {
      result = await unassignConversation(
        { tenantId: authority.tenantId, conversationId, reason },
        { db: client, actorUserId: authority.userId }
      );
    } catch (e) {
      const t = translate(e);
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.unassign.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: null, reason, extra: { code: t.code } })
      });
      throw t;
    }

    await writeAuditRow(client, {
      tenantId: authority.tenantId, actorUserId: authority.userId,
      action: 'conversation.unassign', objectId: conversationId, ip: deps.ip ?? null,
      metadata: auditMeta(conv, {
        fromState: conv.state, toState: result.state, reason, extra: { previousAssignee }
      })
    });

    return operationResult(conv, {
      state: result.state, assignedUserId: null, duplicate: false, action: 'unassigned',
      extra: { previousAssignee }
    });
  });
}

/* ============================================================== resolve === */

/**
 * RESOLVE — ASSIGNED | HUMAN_ACTIVE -> RESOLVED. The AI STAYS OFF.
 *
 * `conversation.resolve` may close any conversation in scope;
 * `conversation.resolve_own` (Agent) may close only one assigned to them.
 * Resolving never returns the conversation to the AI — that is a separate,
 * explicit, separately-audited operation.
 */
export async function resolveConversationOperation({ session, conversationId, body = {}, deps = {} }) {
  const db = deps.db ?? pool;
  const authority = resolveOpsAuthority(session);
  requireContext(authority);
  if (!isUuid(conversationId)) {
    throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');
  }
  if (!authority.canResolveAny && !authority.canResolveOwn) {
    throw new OpsError(403, OPS_ERRORS.FORBIDDEN, 'your role cannot resolve conversations');
  }
  const reason = normalizeReason(body.reason, 'resolved');
  const scope = deps.scope ?? null;

  return withTransaction(db, async (client) => {
    const conv = await loadScopedConversation(client, {
      tenantId: authority.tenantId, conversationId, scope
    });
    if (!conv) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

    // Idempotent replay: already closed.
    if (conv.state === CONVERSATION_STATES.RESOLVED) {
      await writeAuditRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.resolve', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: conv.state, reason, extra: { duplicate: true } })
      });
      return operationResult(conv, { state: conv.state, assignedUserId: conv.assigned_user_id, duplicate: true, action: 'resolved' });
    }

    if (!authority.canResolveAny && conv.assigned_user_id !== authority.userId) {
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.resolve.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: null, reason, extra: { code: 'NOT_ASSIGNEE' } })
      });
      throw new OpsError(403, OPS_ERRORS.NOT_ASSIGNED, 'only the assigned agent may resolve this conversation');
    }

    let result;
    try {
      result = await resolveConversation(
        { tenantId: authority.tenantId, conversationId },
        { db: client, actorUserId: authority.userId }
      );
    } catch (e) {
      const t = translate(e);
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.resolve.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: null, reason, extra: { code: t.code } })
      });
      throw t;
    }

    await writeAuditRow(client, {
      tenantId: authority.tenantId, actorUserId: authority.userId,
      action: 'conversation.resolve', objectId: conversationId, ip: deps.ip ?? null,
      metadata: auditMeta(conv, {
        fromState: conv.state, toState: result.state, reason,
        extra: { assignedUserId: result.assignedUserId }
      })
    });

    return operationResult(conv, {
      state: result.state,
      assignedUserId: conv.assigned_user_id,
      duplicate: false,
      action: 'resolved'
    });
  });
}

/* ============================================================== resumeAI === */

/**
 * RESUME AI — any handled state -> AI_ACTIVE. The only way back.
 *
 * ALWAYS explicit and ALWAYS authorized. There is no automatic resume anywhere in
 * this codebase, and none is added here.
 *
 * FAIL-CLOSED GUARDS, checked BEFORE `handoff.resumeAi()` is called, because that
 * function closes every open escalation as a side effect:
 *
 *   - an unresolved escalation exists (any category: complaint, handoff,
 *     customer_requested_human, contact_data)  -> refused
 *   - the conversation is HUMAN_ACTIVE            -> refused
 *   - a human reply is claimed and not yet delivered -> refused
 *
 * A "customer requested a human" escalation that is still open is precisely the
 * case where resuming the AI would contradict the customer, so it is refused on
 * the same rule as any other unresolved escalation.
 *
 * There is deliberately NO `force` / `overrideEscalations` parameter. Discharging
 * an unresolved escalation is a separate capability with its own authorisation
 * and its own audit, and it is out of P0.3-A scope.
 */
export async function resumeAiOperation({ session, conversationId, body = {}, deps = {} }) {
  const db = deps.db ?? pool;
  const authority = resolveOpsAuthority(session);
  requireContext(authority);
  if (!isUuid(conversationId)) {
    throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');
  }
  if (!authority.canResumeAi) {
    throw new OpsError(403, OPS_ERRORS.FORBIDDEN, 'your role cannot resume the AI on a conversation');
  }
  // handoff.resumeAi requires a real reason; reject a missing one with the same
  // contract rather than letting a default slip through.
  const rawReason = normalizeReason(body.reason, null);
  if (!rawReason || rawReason.length < 2) {
    throw new OpsError(422, 'HANDOFF_REASON_REQUIRED', 'a resume reason is required');
  }
  const scope = deps.scope ?? null;

  return withTransaction(db, async (client) => {
    const conv = await loadScopedConversation(client, {
      tenantId: authority.tenantId, conversationId, scope
    });
    if (!conv) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

    // Idempotent replay: the AI already owns it.
    if (conv.state === CONVERSATION_STATES.AI_ACTIVE) {
      await writeAuditRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.resume_ai', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: conv.state, reason: rawReason, extra: { duplicate: true } })
      });
      return operationResult(conv, { state: conv.state, assignedUserId: null, duplicate: true, action: 'resumed' });
    }

    const blocker = await findResumeBlocker(client, {
      tenantId: authority.tenantId, conversationId, conv, actorUserId: authority.userId
    });
    if (blocker) {
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.resume_ai.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, {
          fromState: conv.state, toState: null, reason: rawReason,
          extra: { blocker: blocker.reason, ...(blocker.details ?? {}) }
        })
      });
      throw new OpsError(409, blocker.code, blocker.message, blocker.details);
    }

    let result;
    try {
      result = await resumeAi(
        { tenantId: authority.tenantId, conversationId, reason: rawReason },
        { db: client, actorUserId: authority.userId }
      );
    } catch (e) {
      const t = translate(e);
      await writeDeniedRow(client, {
        tenantId: authority.tenantId, actorUserId: authority.userId,
        action: 'conversation.resume_ai.denied', objectId: conversationId, ip: deps.ip ?? null,
        metadata: auditMeta(conv, { fromState: conv.state, toState: null, reason: rawReason, extra: { code: t.code } })
      });
      throw t;
    }

    await writeAuditRow(client, {
      tenantId: authority.tenantId, actorUserId: authority.userId,
      action: 'conversation.resume_ai', objectId: conversationId, ip: deps.ip ?? null,
      metadata: auditMeta(conv, {
        fromState: conv.state, toState: result.state, reason: rawReason,
        extra: { previousAssignee: conv.assigned_user_id }
      })
    });

    return operationResult(conv, {
      state: result.state, assignedUserId: null, duplicate: false, action: 'resumed',
      extra: { previousAssignee: conv.assigned_user_id }
    });
  });
}

/**
 * Why may the AI NOT be resumed here? Returns null when it may.
 * Pure reads — nothing is written.
 */
async function findResumeBlocker(client, { tenantId, conversationId, conv, actorUserId }) {
  if (conv.state === CONVERSATION_STATES.HUMAN_ACTIVE) {
    return {
      code: OPS_ERRORS.HUMAN_ENGAGED,
      reason: RESUME_AI_BLOCKERS.HUMAN_ENGAGED,
      message: 'a human is actively handling this conversation',
      details: { state: conv.state }
    };
  }

  const inFlight = await humanReplyInFlight({ tenantId, conversationId, db: client });
  if (inFlight) {
    return {
      code: OPS_ERRORS.REPLY_IN_FLIGHT,
      reason: RESUME_AI_BLOCKERS.REPLY_IN_FLIGHT,
      message: 'an employee reply is claimed and not yet delivered',
      details: { state: conv.state }
    };
  }

  const open = await loadOpenEscalations(client, { tenantId, conversationId });
  if (open.length > 0) {
    return {
      code: OPS_ERRORS.OPEN_ESCALATIONS,
      reason: RESUME_AI_BLOCKERS.OPEN_ESCALATIONS,
      message: 'this conversation has an unresolved escalation that must be closed first',
      details: {
        state: conv.state,
        openEscalations: open.map((e) => ({
          id: e.id,
          category: e.category,
          status: e.status,
          priority: e.priority,
          createdAt: e.created_at
        }))
      }
    };
  }

  return null;
}

/* ============================================================ read context */

/**
 * GET /:id/handoff — everything the P0.3-B UI needs, in one round trip.
 *
 * Read-only. Grants nothing: `permissions` describes what the CALLER may attempt,
 * and the write path re-decides every one of these questions inside its own
 * transaction.
 */
export async function getHandoffContext({ session, conversationId, deps = {} }) {
  const db = deps.db ?? pool;
  const authority = resolveOpsAuthority(session);
  requireContext(authority);
  if (!isUuid(conversationId)) {
    throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');
  }
  const scope = deps.scope;

  const view = await getConversationHandoffView({
    tenantId: authority.tenantId, conversationId, db
  });
  if (!view) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

  // Brand scope is re-checked here because getConversationHandoffView is
  // tenant-scoped only; without this an out-of-brand conversation would be
  // readable through this endpoint.
  const bs = brandScopeSql('ch', { tenantWideParam: 1, brandIdsParam: 2 });
  const visible = await db.query(
    `SELECT 1 FROM channels ch WHERE ch.id = $3 AND ${bs.sql} LIMIT 1`,
    [...bs.params(scope), view.channel_id]
  );
  if (!visible.rows[0]) throw new OpsError(404, OPS_ERRORS.NOT_FOUND, 'conversation not found');

  const [history, members, openEscalations] = await Promise.all([
    listAssignmentHistory({ tenantId: authority.tenantId, conversationId, limit: 50, db }),
    listEligibleMembers({ tenantId: authority.tenantId, db }),
    loadOpenEscalations(db, { tenantId: authority.tenantId, conversationId })
  ]);

  const isAssignee = view.assigned_user_id === authority.userId;
  const canResumeAi = authority.canResumeAi
    && view.state !== CONVERSATION_STATES.AI_ACTIVE
    && view.state !== CONVERSATION_STATES.HUMAN_ACTIVE
    && openEscalations.length === 0;

  return {
    conversation: {
      id: view.id,
      state: view.state,
      assignedUserId: view.assigned_user_id,
      assignedUserName: view.assigned_user_name,
      assignedTeamId: view.assigned_team_id,
      assignedTeamName: view.assigned_team_name,
      brandId: view.brand_id,
      brandName: view.brand_name,
      channelProvider: view.provider,
      channelName: view.channel_name,
      priority: view.priority,
      resolvedAt: view.resolved_at,
      createdAt: view.created_at
    },
    openEscalations: openEscalations.map((e) => ({
      id: e.id,
      category: e.category,
      status: e.status,
      priority: e.priority,
      createdAt: e.created_at
    })),
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      userId: h.user_id,
      userName: h.actor_user_name,
      assignedBy: h.assigned_by,
      assignedByName: h.assigned_by_name,
      reason: h.reason,
      createdAt: h.created_at
    })),
    eligibleMembers: members.map((m) => ({
      id: m.id, name: m.name, email: m.email, roles: m.roles ?? []
    })),
    permissions: {
      canClaim: authority.canClaim && view.state === CONVERSATION_STATES.QUEUED,
      canAssign: authority.canAssign && view.state !== CONVERSATION_STATES.RESOLVED,
      canReassign: authority.canReassign && Boolean(view.assigned_user_id) && view.state !== CONVERSATION_STATES.RESOLVED,
      canUnassign: authority.canUnassign && Boolean(view.assigned_user_id),
      canResolve: (authority.canResolveAny || (authority.canResolveOwn && isAssignee))
        && [CONVERSATION_STATES.ASSIGNED, CONVERSATION_STATES.HUMAN_ACTIVE].includes(view.state),
      canResumeAi,
      // Why Resume AI is unavailable, so the UI can explain rather than hide.
      resumeAiBlockedReason: canResumeAi
        ? null
        : (!authority.canResumeAi
            ? RESUME_AI_BLOCKERS.NO_ABILITY
            : view.state === CONVERSATION_STATES.AI_ACTIVE
                ? 'already_ai_active'
                : view.state === CONVERSATION_STATES.HUMAN_ACTIVE
                    ? RESUME_AI_BLOCKERS.HUMAN_ENGAGED
                    : openEscalations.length > 0
                        ? RESUME_AI_BLOCKERS.OPEN_ESCALATIONS
                        : 'state_not_resumable'),
      isAssignee
    }
  };
}