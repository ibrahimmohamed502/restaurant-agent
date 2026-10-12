/**
 * Stage 7 — Conversation handoff state machine.
 *
 * `conversations.state` is the AUTHORITATIVE lifecycle. There is deliberately
 * NO second `ai_paused` flag: AI is active ⟺ state === 'AI_ACTIVE'.
 *
 * All transitions are DB-guarded: the UPDATE carries `state = <expected>`, so
 * the predicate itself is the concurrency lock. Exactly one caller can win a
 * transition; the loser gets HANDOFF_CONFLICT and must re-read.
 *
 * Every transition:
 *   1. validates the from-state,
 *   2. performs the guarded UPDATE,
 *   3. appends an immutable row to `assignments` (history is never rewritten),
 *   4. keeps the linked `escalations` row in sync (display only, not authoritative),
 *   5. fires audit + notifications through injected hooks (fail-safe, never throws).
 *
 * Nothing here knows about HTTP, sessions, or CSRF — the API layer owns that.
 */
import { pool } from '../db/pg.js';

export const CONVERSATION_STATES = Object.freeze({
  AI_ACTIVE: 'AI_ACTIVE',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  QUEUED: 'QUEUED',
  ASSIGNED: 'ASSIGNED',
  HUMAN_ACTIVE: 'HUMAN_ACTIVE',
  RESOLVED: 'RESOLVED'
});

export const ALL_STATES = Object.freeze(Object.values(CONVERSATION_STATES));

/** Every non-AI state means the AI is OFF for that conversation. */
export const HANDLED_STATES = Object.freeze(
  ALL_STATES.filter((s) => s !== CONVERSATION_STATES.AI_ACTIVE)
);

/** The single predicate the AI gate uses. No exceptions. */
export function isAiActive(state) {
  return state === CONVERSATION_STATES.AI_ACTIVE;
}

/** Who may trigger a handoff. */
export const REQUESTED_BY = Object.freeze({
  CUSTOMER: 'customer',
  STAFF: 'staff'
});

export const ASSIGNMENT_ACTIONS = Object.freeze({
  ASSIGNED: 'assigned',
  REASSIGNED: 'reassigned',
  UNASSIGNED: 'unassigned',
  RESUMED: 'resumed',
  RESOLVED: 'resolved'
});

/** Lifecycle → escalation.status mapping (display only, never authoritative). */
const ESCALATION_STATUS = Object.freeze({
  HUMAN_REQUIRED: 'new',
  QUEUED: 'new',
  ASSIGNED: 'assigned',
  HUMAN_ACTIVE: 'in_progress',
  RESOLVED: 'done'
});

/**
 * Allowed transitions (from-states → to-state).
 * This table is the single source of truth for what the state machine permits;
 * each transition function additionally guards its own UPDATE, so the DB is
 * always the final authority.
 */
export const TRANSITIONS = Object.freeze([
  { from: [CONVERSATION_STATES.AI_ACTIVE], to: CONVERSATION_STATES.HUMAN_REQUIRED },
  { from: [CONVERSATION_STATES.HUMAN_REQUIRED], to: CONVERSATION_STATES.QUEUED },
  {
    from: [CONVERSATION_STATES.QUEUED, CONVERSATION_STATES.HUMAN_REQUIRED],
    to: CONVERSATION_STATES.ASSIGNED
  },
  { from: [CONVERSATION_STATES.ASSIGNED], to: CONVERSATION_STATES.HUMAN_ACTIVE },
  { from: [CONVERSATION_STATES.ASSIGNED], to: CONVERSATION_STATES.ASSIGNED }, // reassign
  {
    from: [CONVERSATION_STATES.ASSIGNED, CONVERSATION_STATES.HUMAN_ACTIVE],
    to: CONVERSATION_STATES.QUEUED
  },
  {
    from: [CONVERSATION_STATES.ASSIGNED, CONVERSATION_STATES.HUMAN_ACTIVE],
    to: CONVERSATION_STATES.RESOLVED
  },
  { from: HANDLED_STATES, to: CONVERSATION_STATES.AI_ACTIVE } // explicit Resume AI only
]);

