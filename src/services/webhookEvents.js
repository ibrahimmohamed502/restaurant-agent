/**
 * webhook_events — provider event intake + idempotency (Stage 4 completion).
 *
 * Uses the existing `webhook_events` table (provider, external_id) UNIQUE as the
 * provider-level dedupe gate, on top of the message-level unique constraint that
 * already protects conversations/messages. Never stores credentials.
 */
import { pool } from '../db/pg.js';

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
  const sets = ['status = $3', 'processed_at = CASE WHEN $3 IN (\'done\',\'failed\') THEN now() ELSE processed_at END', 'error = $4'];
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

/** Remove an intake row (used when a job could not be enqueued and we fall back to inline). */
export async function deleteWebhookEvent(provider, externalId) {
  const { rowCount } = await pool.query(
    `DELETE FROM webhook_events WHERE provider = $1 AND external_id = $2 AND status = 'received'`,
    [provider, externalId]
  );
  return rowCount > 0;
}
