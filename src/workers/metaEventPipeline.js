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
import { createOutboundLedger } from '../services/deliveryOutcome.js';
import { WEBHOOK_STATUS, WEBHOOK_ERROR } from '../services/webhookEvents.js';
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
 * Sanitized category for a PROCESSING failure.
 *
 * This is not a delivery classification. A provider-shaped error that escaped
 * the send handler (the send handler catches its own failures) tells us only
 * that something downstream failed — never whether a reply reached the customer.
 * That question is answered by the outbound ledger, which is what actually gates
 * retries. Codes here are informational and never grant retry permission.
 */
function processingErrorCategory(err) {
  const msg = String(err?.message ?? '');
  if (/Graph API 401|validating access token|session has expired/i.test(msg)) return 'meta_auth_expired';
  if (/Graph API 403|permission|OAuthException/i.test(msg)) return 'meta_permission';
  if (/Graph API 4\d\d|rate limit|too many requests/i.test(msg)) return 'meta_rate_limit';
  if (/Graph API 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(msg)) return 'meta_api_error';
  const code = err?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  return 'processing_error';
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

  // The processor fills this in to report whether an irreversible Meta send was
  // started. It is created here, owned by the worker, and never read from the
  // job payload.
  const ledger = createOutboundLedger();

  try {
    if (normalized.eventType === 'message') {
      await onMessage(normalized.rawMessaging, ctx, { pgEnabled, ledger });
    } else {
      await onComment(normalized.rawChange?.value, ctx, { pgEnabled, ledger });
    }
  } catch (err) {
    // ---- RETRY-STATE POLICY -------------------------------------------------
    // Once an outbound send has been ATTEMPTED, whether the customer already
    // received the reply is not knowable from here. The event is therefore moved
    // to 'unknown', a status claimWebhookEventForProcessing does NOT accept, so
    // BullMQ's retry is refused BY THE DATABASE rather than by a try/catch inside
    // the processor. The guarantee is structural: it holds no matter what the
    // processor, a library below it, or a future refactor happens to throw.
    if (ledger.started) {
      await updateEvent({
        provider,
        externalId: eventId,
        status: WEBHOOK_STATUS.UNKNOWN,
        error: WEBHOOK_ERROR.OUTBOUND_ATTEMPTED
      });
      console.error(
        `❌ processing failed for ${eventId} AFTER an outbound attempt [${ledger.outcome ?? 'attempted'}] — not retried automatically`
      );
      throw err; // BullMQ retries, but the atomic claim refuses the row
    }

    // Nothing was sent, so replaying this attempt is safe. 'failed' is a
    // TERMINAL marker for this attempt only: the claim accepts 'failed', and
    // BullMQ owns the attempt budget (attempts: 3). A worker that dies
    // mid-flight leaves 'processing', which is never auto-claimed.
    //
    // The category here is INFORMATIONAL ONLY. Retry safety is decided by the
    // ledger above, never by this string. It deliberately does NOT reuse the
    // delivery classifier: 'delivery_unknown' describes the state of an outbound
    // send, and saying it here would imply a message was in flight when none was.
    const category = processingErrorCategory(err);
    await updateEvent({ provider, externalId: eventId, status: 'failed', error: category });
    console.error(`❌ processing failed for ${eventId} [${category}]`);
    throw err; // let BullMQ apply bounded retries
  }

  await updateEvent({ provider, externalId: eventId, status: 'done' });
  return { ok: true, eventType: normalized.eventType };
}