/** Is `from → to` a permitted transition? */
export function isAllowedTransition(from, to) {
  return TRANSITIONS.some((t) => t.to === to && t.from.includes(from));
}

export class HandoffError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HandoffError';
    this.status = status;
    this.code = code;
  }
}

export const HANDOFF_ERRORS = Object.freeze({
  CONFLICT: 'HANDOFF_CONFLICT',
  INVALID_TRANSITION: 'HANDOFF_INVALID_TRANSITION',
  NOT_FOUND: 'HANDOFF_NOT_FOUND',
  USER_NOT_ELIGIBLE: 'HANDOFF_USER_NOT_ELIGIBLE',
  FORBIDDEN: 'HANDOFF_FORBIDDEN',
  SAME_ASSIGNEE: 'HANDOFF_SAME_ASSIGNEE',
  NOT_ASSIGNED: 'HANDOFF_NOT_ASSIGNED',
  REASON_REQUIRED: 'HANDOFF_REASON_REQUIRED'
});

/* ------------------------------------------------------------------ */
/* reads                                                              */
/* ------------------------------------------------------------------ */

/** Authoritative state read. Always from PostgreSQL — never a cache. */
export async function getConversationState({ tenantId, conversationId, db = pool }) {
  const { rows } = await db.query(
    `SELECT id, state FROM conversations WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId]
  );
  return rows[0]?.state ?? null;
}

/** Full handoff view of a conversation (tenant-scoped). */
export async function getConversationHandoffView({ tenantId, conversationId, db = pool }) {
  const { rows } = await db.query(
    `SELECT c.id, c.tenant_id, c.state, c.assigned_user_id, c.assigned_team_id,
            c.priority, c.resolved_at, c.created_at, c.external_key, c.channel_id,
            ch.provider, ch.external_id AS page_external_id, ch.display_name AS channel_name,
            ch.brand_id, b.name AS brand_name,
            cu.display_name AS customer_name,
            au.name AS assigned_user_name, au.email AS assigned_user_email,
            tm.name AS assigned_team_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN brands b ON b.id = ch.brand_id
       LEFT JOIN customers cu ON cu.id = c.customer_id
       LEFT JOIN users au ON au.id = c.assigned_user_id
       LEFT JOIN teams tm ON tm.id = c.assigned_team_id
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );
  return rows[0] ?? null;
}

/** Append-only assignment history for a conversation (tenant-scoped). */
export async function listAssignmentHistory({ tenantId, conversationId, limit = 50, db = pool }) {
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.user_id, a.team_id, a.reason, a.created_at,
            u.name AS actor_user_name, by_u.name AS assigned_by_name
       FROM assignments a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users by_u ON by_u.id = a.assigned_by
      WHERE a.conversation_id = $1 AND a.tenant_id = $2
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [conversationId, tenantId, limit]
  );
  return rows;
}

/**
 * Eligible assignees for a tenant (optionally narrowed to a team).
 * Never returns a user from another tenant.
 */
export async function listEligibleMembers({ tenantId, teamId = null, db = pool }) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.status,
            COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = $1
        AND u.status = 'active'
        AND r.name = ANY($2::text[])
        AND ($3::uuid IS NULL OR u.id IN (
              SELECT tm.user_id FROM team_members tm WHERE tm.team_id = $3::uuid
            ))
      GROUP BY u.id
      ORDER BY u.name ASC`,
    [tenantId, HANDLING_ROLES, teamId]
  );
  return rows;
}

/** Roles allowed to handle conversations (used for eligibility + RBAC). */
export const HANDLING_ROLES = Object.freeze(['Company Admin', 'Supervisor', 'Agent']);

/** Is this user an active member of this tenant with a handling role? */
export async function isEligibleAssignee({ tenantId, userId, db = pool }) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT 1
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1 AND u.tenant_id = $2 AND u.status = 'active'
        AND r.name = ANY($3::text[])
      LIMIT 1`,
    [userId, tenantId, HANDLING_ROLES]
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* transition core                                                    */
/* ------------------------------------------------------------------ */

