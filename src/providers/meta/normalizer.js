/**
 * Normalized internal event model (Stage 4 completion).
 *
 * The core processing layer works with this shape instead of raw provider
 * payloads (Facebook comment / Messenger messaging). Extensible for future
 * providers (Instagram, WhatsApp, webchat) — those normalizers can be added
 * next to the Meta one without touching the pipeline.
 *
 * NOTE: never put credentials/tokens in an event. Tenant/channel/credential are
 * always RE-RESOLVED from the database at processing time.
 */

export const PROVIDERS = { meta: 'meta' };

/**
 * @typedef {Object} NormalizedEvent
 * @property {string} provider          'meta' (extensible)
 * @property {string} eventId           provider event id (comment id / message mid) — idempotency key
 * @property {'comment'|'message'} eventType
 * @property {string} pageId            Meta Page ID
 * @property {string} conversationKey   thread identity (parent/comment id, or PSID for DMs)
 * @property {{id:string,name:?string}} actor
 * @property {string} text
 * @property {Array<object>} attachments
 * @property {string} receivedAt        ISO timestamp
 * @property {object} raw               original provider payload (safe subset + full entry)
 * @property {object} rawEntry          the raw webhook entry object
 * @property {?object} rawChange        raw change object for feed events
 * @property {?object} rawMessaging     raw messaging object for DM events
 */

/** Build a normalized event from a raw Meta webhook entry + change (comment). */
export function normalizeMetaComment(entry, change) {
  const v = change?.value ?? {};
  const commentId = v.comment_id;
  const parentId = v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null;
  return {
    provider: PROVIDERS.meta,
    eventId: commentId,
    eventType: 'comment',
    pageId: String(entry?.id ?? ''),
    conversationKey: parentId ?? commentId,
    actor: { id: String(v.from?.id ?? ''), name: v.from?.name ?? null },
    text: v.message ?? '',
    attachments: [],
    receivedAt: new Date().toISOString(),
    rawEntry: entry,
    rawChange: change,
    rawMessaging: null
  };
}

/** Build a normalized event from a raw Meta webhook entry + messaging object (DM). */
export function normalizeMetaMessage(entry, messaging) {
  const mid = messaging?.message?.mid ?? null;
  const psid = String(messaging?.sender?.id ?? '');
  return {
    provider: PROVIDERS.meta,
    eventId: mid ?? `${psid}:${messaging?.timestamp ?? ''}`,
    eventType: 'message',
    pageId: String(entry?.id ?? ''),
    conversationKey: psid,
    actor: { id: psid, name: null },
    text: messaging?.message?.text ?? '',
    attachments: Array.isArray(messaging?.message?.attachments) ? messaging.message.attachments : [],
    receivedAt: new Date().toISOString(),
    rawEntry: entry,
    rawChange: null,
    rawMessaging: messaging
  };
}

/**
 * Normalize a raw Meta webhook payload into internal events.
 * Applies the same eligibility filters the inline path uses (comments only,
 * non-echo DMs, etc.). Returns [] for non-page/irrelevant payloads.
 */
export function normalizeMetaWebhook(body) {
  if (!body || body.object !== 'page') return [];
  const out = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change?.field !== 'feed') continue;
      const v = change?.value;
      if (v?.item !== 'comment' || v?.verb !== 'add') continue; // same filter as inline path
      if (!v?.comment_id || !v?.from?.id) continue;
      out.push(normalizeMetaComment(entry, change));
    }
    for (const messaging of entry.messaging ?? []) {
      const msg = messaging?.message;
      if (!msg || msg.is_echo || msg.delivery || msg.read) continue; // same filter as inline path
      const psid = messaging?.sender?.id;
      if (!psid || !msg.mid) continue;
      out.push(normalizeMetaMessage(entry, messaging));
    }
  }
  return out;
}
