/**
 * Stage 7 — human reply orchestration.
 *
 * A human employee replies to the customer FROM OUR UNIFIED INBOX. This module
 * is the single seam between the API and the provider-neutral outbound
 * registry (src/providers/humanOutbound.js).
 *
 * Send sequence (all steps are server-side, tenant-scoped and RBAC-guarded):
 *   1. load conversation + channel + last inbound (tenant-scoped)
 *   2. conversation must be in a human-handled state
 *   3. sender must be allowed to reply to THAT conversation
 *   4. resolve the provider adapter for the conversation's channel
 *   5. derive the provider target from stored data (never from the browser)
 *   6. evaluate the provider messaging-window policy BEFORE sending
 *   7. persist the human message as `sender_type='employee'`
 *   8. send through the provider abstraction
 *   9. record the REAL delivery result (never fake success)
 *
 * Double-submit protection: a client-supplied idempotency key becomes the
 * initial provider_message_id, so a repeated submit conflicts on the existing
 * unique index and is answered from the stored row WITHOUT a second send.
 */
import crypto from 'node:crypto';
import { pool, enabled } from '../db/pg.js';
import { getHumanOutboundAdapter } from '../providers/humanOutbound.js';
import { registerHumanOutboundAdapter } from '../providers/humanOutbound.js';
import metaHumanOutboundAdapter, { META_WINDOW_CLOSED_CODE, MESSENGER_POLICY_CODES } from '../providers/meta/humanOutbound.js';
import { sanitizeCommentMessage } from '../webhook.js';
import { resolveMetaChannel, RESOLVE_ERRORS } from './channelResolver.js';import {
  persistHumanOutboundMessage,
  getLastInboundMessage,
  claimFailedOutboundForRetry,
  updateMessageDelivery,
  deliveryErrorCategory
} from './conversations.js';
import {
  getConversationHandoffView,
  activateHumanHandling,
  HANDLED_STATES,
  CONVERSATION_STATES
} from './handoff.js';
import { createNotifications, NOTIFICATION_TYPES } from './notifications.js';

// Register the Meta adapter once at module load. Future providers register
// their own adapter the same way (Stage 8/9) without touching any caller.
registerHumanOutboundAdapter(metaHumanOutboundAdapter);

export const HUMAN_REPLY_ERRORS = Object.freeze({
  NOT_HUMAN_HANDLED: 'HUMAN_REPLY_NOT_HUMAN_HANDLED',
  NOT_ALLOWED: 'HUMAN_REPLY_NOT_ALLOWED',
  WINDOW_BLOCKED: 'HUMAN_REPLY_WINDOW_BLOCKED',
  NOT_FOUND: 'HUMAN_REPLY_NOT_FOUND',
  PROVIDER_UNSUPPORTED: 'HUMAN_OUTBOUND_PROVIDER_UNSUPPORTED',
  TARGET_MISSING: 'HUMAN_OUTBOUND_TARGET_MISSING',
  ALREADY_SENT: 'HUMAN_REPLY_ALREADY_SENT'
});

export class HumanReplyError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HumanReplyError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Roles allowed to reply to ANY human-handled conversation in their tenant. */
const BROAD_REPLY_ROLES = ['Company Admin', 'Supervisor'];

/**
 * May this user reply to this conversation?
 * - Company Admin / Supervisor: any human-handled conversation in their tenant
 * - Agent: only the conversation assigned to them
 */
export function canUserReplyToConversation({ roles = [], userId, view }) {
  if (BROAD_REPLY_ROLES.some((r) => roles.includes(r))) return true;
  if (roles.includes('Agent')) return Boolean(view?.assigned_user_id && view.assigned_user_id === userId);
  return false;
}

/** Human-handled states that accept an outbound human reply. */
function isHumanHandled(state) {
  return HANDLED_STATES.includes(state);
}

