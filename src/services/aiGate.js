/**
 * Stage 7 — the AI stop/continue gate.
 *
 * ONE place decides whether the AI is allowed to answer a conversation:
 *
 *     AI is active  ⟺  conversations.state === 'AI_ACTIVE'
 *
 * Called from BOTH webhook processing paths (inline and queued), because both
 * share `processComment` / `processMessage` in src/webhook.js.
 *
 * The state is read from PostgreSQL on every event — never from an in-memory
 * cache — so a human flipping a conversation to HUMAN_ACTIVE takes effect on the
 * very next inbound message.
 *
 * This module contains NO business logic of its own beyond the predicate; all
 * transitions live in src/services/handoff.js.
 */
import { pool } from '../db/pg.js';
import { isAiActive, getConversationState } from './handoff.js';
import { humanReplyInFlight } from './manualReplies.js';

/**
 * @returns {Promise<{suppressed: boolean, state: string|null}>}
 *   `suppressed: true` means the caller must NOT generate or send anything.
 */
export async function evaluateAiGate({ tenantId, conversationId, db = pool }) {
  if (!tenantId || !conversationId) {
    // No persistence context → fail CLOSED for the gate question is impossible
    // (we would silence every reply in legacy mode), so fail OPEN and let the
    // legacy Stage 4.4.6 persistence guards handle it.
    return { suppressed: false, state: null };
  }
  const state = await getConversationState({ tenantId, conversationId, db });
  if (state === null) return { suppressed: false, state: null };
  return { suppressed: !isAiActive(state), state };
}

export { isAiActive };

/**
 * P0.2 — a claimed-but-undelivered HUMAN reply suppresses the AI send.
 *
 * Deliberately NOT folded into evaluateAiGate(). The gate runs early, before
 * detection, and its callers still need to run the customer-request and
 * auto-escalation detectors when it suppresses — a customer shouting for a
 * manager during a half-typed employee reply must still raise an escalation.
 * This is a SEND-time check only, and it is the one that closes the
 * AI/human interleaving:
 *
 *     t0  AI passes finalAiSendCheck          (state still AI_ACTIVE)
 *     t1  a handoff moves the conversation     → HUMAN_REQUIRED
 *     t2  an employee claims + sends a reply   → the customer has it
 *     t3  the AI's send lands                  → a second, contextless reply
 *
 * t0 has already happened by t2, so no amount of extra checking at t0 helps.
 * Checking here instead means t3 is refused.
 *
 * Returns false with no persistence context so legacy mode is unaffected.
 */
export async function evaluateHumanOwnership({ tenantId, conversationId, db = pool }) {
  if (!tenantId || !conversationId) return { suppressed: false, reason: null };
  const inFlight = await humanReplyInFlight({ tenantId, conversationId, db });
  return { suppressed: inFlight, reason: inFlight ? 'human_reply_in_flight' : null };
}
