import { pool } from '../db/pg.js';
import crypto from 'node:crypto';

/**
 * Conversation persistence service (Stage 3).
 * Every inbound/outbound message is stored as: customer → conversation → messages.
 * Channels auto-provision per page id (multi-page ready).
 * All functions are best-effort: callers wrap in try/catch so persistence never breaks replies.
 */

let tenantCache = null;
const channelCache = new Map(); // `${tenantId}|${provider}|${externalId}` -> channel id

/** Single-tenant phase: the 'ufc' tenant (multi-tenant routing lands in Stage 4). */
export async function getDefaultTenantId() {
  if (tenantCache) return tenantCache;
  const { rows } = await pool.query(`SELECT id FROM tenants WHERE slug = 'ufc' LIMIT 1`);
  tenantCache = rows[0]?.id ?? null;
  return tenantCache;
}

export async function findOrCreateChannel({ tenantId, provider, externalId, displayName, brandId = null }) {
  if (!tenantId) throw new Error('findOrCreateChannel: tenantId required (fail closed)');
  const key = `${tenantId}|${provider}|${externalId}`;
  if (channelCache.has(key)) return channelCache.get(key);

  // Tenant-scoped lookup only — never reuse a channel owned by another tenant.
  const { rows } = await pool.query(
    `SELECT id, brand_id FROM channels WHERE tenant_id = $1 AND provider = $2 AND external_id = $3`,
    [tenantId, provider, externalId]
  );
  if (rows[0]) {
    const existing = rows[0];
    if (existing.brand_id && brandId && existing.brand_id !== brandId) {
      // Ownership mismatch — fail closed; never silently reassign a channel to another brand.
      const err = new Error(`channel ${existing.id} brand ownership mismatch (existing=${existing.brand_id}, routed=${brandId})`);
      err.code = 'CHANNEL_BRAND_MISMATCH';
      throw err;
    }
    if (!existing.brand_id && brandId) {
      // Safe one-time backfill of a previously unscoped (NULL brand) channel.
      await pool.query(`UPDATE channels SET brand_id = $1 WHERE id = $2 AND brand_id IS NULL`, [brandId, existing.id]);
    }
    channelCache.set(key, existing.id);
    return existing.id;
  }

  const { rows: [created] } = await pool.query(
    `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, brandId, provider, externalId, displayName || `${provider} ${externalId}`]
  );
  channelCache.set(key, created.id);
  return created.id;
}

export async function findOrCreateCustomer({ tenantId, provider, externalId, name }) {
  if (!tenantId) throw new Error('findOrCreateCustomer: tenantId required (fail closed)');
  // Identity lookup scoped by tenant — never reuse a customer identity from another tenant.
  const { rows } = await pool.query(
    `SELECT customer_id FROM customer_identities WHERE tenant_id = $1 AND provider = $2 AND external_id = $3`,
    [tenantId, provider, externalId]
  );
  if (rows[0]) {
    await pool.query(`UPDATE customers SET last_interaction_at = now() WHERE id = $1`, [rows[0].customer_id]);
    return rows[0].customer_id;
  }

  const { rows: [customer] } = await pool.query(
    `INSERT INTO customers (tenant_id, display_name, last_interaction_at) VALUES ($1,$2,now()) RETURNING id`,
    [tenantId, name || null]
  );
  await pool.query(
    `INSERT INTO customer_identities (tenant_id, customer_id, provider, external_id, display_name)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, customer.id, provider, externalId, name || null]
  );
  return customer.id;
}

export async function findOrCreateConversation({ tenantId, channelId, externalKey, customerId, lang }) {
  if (!tenantId) {
    const err = new Error('findOrCreateConversation: tenantId required (fail closed)');
    err.code = 'MISSING_TENANT_ID';
    throw err;
  }
  if (!channelId || !customerId || !externalKey) {
    const err = new Error('findOrCreateConversation: channelId/customerId/externalKey required (fail closed)');
    err.code = 'MISSING_CONVERSATION_CONTEXT';
    throw err;
  }
  const { rows } = await pool.query(
    `SELECT id FROM conversations WHERE tenant_id = $1 AND channel_id = $2 AND external_key = $3`,
    [tenantId, channelId, externalKey]
  );
  if (rows[0]) return rows[0].id;

  const { rows: [created] } = await pool.query(
    `INSERT INTO conversations (tenant_id, channel_id, customer_id, external_key, language, last_message_at)
     VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`,
    [tenantId, channelId, customerId, externalKey, lang || null]
  );
  return created.id;
}