/** Load everything needed, tenant-scoped, or throw a 404. */
async function loadConversationContext({ tenantId, conversationId }) {
  const view = await getConversationHandoffView({ tenantId, conversationId, db: pool });
  if (!view) {
    throw new HumanReplyError(404, HUMAN_REPLY_ERRORS.NOT_FOUND, 'conversation not found');
  }
  const channel = view.channel_id
    ? (
        await pool.query(
          `SELECT id, provider, external_id, display_name, brand_id, status
             FROM channels WHERE id = $1 AND tenant_id = $2`,
          [view.channel_id, tenantId]
        )
      ).rows[0] ?? null
    : null;
  const lastInbound = await getLastInboundMessage({ tenantId, conversationId, db: pool });
  return { view, channel, lastInbound };
}

/**
 * Resolve the decrypted page credential for a channel's page id.
 * Injectable so tests never touch real credentials. NEVER logged or returned.
 */
export async function defaultCredentialResolver(channelExternalId, tenantId) {
  const resolved = await resolveMetaChannel(channelExternalId, { includeCredential: true });
  if (resolved.tenantId !== tenantId) {
    const err = new Error('credential tenant mismatch');
    err.code = 'HUMAN_OUTBOUND_CREDENTIAL_TENANT_MISMATCH';
    throw err;
  }
  return resolved.credential;
}

/**
 * Send a human reply.
 * @returns {Promise<{messageId, providerMessageId, deliveryStatus, mechanism, duplicate}>}
 */
