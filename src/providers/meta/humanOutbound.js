/**
 * Stage 7 — Meta human outbound adapter (DM + comment).
 *
 * Provider-specific behaviour lives ONLY here, behind the provider-neutral
 * registry in src/providers/humanOutbound.js.
 *
 * Messenger messaging-window policy (centralised here so a change in Meta's
 * rules is isolated to this file):
 *
 *   < 24h since the customer's last message
 *        → messaging_type: RESPONSE                (standard allowed response)
 *   24h → 7 days
 *        → messaging_type: MESSAGE_TAG + tag: HUMAN_AGENT
 *   > 7 days
 *        → blocked BEFORE any send attempt
 *
 * The HUMAN_AGENT tag is EXCLUSIVELY for a genuine human-authored reply typed
 * by staff in our Unified Inbox. It must never be used for AI replies,
 * automated acknowledgements, automation rules or scheduled messages.
 * (facebook.js will only emit the tag when the caller explicitly asks for it,
 * which only this adapter's human path ever does.)
 */
import { createMetaClient, HUMAN_AGENT_MESSAGE_TAG } from '../../facebook.js';

export const MESSENGER_STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MESSENGER_HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Meta error code for "the standard messaging window has expired". */
export const META_WINDOW_CLOSED_CODE = 1545041;

export const MESSENGER_POLICY_CODES = Object.freeze({
  STANDARD: 'standard_window',
  HUMAN_AGENT: 'human_agent_window',
  EXPIRED: 'window_expired'
});

/**
 * Derive the outbound target from SERVER-SIDE stored conversation data.
 * The browser never supplies a PSID, comment id, or page id.
 */
export function resolveMetaTarget({ conversation, channel, lastInbound }) {
  const provider = channel?.provider ?? null;

  if (provider === 'meta_dm') {
    // DM identity is the PSID stored as the conversation external_key.
    const psid = conversation?.external_key ?? null;
    if (!psid) {
      const err = new Error('meta_dm conversation has no external_key (PSID)');
      err.code = 'HUMAN_OUTBOUND_TARGET_MISSING';
      throw err;
    }
    return { kind: 'dm', identifier: String(psid) };
  }

  // Comment: reply to the customer's last inbound comment so the reply stays
  // inside the same thread, falling back to the conversation thread root.
  const commentId = lastInbound?.provider_message_id ?? conversation?.external_key ?? null;
  if (!commentId) {
    const err = new Error('meta_comment conversation has no replyable comment id');
    err.code = 'HUMAN_OUTBOUND_TARGET_MISSING';
    throw err;
  }
  return { kind: 'comment', identifier: String(commentId) };
}

/**
 * Can a human reply be sent right now?
 * Returns a deterministic, pre-send decision so the UI can block before we
 * burn a provider call.
 */
export function evaluateMessengerPolicy({ target, lastInbound, now = new Date() }) {
  if (target.kind !== 'dm') {
    // Public comments have no messaging window.
    return { allowed: true, mode: 'comment', code: MESSENGER_POLICY_CODES.STANDARD, message: null };
  }
  const stamp = lastInbound?.created_at ?? lastInbound?.provider_ts ?? null;
  if (!stamp) {
    // No inbound timestamp available → be conservative but still allow the
    // standard mechanism (Meta will reject it safely if the window is shut).
    return { allowed: true, mode: 'response', code: MESSENGER_POLICY_CODES.STANDARD, message: null };
  }
  const elapsed = now.getTime() - new Date(stamp).getTime();

  if (elapsed <= MESSENGER_STANDARD_WINDOW_MS) {
    return { allowed: true, mode: 'response', code: MESSENGER_POLICY_CODES.STANDARD, message: null };
  }
  if (elapsed <= MESSENGER_HUMAN_AGENT_WINDOW_MS) {
    return {
      allowed: true,
      mode: 'human_agent_tag',
      code: MESSENGER_POLICY_CODES.HUMAN_AGENT,
      message: 'Sent using the Meta Human Agent window (up to 7 days after the customer’s last message).'
    };
  }
  return {
    allowed: false,
    mode: 'blocked',
    code: MESSENGER_POLICY_CODES.EXPIRED,
    message: 'Meta no longer allows a message to this customer (more than 7 days since their last message). Ask the customer to send a new message.'
  };
}

/** Perform the actual send. `credential` is the decrypted DB credential. */
export async function sendMetaHumanReply({ target, text, credential, policy }) {
  const client = createMetaClient({ accessToken: credential });

  if (target.kind === 'dm') {
    const useTag = policy?.mode === 'human_agent_tag';
    const resp = await client.sendMessengerReply(target.identifier, text, {
      messagingType: useTag ? 'MESSAGE_TAG' : 'RESPONSE',
      tag: useTag ? HUMAN_AGENT_MESSAGE_TAG : undefined
    });
    return { providerMessageId: resp?.message_id ?? null, mechanism: useTag ? 'human_agent_tag' : 'response' };
  }

  const resp = await client.replyToComment(target.identifier, text);
  return { providerMessageId: resp?.id ?? null, mechanism: 'comment_reply' };
}

export const metaHumanOutboundAdapter = {
  provider: 'meta',
  resolveTarget: resolveMetaTarget,
  evaluatePolicy: evaluateMessengerPolicy,
  send: sendMetaHumanReply,
  windowClosedCode: META_WINDOW_CLOSED_CODE,
  humanAgentTag: HUMAN_AGENT_MESSAGE_TAG,
  /** Meta comment replies reject URLs — callers reuse the existing sanitizer. */
  commentSanitizerRequired: true
};

export default metaHumanOutboundAdapter;
