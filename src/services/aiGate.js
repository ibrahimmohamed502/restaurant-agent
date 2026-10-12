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
