import { pool } from '../db/pg.js';
import {
  classifyDeliveryError,
  classifyUnstructuredError,
  DELIVERY_CATEGORY,
  RETRYABLE_DELIVERY_CATEGORIES
} from './deliveryOutcome.js';
import { BRAND_SCOPE_TENANT } from '../api/v1/brandAccess.js';
import { PENDING_INFLIGHT, RECONCILIATION_CATEGORIES } from './deliveryOutcome.js';
import { safeErrorCode } from './redact.js';
import crypto from 'node:crypto';

/**
 * Conversation persistence service (Stage 3).
 * Every inbound/outbound message is stored as: customer → conversation → messages.
 * Channels auto-provision per page id (multi-page ready).
 * All functions are best-effort: callers wrap in try/catch so persistence never breaks replies.
 */

const channelCache = new Map(); // `${tenantId}|${provider}|${externalId}` -> channel id

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

/**
 * Backward-compatible category accessor.
 *
 * Delegates to the single classification table in services/deliveryOutcome.js so
 * this helper and claimFailedOutboundForRetry can never disagree about what may
 * be re-sent. Returns only a sanitized category token — never raw provider text.
 *
 * Behavioural change: a 5xx, a timeout or a connection reset used to be reported
 * as 'meta_api_error'/'network_error' on a 'failed' row, which the dashboard then
 * offered for retry. A send whose outcome was never established is now
 * 'delivery_unknown' on a 'pending' row, which is not retryable.
 */