/**
 * Guarded state transition. The `state = ANY(from)` predicate in the UPDATE is
 * the concurrency lock — exactly one caller can move the row.
 *
 * The SET clause is built DYNAMICALLY so that an explicit `null` really does
 * clear a column. A fixed `COALESCE($n, col)` cannot do that: SQL treats NULL
 * as "leave unchanged", which would silently keep a stale assignee after an
 * unassignment or a Resume AI.
 */
async function applyTransition(
  { tenantId, conversationId, to, from, set = {}, db = pool },
  deps
) {
  const fromStates = Array.isArray(from) ? from : [from];
  const setClauses = ['state = $1'];
  const whereClauses = [];
  const params = [to];
  let idx = 2;

  if (set.assignedUserId !== undefined) {
    setClauses.push(`assigned_user_id = $${idx++}`);
    params.push(set.assignedUserId);
  }
  if (set.assignedTeamId !== undefined) {
    setClauses.push(`assigned_team_id = $${idx++}`);
    params.push(set.assignedTeamId);
  }
  if (set.priority !== undefined) {
    setClauses.push(`priority = $${idx++}`);
    params.push(set.priority);
  }
  if ('resolvedAt' in set) {
    setClauses.push(`resolved_at = $${idx++}`);
    params.push(set.resolvedAt);
  }

  whereClauses.push(`id = $${idx++}`);
  params.push(conversationId);
  whereClauses.push(`tenant_id = $${idx++}`);
  params.push(tenantId);
  whereClauses.push(`state = ANY($${idx++}::text[])`);
  params.push(fromStates);

  const { rows } = await db.query(
    `UPDATE conversations SET ${setClauses.join(', ')}
      WHERE ${whereClauses.join(' AND ')}
      RETURNING id, state, assigned_user_id, assigned_team_id, priority, resolved_at`,
    params
  );
  if (!rows[0]) {
    // Either it does not exist / belongs to another tenant, or it moved on.
    const exists = await db.query(
      `SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2`,
      [conversationId, tenantId]
    );
    if (!exists.rows[0]) {
      throw new HandoffError(404, HANDOFF_ERRORS.NOT_FOUND, 'conversation not found');
    }
    throw new HandoffError(409, HANDOFF_ERRORS.CONFLICT, 'conversation state changed — reload and retry');
  }
  return rows[0];
}

