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
            provider_message_id = COALESCE($3, provider_message_id),
            provider_ts = CASE WHEN $1 = 'sent' THEN COALESCE(provider_ts, now()) ELSE provider_ts END
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

/**
 * Record an AI-detected escalation AND stop the AI.
 *
 * DEFECT THIS FIXES
 * -----------------
 * This was a bare INSERT: it logged an escalation while leaving the
 * conversation in AI_ACTIVE. The AI gate suppresses replies unless
 * conversations.state === 'AI_ACTIVE', so the AI kept answering a conversation
 * that was already flagged for human handling - and every subsequent inbound
 * message produced another outbound reply. This was the second escalation
 * writer; requestHandoff() in ./handoff.js already did the state transition
 * correctly, which is why only the `draft.escalate` / contact-data path
 * exhibited the defect.
 *
 * THE FIX
 * -------
 * One transaction: the conversation leaves AI_ACTIVE and the escalation row is
 * written together, so there is no window in which an escalation exists while
 * the AI still owns the conversation.
 *
 * AI_ACTIVE -> HUMAN_REQUIRED -> QUEUED mirrors requestHandoff() exactly, so
 * both writers land in the same state and the existing UI/assignment logic
 * needs no special case. QUEUED is the correct landing state here: a human
 * intervention was detected but no eligible assignee exists yet.
 *
 * CONCURRENCY AND IDEMPOTENCY
 * ---------------------------
 * Each UPDATE carries `state = <expected>` in its WHERE clause, so it is the
 * database that decides the winner: a concurrent or repeated call simply
 * matches zero rows and becomes a no-op. Two callers cannot both transition,
 * and calling this N times still ends in QUEUED - not in an error, and not in a
 * second state change.
 *
 * A conversation already being handled by a human (HUMAN_ACTIVE, ASSIGNED,
 * RESOLVED) is deliberately NOT pulled back to QUEUED: the second UPDATE only
 * matches HUMAN_REQUIRED, the transient hop between the two states. Escalating
 * must never undo a human's in-progress work.
 *
 * EXISTING ESCALATIONS
 * --------------------
 * This only INSERTs. It never UPDATEs, resolves, or deletes an escalation row,
 * so open escalations are never silently closed or re-categorised. If an open
 * escalation already exists this adds a second record rather than mutating the
 * first, which preserves the audit trail.
 */
export async function createEscalationRecord(
  { tenantId, conversationId, category, reason, summary, priority = 'normal' },
  deps = {}
) {
  const db = deps.db ?? pool;
  if (!tenantId || !conversationId) {
    // Nothing to key on. Refuse rather than insert an unattributable row.
    return { recorded: false, reason: 'MISSING_CONTEXT' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Step 1 - the AI must stop owning this conversation. `state = 'AI_ACTIVE'`
    // is the lock: only a conversation still under AI control can enter the
    // handoff path.
    await client.query(
      `UPDATE conversations SET state = 'HUMAN_REQUIRED'
        WHERE id = $2 AND tenant_id = $1 AND state = 'AI_ACTIVE'`,
      [tenantId, conversationId]
    );

    // Step 2 - into the human queue. Matches only the transient HUMAN_REQUIRED
    // hop, so a conversation a human already owns is left exactly as it is.
    await client.query(
      `UPDATE conversations SET state = 'QUEUED'
        WHERE id = $2 AND tenant_id = $1 AND state = 'HUMAN_REQUIRED'`,
      [tenantId, conversationId]
    );

    const { rows } = await client.query(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, summary, priority)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, created_at`,
      [tenantId, conversationId, category ?? null, reason ?? null, summary ?? null, priority]
    );

    await client.query('COMMIT');
    return { recorded: true, id: rows[0]?.id ?? null, createdAt: rows[0]?.created_at ?? null };
  } catch (err) {
    // Roll back so a failed insert cannot leave the conversation parked in
    // HUMAN_REQUIRED with no escalation explaining why.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
            provider_message_id = COALESCE($3, provider_message_id),
            provider_ts = CASE WHEN $1 = 'sent' THEN COALESCE(provider_ts, now()) ELSE provider_ts END
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
  // A missing tenant context is NOT "nothing is wrong". Returning the empty shape
  // here once made the worker's alert silently report a clean state forever, so
  // it is now an explicit, distinguishable failure that every caller must handle.
  if (!tenantId) return { ...empty, unavailable: true, reason: 'TENANT_REQUIRED' };

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

/**
 * CROSS-TENANT aggregate, for the internal worker alert only.
 *
 * The worker is a single process with no request context, so it cannot supply a
 * tenantId — and must never fabricate one. This function exists so the alert can
 * still fire, while leaking as little as possible:
 *
 *  - it returns COUNTERS ONLY. No tenant id, no customer id, no message text, no
 *    credential, and no per-tenant breakdown — a log line cannot identify which
 *    tenant is affected. `tenants_affected` is how MANY tenants are affected,
 *    not which ones;
 *  - the drill-down is GET /dashboard/api/reconciliation, which applies the
 *    caller's tenant AND brand policy;
 *  - it never mutates anything and never triggers a retry.
 *
 * Rows younger than `olderThanSeconds` are excluded: a message that went pending
 * seconds ago is legitimately in flight, not unresolved.
 */
export async function summarizeUnresolvedOutboundAllTenants({ olderThanSeconds = 300 } = {}) {
  const empty = {
    delivered_unrecorded: 0,
    refused_unrecorded: 0,
    delivery_unknown: 0,
    pending_inflight: 0,
    unresolved_total: 0,
    stale_total: 0,
    tenants_affected: 0
  };
  const older = Math.max(30, Number(olderThanSeconds) || 300);

  try {
    const { rows } = await pool.query(
      `WITH unresolved AS (
          SELECT m.delivery_error, m.tenant_id
            FROM messages m
           WHERE m.direction = 'outbound'
             AND m.created_at < now() - ($2 || ' seconds')::interval
             AND (m.delivery_status = 'pending' OR m.delivery_error = ANY($3::text[]))
         )
       SELECT COALESCE(u.delivery_error, $1) AS marker,
              COUNT(*)::int AS total,
              (SELECT COUNT(DISTINCT t2.tenant_id) FROM unresolved t2)::int AS tenants
         FROM unresolved u
        GROUP BY 1`,
      [PENDING_INFLIGHT, String(older), [...RECONCILIATION_CATEGORIES]]
    );

    const out = { ...empty };
    for (const row of rows) {
      if (row.marker in out) out[row.marker] = row.total;
      if (row.marker !== PENDING_INFLIGHT) out.unresolved_total += row.total;
      // How many distinct tenants have at least one unresolved message — a bare
      // count. It says HOW MANY, never WHICH, so the log identifies nobody.
      out.tenants_affected = Math.max(out.tenants_affected, row.tenants ?? 0);
    }
    return out;
  } catch (err) {
    // Fail closed: an unavailable report must never read as "all clear".
    console.error('⚠️ cross-tenant unresolved summary failed:', safeErrorCode(err));
    return { ...empty, unavailable: true, reason: 'REPORT_UNAVAILABLE' };
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
