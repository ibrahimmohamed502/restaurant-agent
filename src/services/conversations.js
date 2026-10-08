import { pool } from '../db/pg.js';

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

export async function createEscalationRecord({ tenantId, conversationId, category, reason, summary }) {
  await pool.query(
    `INSERT INTO escalations (tenant_id, conversation_id, category, reason, summary, priority)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, conversationId, category, reason, summary, 'normal']
  );
}

/** Map our Arabic reason strings to stable escalation categories. */
export function escalationCategory(reason = '') {
  if (reason.includes('شكوى')) return 'complaint';
  if (reason.includes('تعاون')) return 'collaboration';
  if (reason.includes('حجز')) return 'reservation';
  if (reason.includes('بيانات')) return 'contact_data';
  return 'other';
}