/** Immutable history row. Never updated afterwards. */
async function appendAssignment({ tenantId, conversationId, action, userId, teamId, reason, assignedBy, db = pool }) {
  await db.query(
    `INSERT INTO assignments (tenant_id, conversation_id, action, user_id, team_id, reason, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, conversationId, action, userId ?? null, teamId ?? null, reason ?? null, assignedBy ?? null]
  );
}

/** Keep the linked escalation row in sync for display (not authoritative). */
async function syncEscalation({ tenantId, conversationId, state, category, reason, priority, requestedBy, assignedUserId, assignedTeamId, db = pool }) {
  const status = ESCALATION_STATUS[state];
  if (state === CONVERSATION_STATES.AI_ACTIVE) {
    // No open escalation is required while the AI owns the conversation.
    return;
  }
  const existing = await db.query(
    `SELECT id FROM escalations
      WHERE conversation_id = $1 AND tenant_id = $2 AND resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [conversationId, tenantId]
  );
  if (existing.rows[0]) {
    await db.query(
      `UPDATE escalations
          SET status = $1, assigned_user_id = $2, assigned_team_id = $3,
              priority = COALESCE($4, priority)
        WHERE id = $5 AND tenant_id = $6`,
      [status, assignedUserId ?? null, assignedTeamId ?? null, priority ?? null, existing.rows[0].id, tenantId]
    );
    return;
  }
  await db.query(
    `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by, assigned_user_id, assigned_team_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, conversationId, category ?? 'handoff', reason ?? null, priority ?? 'normal', status, requestedBy ?? REQUESTED_BY.STAFF, assignedUserId ?? null, assignedTeamId ?? null]
  );
}

/* ------------------------------------------------------------------ */
/* transitions                                                        */
/* ------------------------------------------------------------------ */

/**
 * AI_ACTIVE → HUMAN_REQUIRED → QUEUED
 * Triggered by the deterministic customer detector OR by authorized staff.
 * This is the ONLY place the AI gets switched off.
 */
export async function requestHandoff(
  { tenantId, conversationId, reason, priority = 'normal', requestedBy = REQUESTED_BY.CUSTOMER, category = 'handoff', assignedTeamId = null },
  deps = {}
) {
  const db = deps.db ?? pool;
  if (!reason || String(reason).trim().length < 2) {
    throw new HandoffError(422, HANDOFF_ERRORS.REASON_REQUIRED, 'a handoff reason is required');
  }
  const reasonText = String(reason).slice(0, 500);

  // HUMAN_REQUIRED is the durable record of the trigger (who + why + when).
  await applyTransition(
    {
      tenantId,
      conversationId,
      to: CONVERSATION_STATES.HUMAN_REQUIRED,
      from: [CONVERSATION_STATES.AI_ACTIVE],
      set: { assignedUserId: null, assignedTeamId, priority, resolvedAt: null }
    },
    deps
  );

  // QUEUED — waiting for an eligible human.
  const updated = await applyTransition(
    {
      tenantId,
      conversationId,
      to: CONVERSATION_STATES.QUEUED,
      from: CONVERSATION_STATES.HUMAN_REQUIRED,
      set: {}
    },
    deps
  );

  await appendAssignment({
    tenantId,
    conversationId,
    action: ASSIGNMENT_ACTIONS.ASSIGNED, // represents "entered the handoff queue"
    userId: null,
    teamId: assignedTeamId,
    reason: reasonText,
    assignedBy: deps.actorUserId ?? null,
    db
  });

  await syncEscalation({
    tenantId, conversationId, state: CONVERSATION_STATES.QUEUED,
    category, reason: reasonText, priority, requestedBy,
    assignedUserId: null, assignedTeamId, db
  });

  await safe(deps.onHandoffRequested, {
    tenantId, conversationId, reason: reasonText, priority, requestedBy, assignedTeamId
  }, deps, 'handoff.requested');

  return { conversationId, state: CONVERSATION_STATES.QUEUED, reason: reasonText, requestedBy, priority };
}

/**
 * Shared assign implementation.
 * `allowedFrom` is the exact set of states the UPDATE guards on — it is the
 * concurrency lock, so a claim (QUEUED only) can never be won twice, while an
 * assign/reassign (QUEUED | ASSIGNED) remains possible for supervisors.
 */
async function performAssign({ tenantId, conversationId, userId, teamId = null, reason = null, allowedFrom }, deps = {}) {
  const db = deps.db ?? pool;
  if (!userId) throw new HandoffError(422, HANDOFF_ERRORS.USER_NOT_ELIGIBLE, 'an assignee is required');

  const view = await getConversationHandoffView({ tenantId, conversationId, db });
  if (!view) throw new HandoffError(404, HANDOFF_ERRORS.NOT_FOUND, 'conversation not found');
  if (view.assigned_user_id === userId && view.state === CONVERSATION_STATES.ASSIGNED) {
    throw new HandoffError(409, HANDOFF_ERRORS.SAME_ASSIGNEE, 'conversation is already assigned to this user');
  }
  if (!(await isEligibleAssignee({ tenantId, userId, db }))) {
    throw new HandoffError(422, HANDOFF_ERRORS.USER_NOT_ELIGIBLE, 'target user is not an eligible active member of this tenant');
  }

  const previousAssignee = view.assigned_user_id;
  const action = previousAssignee ? ASSIGNMENT_ACTIONS.REASSIGNED : ASSIGNMENT_ACTIONS.ASSIGNED;

  const updated = await applyTransition(
    {
      tenantId,
      conversationId,
      to: CONVERSATION_STATES.ASSIGNED,
      from: allowedFrom,
      set: { assignedUserId: userId, assignedTeamId: teamId, resolvedAt: null }
    },
    deps
  );

  await appendAssignment({
    tenantId, conversationId, action, userId, teamId,
    reason: reason ?? (previousAssignee ? 'reassigned' : 'claimed'),
    assignedBy: deps.actorUserId ?? null, db
  });

  await syncEscalation({
    tenantId, conversationId, state: CONVERSATION_STATES.ASSIGNED,
    assignedUserId: userId, assignedTeamId: teamId, db
  });

  await safe(deps.onAssigned, {
    tenantId, conversationId, userId, previousAssignee, teamId, reason, action
  }, deps, 'conversation.assigned');

  return { conversationId, state: updated.state, assignedUserId: userId, previousAssignee, action };
}

/**
 * CLAIM — QUEUED → ASSIGNED, guarded on `state = 'QUEUED'` ONLY.
 * This is the race-safe self-assign used by agents: two agents claiming the
 * same queued conversation cannot both win — the loser gets HANDOFF_CONFLICT.
 */
export function claimConversation({ tenantId, conversationId, userId, teamId = null, reason = null }, deps = {}) {
  return performAssign(
    { tenantId, conversationId, userId, teamId, reason, allowedFrom: [CONVERSATION_STATES.QUEUED] },
    deps
  );
}

/**
 * ASSIGN / REASSIGN — QUEUED | ASSIGNED → ASSIGNED.
 * Supervisor/Admin operation: hand a conversation to another eligible user or
 * move it away from its current owner.
 */
export function assignConversation({ tenantId, conversationId, userId, teamId = null, reason = null }, deps = {}) {
  return performAssign(
    {
      tenantId, conversationId, userId, teamId, reason,
      allowedFrom: [CONVERSATION_STATES.QUEUED, CONVERSATION_STATES.ASSIGNED]
    },
    deps
  );
}

/** ASSIGNED → HUMAN_ACTIVE (staff actually engaged). */
export async function activateHumanHandling(
  { tenantId, conversationId },
  deps = {}
) {
  const db = deps.db ?? pool;
  const updated = await applyTransition(
    { tenantId, conversationId, to: CONVERSATION_STATES.HUMAN_ACTIVE, from: CONVERSATION_STATES.ASSIGNED, set: {} },
    deps
  );
  await appendAssignment({
    tenantId, conversationId, action: ASSIGNMENT_ACTIONS.ASSIGNED,
    userId: updated.assigned_user_id, teamId: updated.assigned_team_id,
    reason: 'human handling started', assignedBy: deps.actorUserId ?? null, db
  });
  await syncEscalation({
    tenantId, conversationId, state: CONVERSATION_STATES.HUMAN_ACTIVE,
    assignedUserId: updated.assigned_user_id, assignedTeamId: updated.assigned_team_id, db
  });
  return { conversationId, state: updated.state };
}

/** ASSIGNED/HUMAN_ACTIVE → QUEUED. */
export async function unassignConversation(
  { tenantId, conversationId, reason = null },
  deps = {}
) {
  const db = deps.db ?? pool;
  const view = await getConversationHandoffView({ tenantId, conversationId, db });
  if (!view) throw new HandoffError(404, HANDOFF_ERRORS.NOT_FOUND, 'conversation not found');
  if (!view.assigned_user_id) {
    throw new HandoffError(409, HANDOFF_ERRORS.NOT_ASSIGNED, 'conversation is not currently assigned');
  }

  const updated = await applyTransition(
    {
      tenantId, conversationId,
      to: CONVERSATION_STATES.QUEUED,
      from: [CONVERSATION_STATES.ASSIGNED, CONVERSATION_STATES.HUMAN_ACTIVE],
      set: { assignedUserId: null, assignedTeamId: null, resolvedAt: null }
    },
    deps
  );

  await appendAssignment({
    tenantId, conversationId, action: ASSIGNMENT_ACTIONS.UNASSIGNED,
    userId: view.assigned_user_id, teamId: view.assigned_team_id,
    reason: reason ?? 'unassigned', assignedBy: deps.actorUserId ?? null, db
  });

  await syncEscalation({
    tenantId, conversationId, state: CONVERSATION_STATES.QUEUED,
    assignedUserId: null, assignedTeamId: null, db
  });

  await safe(deps.onUnassigned, {
    tenantId, conversationId, previousAssignee: view.assigned_user_id, reason
  }, deps, 'conversation.unassigned');

  return { conversationId, state: updated.state };
}

/** ASSIGNED/HUMAN_ACTIVE → RESOLVED. AI STAYS OFF. */
export async function resolveConversation(
  { tenantId, conversationId },
  deps = {}
) {
  const db = deps.db ?? pool;
  const updated = await applyTransition(
    {
      tenantId, conversationId,
      to: CONVERSATION_STATES.RESOLVED,
      from: [CONVERSATION_STATES.ASSIGNED, CONVERSATION_STATES.HUMAN_ACTIVE],
      set: { resolvedAt: new Date().toISOString() }
    },
    deps
  );
  await appendAssignment({
    tenantId, conversationId, action: ASSIGNMENT_ACTIONS.RESOLVED,
    userId: updated.assigned_user_id, teamId: updated.assigned_team_id,
    reason: 'resolved', assignedBy: deps.actorUserId ?? null, db
  });
  await syncEscalation({
    tenantId, conversationId, state: CONVERSATION_STATES.RESOLVED,
    assignedUserId: updated.assigned_user_id, assignedTeamId: updated.assigned_team_id, db
  });
  await safe(deps.onResolved, {
    tenantId, conversationId, userId: updated.assigned_user_id
  }, deps, 'conversation.resolved');
  return { conversationId, state: updated.state };
}

/**
 * Any non-AI state → AI_ACTIVE. THE ONLY WAY BACK.
 * Admin/Supervisor only, explicit reason required.
 * RESOLVED never resumes AI automatically.
 */
export async function resumeAi(
  { tenantId, conversationId, reason },
  deps = {}
) {
  const db = deps.db ?? pool;
  if (!reason || String(reason).trim().length < 2) {
    throw new HandoffError(422, HANDOFF_ERRORS.REASON_REQUIRED, 'a resume reason is required');
  }
  const reasonText = String(reason).slice(0, 500);

  const updated = await applyTransition(
    {
      tenantId, conversationId,
      to: CONVERSATION_STATES.AI_ACTIVE,
      from: HANDLED_STATES,
      set: { assignedUserId: null, assignedTeamId: null, resolvedAt: null }
    },
    deps
  );

  await appendAssignment({
    tenantId, conversationId, action: ASSIGNMENT_ACTIONS.RESUMED,
    userId: null, teamId: null, reason: reasonText,
    assignedBy: deps.actorUserId ?? null, db
  });

  // Close any open escalation row so the Inbox does not show a stale "needs human".
  await db.query(
    `UPDATE escalations SET status = 'done', resolved_at = now()
      WHERE conversation_id = $1 AND tenant_id = $2 AND resolved_at IS NULL`,
    [conversationId, tenantId]
  );

  await safe(deps.onAiResumed, {
    tenantId, conversationId, reason: reasonText
  }, deps, 'conversation.resume_ai');

  return { conversationId, state: updated.state, reason: reasonText };
}

/** Never let a broken notification hook break a conversation transition. */
async function safe(fn, payload, deps, action) {
  if (typeof fn !== 'function') return;
  try {
    await fn(payload);
  } catch (e) {
    console.error(`stage7 hook failed (${action}):`, e?.message ?? 'error');
  }
}
