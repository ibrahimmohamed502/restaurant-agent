/**
 * Queued-event pipeline (Stage 4 completion).
 *
 * Runs inside the worker process. Re-resolves routing context + credential from
 * the database at processing time (never trusts the job payload), then reuses
 * the SAME processing functions as the inline webhook path so behavior is
 * functionally identical: scoped AI, grounding guard, persist-first,
 * delivery_status, one plain reply, manual-retry compatibility.
 */
import { buildRouteContext } from '../services/routeContext.js';
import { processComment, processMessage } from '../webhook.js';
import { normalizeMetaComment, normalizeMetaMessage } from '../providers/meta/normalizer.js';
import { getWebhookEvent, updateWebhookEvent } from '../services/webhookEvents.js';
import { deliveryErrorCategory } from '../services/conversations.js';
import { enabled } from '../db/pg.js';

/** Rebuild a normalized event from the persisted webhook_events payload. */
export function normalizedFromPayload(payload) {
  const base = {
    provider: 'meta',
    pageId: String(payload?.pageId ?? payload?.entry?.id ?? ''),
    conversationKey: payload?.conversationKey,
    actor: payload?.actor ?? { id: '', name: null },
    receivedAt: payload?.receivedAt ?? new Date().toISOString()
  };
  if (payload?.eventType === 'comment') {
    return { ...base, ...normalizeMetaComment(payload.entry, payload.change), rawEntry: payload.entry, rawChange: payload.change, rawMessaging: null };
  }
  return { ...base, ...normalizeMetaMessage(payload.entry, payload.messaging), rawEntry: payload.entry, rawChange: null, rawMessaging: payload.messaging };
}

/**
 * Process one queued Meta event end-to-end. Throws on failure (BullMQ retries).
 * `deps` is an injection point for tests; production uses the real modules.
 */
export async function processQueuedMetaEvent(job, deps = {}) {
  const {
    getEvent = getWebhookEvent,
    updateEvent = updateWebhookEvent,
    buildCtx = buildRouteContext,
    onComment = processComment,
    onMessage = processMessage,
    pgEnabled = enabled
  } = deps;

  const { provider = 'meta', eventId } = job ?? {};
  const row = await getEvent(provider, eventId);
  if (!row) throw new Error('webhook event not found');

  // Idempotency: a completed event is never processed twice.
  if (row.status === 'done') return { skipped: 'already_done' };

  const normalized = normalizedFromPayload(row.payload);

  // Re-resolve routing + credential from the DB (fail-closed codes are terminal).
  let ctx;
  try {
    ctx = await buildCtx({ id: normalized.pageId });
  } catch (err) {
    await updateEvent({ provider, externalId: eventId, status: 'failed', error: err?.code ?? 'ROUTING_FAILED' });
    console.warn(`⛔ [${normalized.pageId}] routing failed for event ${eventId}: ${err?.code ?? 'RESOLVE_FAILED'}`);
    return { skipped: 'routing_failed' };
  }

  await updateEvent({ provider, externalId: eventId, status: 'processing', tenantId: ctx.tenantId });

  try {
    if (normalized.eventType === 'message') {
      await onMessage(normalized.rawMessaging, ctx, { pgEnabled });
    } else {
      await onComment(normalized.rawChange?.value, ctx, { pgEnabled });
    }
  } catch (err) {
    const category = deliveryErrorCategory(err) ?? 'processing_error';
    // 'failed' is a TRANSIENT marker here: the pipeline only short-circuits on
    // 'done', so BullMQ's next attempt still runs (and message-level dedupe
    // guarantees a single outbound reply even if an earlier attempt half-finished).
    await updateEvent({ provider, externalId: eventId, status: 'failed', error: category });
    console.error(`❌ processing failed for ${eventId} [${category}]`);
    throw err; // let BullMQ apply bounded retries
  }

  await updateEvent({ provider, externalId: eventId, status: 'done' });
  return { ok: true, eventType: normalized.eventType };
}
