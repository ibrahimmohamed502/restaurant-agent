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
  DLQ: 'dlq'
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
  JOB_EXHAUSTED: 'JOB_EXHAUSTED'
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
  const sets = ['status = $3', 'processed_at = CASE WHEN $3 IN (\'done\',\'failed\',\'dlq\') THEN now() ELSE processed_at END', 'error = $4'];
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
 *   - 'done'       -> never claimed.
 *
 * Returns the claimed row, or null when the claim was refused (another worker
 * won it, or it is in progress / already complete). A null result MUST NOT be
 * processed.
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
export async function claimStaleWebhookEvents({ olderThanSeconds = 120, limit = 10, maxRedispatches = 5 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 10, 50));
  const older = Math.max(1, Number(olderThanSeconds) || 120);
  const maxAttempts = Math.max(0, Number(maxRedispatches) || 0);
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