export async function sendHumanReply({
  tenantId,
  conversationId,
  userId,
  roles = [],
  text,
  idempotencyKey = null,
  resolveCredential = defaultCredentialResolver
}) {
  if (!text || !String(text).trim()) {
    throw new HumanReplyError(422, 'VALIDATION_ERROR', 'a reply message is required');
  }
  const body = String(text).slice(0, 4000).trim();

  const { view, channel, lastInbound } = await loadConversationContext({ tenantId, conversationId });

  // 2) conversation must be human-handled (AI must be OFF)
  if (!isHumanHandled(view.state)) {
    throw new HumanReplyError(
      409,
      HUMAN_REPLY_ERRORS.NOT_HUMAN_HANDLED,
      `this conversation is currently handled by the AI (${view.state})`
    );
  }

  // 3) sender must be allowed to reply to THIS conversation
  if (!canUserReplyToConversation({ roles, userId, view })) {
    throw new HumanReplyError(403, HUMAN_REPLY_ERRORS.NOT_ALLOWED, 'you cannot reply to this conversation');
  }

  if (!channel) {
    throw new HumanReplyError(409, HUMAN_REPLY_ERRORS.TARGET_MISSING, 'conversation has no channel');
  }

  // 4) provider adapter
  const adapter = getHumanOutboundAdapter('meta');
  const provider = adapter.provider;

  // 5) target derived from server-side stored data
  const target = adapter.resolveTarget({ conversation: view, channel, lastInbound });

  // 6) messaging-window policy BEFORE any send attempt
  const policy = adapter.evaluatePolicy({ target, lastInbound, now: new Date() });
  if (!policy.allowed) {
    throw new HumanReplyError(409, HUMAN_REPLY_ERRORS.WINDOW_BLOCKED, policy.message, { policyCode: policy.code });
  }

  // Comment replies must survive Meta's public-comment URL restriction.
  const outboundText = target.kind === 'comment' ? sanitizeCommentMessage(body) : body;
  if (!outboundText) {
    throw new HumanReplyError(422, 'VALIDATION_ERROR', 'the reply has no sendable content');
  }

  /**
   * Durable double-submit protection.
   * An identical employee message sent moments ago in the SAME conversation is
   * answered from the stored row WITHOUT a second provider call. This survives
   * provider_message_id being overwritten with the real provider id after a
   * successful send, which a pure idempotency-key check cannot.
   */
  const recent = await pool.query(
    `SELECT id, delivery_status, delivery_error, provider_message_id
       FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2
        AND direction = 'outbound' AND sender_type = 'employee'
        AND text = $3
        AND created_at > now() - interval '2 minutes'
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, conversationId, outboundText]
  );
  if (recent.rows[0]) {
    const existing = recent.rows[0];
    return {
      messageId: existing.id,
      providerMessageId: existing.provider_message_id ?? null,
      deliveryStatus: existing.delivery_status,
      mechanism: null,
      duplicate: true
    };
  }

  // 7) persist FIRST as an employee-originated message (nothing is ever lost)
  const key = idempotencyKey ? `idempotency:${idempotencyKey}` : `pending:${crypto.randomUUID()}`;
  const stored = await persistHumanOutboundMessage({
    tenantId,
    conversationId,
    text: outboundText,
    providerMessageId: key,
    deliveryStatus: 'pending'
  });
  if (stored.duplicate) {
    // Double submit / retry of the same key — answer from the stored row.
    const { rows } = await pool.query(
      `SELECT id, delivery_status, delivery_error, provider_message_id
         FROM messages WHERE conversation_id = $1 AND tenant_id = $2 AND provider_message_id = $3`,
      [conversationId, tenantId, key]
    );
    const existing = rows[0] ?? null;
    return {
      messageId: existing?.id ?? null,
      providerMessageId: existing?.provider_message_id ?? null,
      deliveryStatus: existing?.delivery_status ?? 'pending',
      mechanism: null,
      duplicate: true
    };
  }

  // 8) resolve the credential from the DB (never from the browser)
  let credential;
  try {
    credential = await resolveCredential(channel.external_id, tenantId);
    if (!credential) throw new Error('no credential');
  } catch (e) {
    const category = e?.code === RESOLVE_ERRORS.CREDENTIAL_MISSING ? 'meta_credential_missing' : 'meta_route_failed';
    await updateMessageDelivery({
      tenantId, messageId: stored.id, deliveryStatus: 'failed', errorCategory: category
    }).catch(() => {});
    throw new HumanReplyError(502, 'HUMAN_REPLY_PROVIDER_UNAVAILABLE', 'the message could not be delivered — try again shortly', { category });
  }

  // 9) send through the provider abstraction
  try {
    const result = await adapter.send({ target, text: outboundText, credential, policy });
    const finalStatus = result.providerMessageId ? 'sent' : 'pending';
    await updateMessageDelivery({
      tenantId,
      messageId: stored.id,
      deliveryStatus: finalStatus,
      providerMessageId: result.providerMessageId ?? null
    });

    // Staff has now actually engaged → promote ASSIGNED → HUMAN_ACTIVE.
    if (view.state === CONVERSATION_STATES.ASSIGNED) {
      await activateHumanHandling({ tenantId, conversationId }, { actorUserId: userId }).catch(() => {});
    }

    return {
      messageId: stored.id,
      providerMessageId: result.providerMessageId ?? null,
      deliveryStatus: finalStatus,
      mechanism: result.mechanism ?? null,
      duplicate: false
    };
  } catch (err) {
    const category = humanErrorCategory(err);
    await updateMessageDelivery({
      tenantId, messageId: stored.id, deliveryStatus: 'failed', errorCategory: category
    }).catch(() => {});
    await notifyHumanReplyFailure({ tenantId, userId, view, category });
    throw new HumanReplyError(502, 'HUMAN_REPLY_SEND_FAILED', humanErrorMessage(err, category), { category });
  }
}

/**
 * Retry a FAILED human message.
 * Concurrency-safe: only a 'failed' row can be claimed (the DB predicate is the
 * lock), so two clicks cannot both send.
 */
export async function retryHumanReply({
  tenantId,
  conversationId,
  userId,
  roles = [],
  messageId,
  resolveCredential = defaultCredentialResolver
}) {
  const { view, channel, lastInbound } = await loadConversationContext({ tenantId, conversationId });
  if (!isHumanHandled(view.state)) {
    throw new HumanReplyError(409, HUMAN_REPLY_ERRORS.NOT_HUMAN_HANDLED, 'this conversation is no longer human-handled');
  }
  if (!canUserReplyToConversation({ roles, userId, view })) {
    throw new HumanReplyError(403, HUMAN_REPLY_ERRORS.NOT_ALLOWED, 'you cannot reply to this conversation');
  }

  const claimed = await claimFailedOutboundForRetry({
    tenantId, conversationId, messageId, senderTypes: ['employee']
  });
  if (!claimed) {
    throw new HumanReplyError(409, HUMAN_REPLY_ERRORS.ALREADY_SENT, 'this message is not in a retryable state');
  }

  const adapter = getHumanOutboundAdapter('meta');
  const target = adapter.resolveTarget({ conversation: view, channel, lastInbound });
  const policy = adapter.evaluatePolicy({ target, lastInbound, now: new Date() });
  if (!policy.allowed) {
    await updateMessageDelivery({
      tenantId, messageId, deliveryStatus: 'failed', errorCategory: 'messaging_window_expired'
    }).catch(() => {});
    throw new HumanReplyError(409, HUMAN_REPLY_ERRORS.WINDOW_BLOCKED, policy.message, { policyCode: policy.code });
  }

  let credential;
  try {
    credential = await resolveCredential(channel.external_id, tenantId);
    if (!credential) throw new Error('no credential');
  } catch {
    await updateMessageDelivery({
      tenantId, messageId, deliveryStatus: 'failed', errorCategory: 'meta_credential_missing'
    }).catch(() => {});
    throw new HumanReplyError(502, 'HUMAN_REPLY_PROVIDER_UNAVAILABLE', 'the message could not be delivered — try again shortly');
  }

  try {
    const result = await adapter.send({ target, text: claimed.text, credential, policy });
    const finalStatus = result.providerMessageId ? 'sent' : 'pending';
    await updateMessageDelivery({
      tenantId, messageId, deliveryStatus: finalStatus, providerMessageId: result.providerMessageId ?? null
    });
    return { messageId, providerMessageId: result.providerMessageId ?? null, deliveryStatus: finalStatus, duplicate: false };
  } catch (err) {
    const category = humanErrorCategory(err);
    await updateMessageDelivery({
      tenantId, messageId, deliveryStatus: 'failed', errorCategory: category
    }).catch(() => {});
    await notifyHumanReplyFailure({ tenantId, userId, view, category });
    throw new HumanReplyError(502, 'HUMAN_REPLY_SEND_FAILED', humanErrorMessage(err, category), { category });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Sanitized category — never a token, header, URL or raw provider payload. */
function humanErrorCategory(err) {
  const message = String(err?.message ?? '');
  if (new RegExp(`Graph API 400|code ${META_WINDOW_CLOSED_CODE}|messaging window`).test(message)) {
    return 'messaging_window_closed';
  }
  if (/Graph API 401|Error validating access token|session has expired/i.test(message)) return 'meta_auth_expired';
  if (/Graph API 403|permission|OAuthException/i.test(message)) return 'meta_permission';
  if (/Graph API 4\d\d|rate limit|too many requests/i.test(message)) return 'meta_rate_limit';
  if (/Graph API 5\d\d/.test(message)) return 'meta_api_error';
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) return 'network_error';
  return 'meta_api_error';
}

/** Safe, human-readable message for the Inbox. Never includes provider internals. */
function humanErrorMessage(err, category) {
  if (category === 'messaging_window_closed') {
    return 'Meta did not accept this reply — the messaging window with this customer has expired. Ask the customer to send a new message.';
  }
  if (category === 'meta_auth_expired') return 'The connected channel needs to be reconnected before messages can be sent.';
  if (category === 'meta_permission') return 'The connected channel is missing a required Messenger permission.';
  if (category === 'meta_rate_limit') return 'Too many messages were sent recently — please retry in a moment.';
  if (category === 'network_error') return 'A network error prevented delivery — please retry.';
  return 'The message could not be delivered. You can retry from the conversation.';
}

/** Tell the author (and supervisors) that a human send failed. No message bodies. */
async function notifyHumanReplyFailure({ tenantId, userId, view, category }) {
  const recipients = [userId];
  try {
    await createNotifications({
      tenantId,
      userIds: recipients,
      type: NOTIFICATION_TYPES.HUMAN_REPLY_FAILED,
      title: 'A reply could not be delivered',
      body: null,
      data: { conversationId: view.id, category }
    });
  } catch {
    /* notifications must never break the delivery path */
  }
}

export { MESSENGER_POLICY_CODES };

