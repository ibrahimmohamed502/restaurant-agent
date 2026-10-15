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
import {
  claimWebhookEventForProcessing,
  updateWebhookEvent,
  claimStaleWebhookEvents,
  recordRedispatch
} from '../services/webhookEvents.js';
import { enqueueMetaEvent } from '../queues/metaEvents.js';
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
 * Replay intake rows that were recorded but NEVER started processing.
 *
 * Crash between the intake INSERT and the queue add leaves a row in
 * 'received'. Those rows are claimed atomically (status guard), so exactly one
 * sweeper can ever take a given row.
 *
 * Deliberate safety rules:
 *   - only rows still in 'received' are ever replayed; a row that reached
 *     'processing' may already have produced side effects, so it is never
 *     auto-replayed (an operator reviews it instead);
 *   - the terminal status is written on both paths, so a row cannot be claimed
 *     twice;
 *   - bounded by the claim query's limit; there is no retry loop here.
 */
export async function redispatchStaleIntakes(rows, deps = {}) {
  const { enqueue = enqueueMetaEvent, record = recordRedispatch } = deps;

  const results = [];
  for (const row of rows ?? []) {
    const { provider = 'meta', external_id: eventId, redispatches = 0 } = row ?? {};
    if (!provider || !eventId) continue;
    try {
      // Only identity is needed: the job id is deterministic, so re-adding a
      // job that is still waiting/active/delayed is a no-op and a lost job is
      // restored. NOTHING about the customer event is processed here.
      await enqueue({ provider, eventId, eventType: 'unknown', pageId: null, receivedAt: row?.received_at });
      await record(provider, eventId, Number(redispatches) + 1);
      results.push({ eventId, redispatched: true });
    } catch {
      // Queue still unavailable: leave the row untouched so the next sweep can
      // try again, bounded by the sweep's own limits.
      results.push({ eventId, redispatched: false });
    }
  }
  return results;
}

/**
 * Process one queued Meta event end-to-end. Throws on failure (BullMQ retries).
 * `deps` is an injection point for tests; production uses the real modules.
 */
export async function processQueuedMetaEvent(job, deps = {}) {
  const {
    claim = claimWebhookEventForProcessing,
    updateEvent = updateWebhookEvent,
    buildCtx = buildRouteContext,
    onComment = processComment,
    onMessage = processMessage,
    pgEnabled = enabled
  } = deps;

  const { provider = 'meta', eventId } = job ?? {};

  // ATOMIC CLAIM. Two workers racing for the same event produce exactly one
  // winner; the loser gets null and must not process anything. Rows that are
  // 'processing' (in flight, or died mid-flight) and 'done' are never claimed,
  // so a partially applied event is never replayed automatically.
  const row = await claim({ provider, externalId: eventId });
  if (!row) return { skipped: 'not_claimed' };

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

  // The claim already set 'processing'; only the resolved tenant is added.
  await updateEvent({ provider, externalId: eventId, status: 'processing', tenantId: ctx.tenantId });

  try {
    if (normalized.eventType === 'message') {
      await onMessage(normalized.rawMessaging, ctx, { pgEnabled });
    } else {
      await onComment(normalized.rawChange?.value, ctx, { pgEnabled });
    }
  } catch (err) {
    const category = deliveryErrorCategory(err) ?? 'processing_error';
    // 'failed' is a TERMINAL marker for that ATTEMPT only: the atomic claim
    // accepts 'failed', so BullMQ's next attempt runs again. The attempt budget
    // is BullMQ's (attempts: 3), and message-level dedupe guarantees a single
    // outbound reply even if an earlier attempt half-finished. A worker that
    // dies mid-flight leaves 'processing' instead, which is never auto-claimed.
    await updateEvent({ provider, externalId: eventId, status: 'failed', error: category });
    console.error(`❌ processing failed for ${eventId} [${category}]`);
    throw err; // let BullMQ apply bounded retries
  }

  await updateEvent({ provider, externalId: eventId, status: 'done' });
  return { ok: true, eventType: normalized.eventType };
}