export async function persistMessage({ tenantId, conversationId, direction, senderType, text, providerMessageId, providerTs }) {
  await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, provider_message_id) DO NOTHING`,
    [tenantId, conversationId, direction, senderType, text || null, providerMessageId || null, providerTs || null]
  );
  await pool.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
}

/**
 * Stage 4.4.6 — Persist the inbound customer message IMMEDIATELY (before AI / Meta).
 * Idempotent: returns null when this exact provider message was already stored
 * (Meta webhook redelivery), so callers skip the whole event.
 */
export async function persistInboundMessage({ tenantId, conversationId, senderType = 'customer', text, providerMessageId, providerTs }) {
  if (!tenantId || !conversationId || !providerMessageId) {
    const err = new Error('persistInboundMessage: tenantId/conversationId/providerMessageId required');
    err.code = 'MISSING_INBOUND_CONTEXT';
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts)
     VALUES ($1,$2,'inbound',$3,$4,$5,$6)
     ON CONFLICT (conversation_id, provider_message_id) DO NOTHING RETURNING id`,
    [tenantId, conversationId, senderType, text || null, providerMessageId, providerTs || null]
  );
  if (rows[0]) {
    await pool.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
    return { id: rows[0].id, duplicate: false };
  }
  return { id: null, duplicate: true };
}

/**
 * Stage 4.4.6 — Record an outbound (AI) message and its delivery status.
 * delivery_status: 'pending' (queued for Meta) or 'sent'/'failed' (terminal).
 * errorCategory must be a sanitized token like 'meta_auth_expired' — never a token,
 * header, raw Meta payload, or any secret.
 */
export async function persistOutboundMessage({ tenantId, conversationId, text, providerMessageId = null, providerTs = null, deliveryStatus = 'pending', errorCategory = null }) {
  if (!tenantId || !conversationId) {
    const err = new Error('persistOutboundMessage: tenantId/conversationId required');
    err.code = 'MISSING_OUTBOUND_CONTEXT';
    throw err;
  }
  if (deliveryStatus === 'sent' && errorCategory) {
    const err = new Error('persistOutboundMessage: sent status cannot carry an error');
    err.code = 'INVALID_DELIVERY_STATUS';
    throw err;
  }
  // A pending outbound row has no provider id yet → de-dupe on (conversation_id, NULL)
  // cannot rely on the unique index, so use a sentinel for NULL and conflict-guard.
  const sentinel = providerMessageId ?? `pending:${crypto.randomUUID()}`;
  const { rows } = await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts, delivery_status, delivery_error)
     VALUES ($1,$2,'outbound','ai',$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, provider_message_id) DO NOTHING RETURNING id`,
    [tenantId, conversationId, text || null, sentinel, providerTs || null, deliveryStatus, errorCategory]
  );
  if (rows[0]) {
    await pool.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
    return { id: rows[0].id, duplicate: false };
  }
  return { id: null, duplicate: true };
}

/** Stage 4.4.6 — Update an outbound message's delivery state after a Meta attempt. */
export async function updateMessageDelivery({ tenantId, messageId, deliveryStatus, providerMessageId = null, errorCategory = null }) {
  if (!tenantId || !messageId || !['pending', 'sent', 'failed'].includes(deliveryStatus)) {
    const err = new Error('updateMessageDelivery: invalid delivery update');
    err.code = 'INVALID_DELIVERY_UPDATE';
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE messages
        SET delivery_status = $1,
            delivery_error = $2,
            provider_message_id = COALESCE($3, provider_message_id)
      WHERE id = $4 AND tenant_id = $5 AND direction = 'outbound'
      RETURNING id, delivery_status, provider_message_id`,
    [deliveryStatus, errorCategory, providerMessageId, messageId, tenantId]
  );
  return rows[0] ?? null;
}

