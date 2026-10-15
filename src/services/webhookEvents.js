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

/** Error codes written to `webhook_events.error` (sanitized, never raw text). */
export const WEBHOOK_ERROR = {
  ENQUEUE_FAILED_INLINE: 'ENQUEUE_FAILED_INLINE',
  INLINE_FAILED: 'INLINE_FAILED',
  STALE_REPLAY: 'STALE_REPLAY',
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
 * Claim intake rows that were recorded but NEVER started processing (still
 * 'received'), e.g. the API died between the INSERT and the queue add.
 *
 * Claiming is a single atomic UPDATE guarded on `status = 'received'`, so two
 * concurrent sweeps can never claim the same row. Rows already in 'processing'
 * are deliberately NOT claimed: their side effects may be partially applied and
 * replaying them could produce a duplicate outbound reply.
 *
 * Bounded by `limit` and `olderThanSeconds`; never loops.
 */
export async function claimStaleWebhookEvents({ olderThanSeconds = 120, limit = 10 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 10, 50));
  const { rows } = await pool.query(
    `UPDATE webhook_events
        SET status = 'processing', error = $1
      WHERE id IN (
        SELECT id FROM webhook_events
         WHERE status = 'received'
           AND received_at < now() - ($2 || ' seconds')::interval
         ORDER BY received_at ASC
         LIMIT $3
      )
     RETURNING id, provider, external_id, payload, received_at`,
    [WEBHOOK_ERROR.STALE_REPLAY, String(Math.max(1, Number(olderThanSeconds) || 120)), capped]
  );
  return rows;
}