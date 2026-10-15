/**
 * webhook_events — provider event intake + idempotency.
 *
 * Uses the existing `webhook_events` table (provider, external_id) UNIQUE as the
 * provider-level dedupe gate, on top of the message-level unique constraint that
 * already protects conversations/messages. Never stores credentials.
 *
 * The intake ROW is the idempotency record. It is never deleted on an error
 * path: removing it would re-open the unique slot and let a concurrent Meta
 * redelivery be processed a second time (which, on the inline path, means a
 * duplicate AI reply). Errors are expressed through `status` + `error` instead.
 */
import { pool } from '../db/pg.js';

/** Statuses the column already models (see migrations/001_init.sql). */
export const WEBHOOK_STATUS = {
  RECEIVED: 'received',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
  DLQ: 'dlq',
  /**
   * An outbound Meta send was attempted and the event then failed. Whether the
   * customer received the reply is NOT knowable, so the event must never be
   * claimed again — it is deliberately absent from the claim's status list.
   * Requires operator review, never automatic replay.
   *
   * Safe without a migration: webhook_events.status has no CHECK constraint
   * (migrations/001_init.sql — the status comment is documentation only).
   */
  UNKNOWN: 'unknown'
};

/** Prefix used to count re-dispatch attempts on a stranded row. */
export const REDISPATCH_PREFIX = 'REDISPATCHED:';
/** Regex that extracts the counter; also the SQL pattern used in the claim. */
export const REDISPATCH_PATTERN = '^REDISPATCHED:([0-9]+)$';

/** Error codes written to `webhook_events.error` (sanitized, never raw text). */
export const WEBHOOK_ERROR = {
  ENQUEUE_FAILED_INLINE: 'ENQUEUE_FAILED_INLINE',
  INLINE_FAILED: 'INLINE_FAILED',
  ROUTING_FAILED: 'ROUTING_FAILED',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  JOB_EXHAUSTED: 'JOB_EXHAUSTED',
  /** The event failed AFTER an outbound send was attempted (status UNKNOWN). */
  OUTBOUND_ATTEMPTED: 'OUTBOUND_ATTEMPTED',
  /** A stranded intake row reached the re-dispatch cap and needs a human. */
  REDISPATCH_EXHAUSTED: 'REDISPATCH_EXHAUSTED'
};

/** Record an intake event. Returns the created row, or null when it is a duplicate. */
export async function recordWebhookEvent(event) {
  const payload = {
    eventType: event.eventType,
    pageId: event.pageId,
    conversationKey: event.conversationKey,
    actor: event.actor,
    receivedAt: event.receivedAt,
    entry: event.rawEntry ?? null,
    change: event.rawChange ?? null,
    messaging: event.rawMessaging ?? null
  };
  const { rows } = await pool.query(
    `INSERT INTO webhook_events (provider, external_id, payload, status)
     VALUES ($1,$2,$3,'received')
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id, status`,
    [event.provider, event.eventId, JSON.stringify(payload)]
  );
  return rows[0] ?? null;
}