/** Stage 4.4.6 — sanitized failure categories (never raw Meta errors/tokens). */
export function deliveryErrorCategory(err) {
  const msg = String(err?.message ?? '');
  if (/Graph API 401|Error validating access token|session has expired/i.test(msg)) return 'meta_auth_expired';
  if (/Graph API 403|permission|OAuthException/i.test(msg)) return 'meta_permission';
  if (/Graph API 4\d\d|rate limit|too many requests/i.test(msg)) return 'meta_rate_limit';
  if (/Graph API 5\d\d/.test(msg)) return 'meta_api_error';
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) return 'network_error';
  return 'meta_api_error';
}

export async function createEscalationRecord({ tenantId, conversationId, category, reason, summary }) {
  await pool.query(
    `INSERT INTO escalations (tenant_id, conversation_id, category, reason, summary, priority)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, conversationId, category, reason, summary, 'normal']
  );
}

/**
 * Stage 4.4.7 — Atomically claim a FAILED outbound AI message for retry.
 * Only one caller can win the failed → pending transition (UPDATE … WHERE
 * delivery_status = 'failed' acts as the DB lock). The winner is returned to
 * the caller, which is the ONLY request allowed to perform the Meta POST.
 * Returns null when the message is not retryable (sent/pending/missing/foreign tenant).
 */
export async function claimFailedOutboundForRetry({ tenantId, conversationId, messageId }) {
  if (!tenantId || !conversationId || !messageId) {
    const err = new Error('claimFailedOutboundForRetry: tenantId/conversationId/messageId required');
    err.code = 'MISSING_RETRY_CONTEXT';
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE messages m
        SET delivery_status = 'pending',
            delivery_error = NULL,
            retry_count = m.retry_count + 1,
            last_retry_at = now()
      FROM conversations c
      WHERE m.id = $1
        AND m.conversation_id = $2
        AND c.id = m.conversation_id
        AND m.tenant_id = $3
        AND c.tenant_id = $3
        AND m.direction = 'outbound'
        AND m.sender_type = 'ai'
        AND m.delivery_status = 'failed'
      RETURNING m.id, m.conversation_id, m.tenant_id, m.text, m.retry_count, m.provider_message_id`,
    [messageId, conversationId, tenantId]
  );
  return rows[0] ?? null;
}

/** Stage 4.4.7 — terminal state update for a retry attempt. */
export async function finishMessageDelivery({ tenantId, messageId, deliveryStatus, providerMessageId = null, errorCategory = null }) {
  const { rows } = await pool.query(
    `UPDATE messages
        SET delivery_status = $1,
            delivery_error = $2,
            provider_message_id = COALESCE($3, provider_message_id)
      WHERE id = $4 AND tenant_id = $5 AND direction = 'outbound'
      RETURNING id, delivery_status, provider_message_id, delivery_error, retry_count, last_retry_at`,
    [deliveryStatus, errorCategory, providerMessageId, messageId, tenantId]
  );
  return rows[0] ?? null;
}

/** Stage 4.4.7 — sanitized lookup of a conversation + its channel (for retry context). */
export async function getConversationChannelContext({ tenantId, conversationId }) {
  const { rows } = await pool.query(
    `SELECT c.id AS conversation_id, c.tenant_id, c.external_key, ch.id AS channel_id, ch.provider, ch.external_id, ch.status
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );
  return rows[0] ?? null;
}

/** Map our Arabic reason strings to stable escalation categories. */
export function escalationCategory(reason = '') {
  if (reason.includes('شكوى')) return 'complaint';
  if (reason.includes('تعاون')) return 'collaboration';
  if (reason.includes('حجز')) return 'reservation';
  if (reason.includes('بيانات')) return 'contact_data';
  return 'other';
}