export function deliveryErrorCategory(err) {
  // A structured response is classified by the full state machine. Anything that
  // never went through toGraphError() gets the text-based pass, which can still
  // recognise a permanent auth/permission refusal but is STRUCTURALLY INCAPABLE
  // of returning a retryable category.
  const structured = err?.status !== undefined && err?.status !== null;
  const result = structured ? classifyDeliveryError(err) : classifyUnstructuredError(err);
  return result.category ?? DELIVERY_CATEGORY.API_ERROR;
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
 *
 * Returns null — i.e. refuses to re-send — when the row is sent, pending (which
 * is where every UNKNOWN delivery outcome lives), missing, owned by another
 * tenant, outside the caller's brand scope, or failed with a category that is not
 * provably safe to re-send.
 *
 * AUTHORISATION is part of the same statement: tenant (`m.tenant_id` AND
 * `c.tenant_id`) and brand (`channels.brand_id`) are both required to match the
 * caller. There is no separate permission check to race against.
 */
export async function claimFailedOutboundForRetry({ tenantId, conversationId, messageId, scope }) {
  if (!tenantId || !conversationId || !messageId) {
    const err = new Error('claimFailedOutboundForRetry: tenantId/conversationId/messageId required');
    err.code = 'MISSING_RETRY_CONTEXT';
    throw err;
  }
  // Authorisation and the state change are ONE conditional UPDATE. A separate
  // permission check beforehand would leave a time-of-check/time-of-use window
  // in which the brand could change before the claim landed.
  //
  // A missing scope is treated as RESTRICTED to zero brands, never as
  // tenant-wide: an absent grant must not widen access.
  const tenantWide = scope?.mode === BRAND_SCOPE_TENANT;
  const brandIds = tenantWide ? [] : (scope?.brandIds ?? []);
  const { rows } = await pool.query(
    `UPDATE messages m
        SET delivery_status = 'pending',
            delivery_error = NULL,
            retry_count = m.retry_count + 1,
            last_retry_at = now()
      FROM conversations c
      LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1
        AND m.conversation_id = $2
        AND c.id = m.conversation_id
        AND m.tenant_id = $3
        AND c.tenant_id = $3
        -- BRAND SCOPE, evaluated by the database in the same statement as the
        -- mutation. ch.brand_id IS NOT NULL means a restricted caller never
        -- reaches a company-wide (NULL brand) channel.
        AND ($5::boolean OR (ch.brand_id IS NOT NULL AND ch.brand_id = ANY($6::uuid[])))
        AND m.direction = 'outbound'
        AND m.sender_type = 'ai'
        AND m.delivery_status = 'failed'
        -- RETRY GATE — enforced by the database, never only by the UI.
        -- Only categories we can show mean "Meta refused the message and did
        -- not create it". An UNKNOWN outcome is stored as 'pending', never
        -- 'failed', so it cannot reach this branch at all. A permanent refusal
        -- (auth / permission) IS 'failed' but is not in the allow-list. A NULL
        -- delivery_error fails the comparison and is refused as well.
        AND m.delivery_error = ANY($4::text[])
      RETURNING m.id, m.conversation_id, m.tenant_id, m.text, m.retry_count, m.provider_message_id`,
    [messageId, conversationId, tenantId, [...RETRYABLE_DELIVERY_CATEGORIES], tenantWide, brandIds]
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

/**
 * BEST-EFFORT reconciliation marker.
 *
 * Records that the provider outcome was established but could not be written to
 * the row, so an operator can find the message later. Returns true when the
 * marker was actually persisted, false otherwise — the caller MUST NOT assume
 * it landed.
 *
 * Safety properties:
 *  - NEVER changes delivery_status. The row keeps whatever state it had, so a
 *    marker can never turn a non-retryable row into a retryable one.
 *  - Only writes onto a row that is already 'pending', which
 *    claimFailedOutboundForRetry refuses outright. This is the structural reason
 *    marking a delivered-but-unrecorded row cannot create a duplicate send.
 *  - Only accepts a marker from the reconciliation vocabulary.
 */
export async function recordReconciliationMarker({ tenantId, messageId, category }) {
  if (!tenantId || !messageId) return false;
  if (!RECONCILIATION_CATEGORIES.includes(category)) {
    const err = new Error('recordReconciliationMarker: category is not a reconciliation marker');
    err.code = 'INVALID_RECONCILIATION_MARKER';
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE messages
        SET delivery_error = $3
      WHERE id = $1 AND tenant_id = $2
        AND direction = 'outbound'
        AND delivery_status = 'pending'
    RETURNING id`,
    [messageId, tenantId, category]
  );
  return rows.length > 0;
}

/**
 * Count outbound messages whose record is incomplete, scoped to the caller's
 * tenant AND brand, so an operator can reconcile them.
 *
 * Buckets:
 *   delivered_unrecorded - Meta confirmed the send; the record was never updated.
 *                          The customer HAS the reply. Never re-send.
 *   refused_unrecorded   - Meta definitively refused; the refusal was never
 *                          recorded. Nothing was sent.
 *   delivery_unknown     - The send outcome was never established.
 *   pending_inflight     - Ordinary pending row, no category. Genuinely in
 *                          flight, or untouched.
 *
 * Aggregate counts only: no ids, no customer names, no message text, no
 * credentials. Returns an all-zero shape on failure so a reporting outage can
 * never be mistaken for "nothing is wrong".
 */
export async function summarizeUnresolvedOutbound({
  tenantId, scope, olderThanSeconds = 300
} = {}) {
  const empty = {
    delivered_unrecorded: 0,
    refused_unrecorded: 0,
    delivery_unknown: 0,
    pending_inflight: 0,
    unresolved_total: 0,
    stale_total: 0
  };
  if (!tenantId) return empty;

  const tenantWide = scope?.mode === BRAND_SCOPE_TENANT;
  const brandIds = tenantWide ? [] : (scope?.brandIds ?? []);
  const older = Math.max(30, Number(olderThanSeconds) || 300);

  try {
    const { rows } = await pool.query(
      `SELECT
          COALESCE(m.delivery_error, $4) AS marker,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE m.created_at < now() - ($5 || ' seconds')::interval)::int AS stale
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN channels ch ON ch.id = c.channel_id
        WHERE m.tenant_id = $1
          AND c.tenant_id = $1
          AND m.direction = 'outbound'
          -- Unresolved = pending, or carrying a reconciliation marker.
          AND (m.delivery_status = 'pending' OR m.delivery_error = ANY($6::text[]))
          AND ($2::boolean OR (ch.brand_id IS NOT NULL AND ch.brand_id = ANY($3::uuid[])))
        GROUP BY 1`,
      [tenantId, tenantWide, brandIds, PENDING_INFLIGHT, String(older), [...RECONCILIATION_CATEGORIES]]
    );

    const out = { ...empty };
    for (const row of rows) {
      if (row.marker in out) {
        out[row.marker] = row.total;
        out.stale_total += row.stale;
      }
      if (row.marker !== PENDING_INFLIGHT) out.unresolved_total += row.total;
    }
    return out;
  } catch (err) {
    // Fail closed: a reporting failure must never read as "nothing unresolved".
    console.error('⚠️ unresolved-outbound summary failed:', safeErrorCode(err));
    return { ...empty, unavailable: true };
  }
}

/** Stage 4.4.7 — sanitized lookup of a conversation + its channel (for retry context). */
export async function getConversationChannelContext({ tenantId, conversationId }) {
  const { rows } = await pool.query(
    `SELECT c.id AS conversation_id, c.tenant_id, c.external_key, ch.id AS channel_id,
            ch.provider, ch.external_id, ch.status, ch.brand_id
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
