/**
 * Meta provider boundary (Stage 4 completion).
 *
 * Thin, explicit seam between raw provider structures and the internal
 * pipeline: normalization (see ./normalizer.js) + outbound delivery through
 * the existing MetaClient. No credentials are held here — the caller always
 * passes a freshly resolved, DB-decrypted credential.
 */
import { createMetaClient } from '../../facebook.js';
import { normalizeMetaComment, normalizeMetaMessage, normalizeMetaWebhook } from './normalizer.js';

/** Send an outbound reply for a normalized event using a resolved credential.
 * @param {NormalizedEvent} event
 * @param {string} text                plain reply text (no @mention — Meta rejects it)
 * @param {string} accessToken         decrypted DB credential (never logged/stored)
 */
export async function sendMetaReply(event, text, accessToken) {
  if (!accessToken) {
    const err = new Error('no Meta credential provided to provider');
    err.code = 'META_CREDENTIAL_MISSING';
    throw err;
  }
  const client = createMetaClient({ accessToken });
  if (event.eventType === 'message') {
    const resp = await client.sendMessengerReply(event.conversationKey, text);
    return resp?.message_id ?? null;
  }
  const resp = await client.replyToComment(event.conversationKey, text);
  return resp?.id ?? null;
}

export { normalizeMetaComment, normalizeMetaMessage, normalizeMetaWebhook };