export async function getWebhookEvent(provider, externalId) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, status, error, payload, received_at FROM webhook_events WHERE provider = $1 AND external_id = $2`,
    [provider, externalId]
  );
  return rows[0] ?? null;
}

/** Update processing state. `error` must be a sanitized category, never raw text. */
export async function updateWebhookEvent({ provider, externalId, status, tenantId = undefined, error = null }) {
  // 'unknown' is terminal-for-retry too: processed_at lets the stranded-event
  // report age these rows even though they are still claimable-looking.
  const sets = ['status = $3', 'processed_at = CASE WHEN $3 IN (\'done\',\'failed\',\'dlq\',\'unknown\') THEN now() ELSE processed_at END', 'error = $4'];
  const params = [provider, externalId, status, error];
  if (tenantId) {
    sets.push('tenant_id = $5');
    params.push(tenantId);
  }
  const { rows } = await pool.query(
    `UPDATE webhook_events SET ${sets.join(', ')} WHERE provider = $1 AND external_id = $2 RETURNING id, status, tenant_id`,
    params
  );
  return rows[0] ?? null;
}

/**
 * Mark an intake row as being handled INLINE (the queue could not take it).
 *
 * The row is never deleted: it is the idempotency record that stops a
 * concurrent redelivery from producing a second reply.
 */
export async function markWebhookEventInline(provider, externalId) {
  return updateWebhookEvent({
    provider,
    externalId,
    status: WEBHOOK_STATUS.PROCESSING,
    error: WEBHOOK_ERROR.ENQUEUE_FAILED_INLINE
  });
}

/**
 * ATOMIC PROCESSING CLAIM — the single gate that decides who may run the
 * business logic for an event.
 *
 * The decision is made by the database in one conditional UPDATE, so it cannot
 * be won by a read-then-write race between two workers:
 *
 *   - 'received'   -> first attempt;
 *   - 'failed'     -> bounded retry of an attempt that terminated (BullMQ owns
 *                     the attempt budget, attempts: 3);
 *   - 'processing' -> an attempt is in flight, or died mid-flight. NEVER claimed
 *                     automatically: its side effects are unknown, so replaying
 *                     it could send a second reply to the customer;
 *   - 'done'       -> never claimed;
 *   - 'unknown'     -> an outbound send was already attempted for this event.
 *                      Whether the customer received the reply is unknowable, so
 *                      re-processing could send a second copy. Never claimed.
 *
 * Returns the claimed row, or null when the claim was refused (another worker
 * won it, or it is in progress / unknown / already complete). A null result MUST
 * NOT be processed.
 */
export async function claimWebhookEventForProcessing({ provider, externalId, tenantId = null } = {}) {
  if (!provider || !externalId) return null;
  const { rows } = await pool.query(
    `UPDATE webhook_events
        SET status = 'processing',
            error = NULL,
            tenant_id = COALESCE($3, tenant_id)
      WHERE provider = $1
        AND external_id = $2
        AND status IN ('received', 'failed')
      RETURNING id, status, tenant_id, payload, error`,
    [provider, externalId, tenantId]
  );
  return rows[0] ?? null;
}

/**
 * Find intake rows that were recorded but never started (still 'received'), so
 * they can be RE-DISPATCHED to the queue.
 *
 * The sweeper NEVER processes customer events itself: it only puts the job back
 * on the queue, so the worker stays the single processor. Because the job id is
 * a deterministic function of (provider, external_id), re-adding a job that is
 * still waiting/active/delayed is a no-op and one that was lost is restored.
 *
 * The status is intentionally NOT changed here: the row must stay 'received'
 * so the worker's atomic claim is the only thing that can start processing.
 * Re-dispatch is capped so an unavailable queue cannot loop forever.
 */
/**
 * Default re-dispatch cap. A stranded row that reaches it is left 'received'
 * for a human and is reported by summarizeStrandedEvents().
 */
export const DEFAULT_MAX_REDISPATCHES = 5;

export async function claimStaleWebhookEvents({ olderThanSeconds = 120, limit = 10, maxRedispatches = DEFAULT_MAX_REDISPATCHES } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 10, 50));
  const older = Math.max(1, Number(olderThanSeconds) || 120);
  const maxAttempts = Math.max(0, Number(maxRedispatches) ?? DEFAULT_MAX_REDISPATCHES);
  const { rows } = await pool.query(
    `UPDATE webhook_events
        SET error = COALESCE(error, $1)
      WHERE id IN (
        SELECT id FROM webhook_events
         WHERE status = 'received'
           AND received_at < now() - ($2 || ' seconds')::interval
           AND COALESCE((regexp_match(COALESCE(error, ''), $3))[1]::int, 0) < $4
         ORDER BY received_at ASC
         LIMIT $5
      )
     RETURNING id, provider, external_id, payload, received_at,
               COALESCE((regexp_match(COALESCE(error, ''), $3))[1]::int, 0) AS redispatches`,
    [`${REDISPATCH_PREFIX}0`, String(older), REDISPATCH_PATTERN, maxAttempts, capped]
  );
  return rows;
}

/** Count one re-dispatch attempt. Never changes the status. */
export async function recordRedispatch(provider, externalId, attempt = 1) {
  await pool.query(
    `UPDATE webhook_events
        SET error = $3
      WHERE provider = $1 AND external_id = $2 AND status = 'received'`,
    [provider, externalId, `${REDISPATCH_PREFIX}${Math.max(1, Number(attempt) || 1)}`]
  );
}

/**
 * Operational snapshot of events that need a human.
 *
 * Three failure modes are silent by design — nothing throws and nothing alerts
 * — so they are surfaced explicitly here instead:
 *
 *   stuck_processing : a worker died mid-flight. Deliberately never reclaimed,
 *                      because the outbound side effects are unknown.
 *   unknown_delivery : an outbound send was attempted and the event then failed.
 *                      The customer may or may not have received the reply.
 *   redispatch_capped: a stranded intake row hit the re-dispatch cap. It will
 *                      never be retried automatically again.
 *
 * Read-only, aggregate counts only — never event payloads or customer data.
 */
export async function summarizeStrandedEvents({ olderThanSeconds = 900 } = {}) {
  const older = Math.max(60, Number(olderThanSeconds) || 900);
  const { rows } = await pool.query(
    `SELECT
        status,
        COUNT(*)::int AS total,
        -- Age by the newest meaningful milestone. A row stuck in 'processing'
        -- never has processed_at set, so measuring only that would report the
        -- most urgent rows as fresh. received_at is the fallback.
        COUNT(*) FILTER (
          WHERE COALESCE(processed_at, received_at) < now() - ($1 || ' seconds')::interval
        )::int AS aged
       FROM webhook_events
      WHERE status IN ('processing', 'unknown')
         OR (status = 'received' AND COALESCE((regexp_match(COALESCE(error, ''), $2))[1]::int, 0) >= $3)
      GROUP BY status
     ORDER BY status`,
    [String(older), REDISPATCH_PATTERN, DEFAULT_MAX_REDISPATCHES]
  );

  const summary = {
    stuck_processing: 0,
    unknown_delivery: 0,
    redispatch_capped: 0,
    aged_total: 0
  };
  for (const row of rows) {
    if (row.status === 'processing') summary.stuck_processing = row.total;
    if (row.status === 'unknown') summary.unknown_delivery = row.total;
    if (row.status === 'received') summary.redispatch_capped = row.total;
    summary.aged_total += row.aged;
  }
  return summary;
}

/** Total events needing human attention, for a single at-a-glance check. */
export function strandedEventTotal(summary) {
  return (
    (summary?.stuck_processing ?? 0) +
    (summary?.unknown_delivery ?? 0) +
    (summary?.redispatch_capped ?? 0)
  );
}
