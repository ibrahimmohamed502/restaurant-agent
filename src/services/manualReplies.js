/**
 * P0.2 — Manual (employee) replies to customer conversations.
 *
 * ============================================================================
 * WHAT THIS MODULE IS FOR
 * ============================================================================
 * Until now an employee could READ a conversation and nothing else: the inbox
 * had no write path at all. This adds one — a human sends a reply to a real
 * customer, on the company's own Meta channel, under the company's own
 * credential.
 *
 * That is irreversible and externally visible. Every design decision below
 * exists because a mistake here reaches a real person's inbox.
 *
 * ============================================================================
 * THE FIVE INVARIANTS
 * ============================================================================
 *
 * 1. AUTHORISATION IS EVALUATED BY THE DATABASE, IN THE STATEMENT THAT WRITES.
 *    There is no "check, then insert" anywhere in this file. `claimReplySlot`
 *    reads tenant, brand scope, conversation state and assignment, and inserts
 *    the outbound row, inside ONE statement. A permission check followed by a
 *    separate INSERT would leave a window in which the conversation could be
 *    reassigned or handed back to the AI before the row landed — and by then
 *    the reply would already be written. Same reasoning, same shape as
 *    claimFailedOutboundForRetry() in services/conversations.js.
 *
 * 2. THE AI AND A HUMAN CAN NEVER BOTH SEND.
 *    `conversations.state` is the single authority: AI is active IFF state ===
 *    'AI_ACTIVE' (services/handoff.js). Human replies are accepted ONLY in the
 *    four human-controlled states, and AI_ACTIVE is not one of them. So there
 *    is no state in which both paths are open, and this module never transitions
 *    the state itself — it does not claim, assign, activate or resume.
 *    The reverse direction (a delayed AI job that passed its check just before a
 *    handoff) is closed by `humanReplyInFlight()` below, which the AI's final
 *    pre-dispatch check consults.
 *
 * 3. ONE CUSTOMER, ONE COPY.
 *    The claim carries a client-supplied idempotency key held unique by
 *    (tenant_id, conversation_id, idempotency_key). A double-clicked button, a
 *    retried request, or two racing requests all lose the second INSERT. The
 *    provider is only ever called by the request that WON the claim.
 *    Delivery then follows the existing outcome state machine verbatim: a
 *    confirmed refusal is 'failed', and an outcome we never established is
 *    'pending' — which the retry gate refuses. An ambiguous send can never
 *    become a second copy.
 *
 * 4. NOTHING FROM THE CLIENT IS TRUSTED AS IDENTITY.
 *    tenant_id, brand scope, the conversation's company, the recipient and the
 *    actor are ALL resolved server-side from the authenticated session and the
 *    database. The body carries exactly two fields: the text and the
 *    idempotency key. There is no `provider`, `channelId`, `brandId` or
 *    `recipient` parameter to forge, by construction rather than by validation.
 *
 * 5. A ROW EXISTS BEFORE THE PROVIDER IS CALLED.
 *    The outbound message is persisted as 'pending' first, then dispatched, then
 *    updated. A crash after the send therefore leaves an auditable 'pending' row
 *    rather than a silently delivered message with no record.
 *
 * ============================================================================
 * MESSAGING WINDOW ANCHOR
 * ============================================================================
 * The window is measured from COALESCE(provider_ts, created_at) — the moment the
 * CUSTOMER wrote, which is what the provider's rule is actually anchored on.
 *
 * created_at alone is wrong whenever a webhook is delivered late: created_at is
 * when WE processed the row and is always >= provider_ts, so it makes the window
 * look more open than it really is. The consequence is not a duplicate message —
 * the provider refuses it and the row is recorded as a permanent failure — but a
 * confusing "permission" failure for a reply the provider was never going to
 * accept, and an employee retry spent for nothing. created_at stays as the
 * fallback for rows the provider never timestamped.
 *
 * ============================================================================
 * SCOPE - MESSENGER ONLY, AND WHY
 * ============================================================================
 * Only `meta_dm` is sendable today. Facebook COMMENT replies are refused with a
 * specific error rather than silently attempted, because they are NOT the same
 * operation and no safe threading exists yet:
 *
 *   - Meta replies to a comment through POST /{comment_id}/comments. That needs
 *     the id of the specific comment being answered. We persist only the
 *     conversation's `external_key` (the parent post / thread id), which is not
 *     guaranteed to be a replyable comment id.
 *   - A public comment reply is visible to every visitor to the post. Failing to
 *     thread it correctly puts an employee message in the wrong place in public.
 *   - The private-reply path has a hard 7-day window; the public path has no
 *     such window but a different rate limit.
 *   - provider.sendReply() takes a normalised WEBHOOK EVENT, which does not
 *     exist at reply time — there is no event, only a conversation.
 *
 * Threading + window enforcement is separate scope and is reported as such. It
 * is deliberately NOT stubbed.
 */

import { pool } from '../db/pg.js';
import { can } from '../auth/abilities.js';
import { BRAND_SCOPE_TENANT } from '../api/v1/brandAccess.js';
import { CONVERSATION_STATES } from './handoff.js';
import {
  classifyDeliveryError,
  DELIVERY_CATEGORY
} from './deliveryOutcome.js';
import {
  updateMessageDelivery,
  recordReconciliationMarker
} from './conversations.js';
import { audit } from '../auth/audit.js';
import { resolveCredentialForChannel } from './channelResolver.js';
import { createMetaClient } from '../facebook.js';
import { redactId, textSummary, safeErrorCode } from './redact.js';

/* ------------------------------------------------------------------ limits */

/** Meta's standard messaging window: 24h after the customer last wrote. */
export const DEFAULT_MESSAGING_WINDOW_SECONDS = 24 * 60 * 60;

export function messagingWindowSeconds() {
  const raw = Number(process.env.MESSENGER_WINDOW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MESSAGING_WINDOW_SECONDS;
}

export const MAX_REPLY_CHARS = 4000;
export const MIN_IDEMPOTENCY_KEY_CHARS = 8;
export const MAX_IDEMPOTENCY_KEY_CHARS = 200;

/** Provider channels a human reply can be delivered on today. */
export const SENDABLE_CHANNEL_PROVIDERS = Object.freeze(['meta_dm']);

/**
 * States a human may reply in.
 *
 * Exactly the states where the AI gate is already CLOSED (HANDLED_STATES in
 * services/handoff.js). AI_ACTIVE and RESOLVED are deliberately absent: the first
 * because the AI owns it, the second because the conversation is closed.
 */
export const REPLYABLE_STATES = Object.freeze([
  CONVERSATION_STATES.HUMAN_REQUIRED,
  CONVERSATION_STATES.QUEUED,
  CONVERSATION_STATES.ASSIGNED,
  CONVERSATION_STATES.HUMAN_ACTIVE
]);

/* ------------------------------------------------------------------ errors */

export const REPLY_ERRORS = Object.freeze({
  VALIDATION: 'REPLY_VALIDATION_FAILED',
  IDEMPOTENCY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  NO_ABILITY: 'REPLY_FORBIDDEN',
  NOT_ASSIGNED: 'REPLY_NOT_ASSIGNED',
  AI_OWNS: 'AI_OWNS_CONVERSATION',
  CLOSED: 'CONVERSATION_CLOSED',
  CHANNEL_UNSUPPORTED: 'CHANNEL_REPLY_UNSUPPORTED',
  CHANNEL_INACTIVE: 'CHANNEL_INACTIVE',
  CREDENTIAL_MISSING: 'CHANNEL_CREDENTIAL_MISSING',
  WINDOW_CLOSED: 'MESSAGING_WINDOW_CLOSED',
  STATE_CHANGED: 'CONVERSATION_STATE_CHANGED',
  INTERNAL: 'REPLY_INTERNAL'
});

/** machine reason -> { status, code } for the API envelope. */
const REJECTION = Object.freeze({
  not_found:        { status: 404, code: REPLY_ERRORS.NOT_FOUND },
  no_ability:        { status: 403, code: REPLY_ERRORS.NO_ABILITY },
  not_assigned:      { status: 403, code: REPLY_ERRORS.NOT_ASSIGNED },
  ai_active:         { status: 409, code: REPLY_ERRORS.AI_OWNS },
  closed:            { status: 409, code: REPLY_ERRORS.CLOSED },
  invalid_state:     { status: 409, code: REPLY_ERRORS.STATE_CHANGED },
  channel_unsupported: { status: 409, code: REPLY_ERRORS.CHANNEL_UNSUPPORTED },
  channel_inactive:  { status: 409, code: REPLY_ERRORS.CHANNEL_INACTIVE },
  window_closed:     { status: 409, code: REPLY_ERRORS.WINDOW_CLOSED },
  ok:                { status: 200, code: 'OK' }
});

export class ReplyError extends Error {
  constructor(reason, message, details) {
    const r = REJECTION[reason] ?? REJECTION.invalid_state;
    super(message ?? reason);
    this.name = 'ReplyError';
    this.reason = reason;
    this.status = r.status;
    this.code = r.code;
    if (details) this.details = details;
  }
}

/**
 * A malformed request body.
 *
 * Deliberately NOT a ReplyError: a bad payload is a 422 about the request, never a
 * 404/409 about the conversation. Keeping the two apart means a caller can always
 * tell "you typed something wrong" from "this conversation is not available" —
 * and, critically, that a validation failure can never be shaped like a
 * conversation-state answer.
 */
export class ReplyValidationError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'ReplyValidationError';
    this.status = 422;
    this.code = code;
    if (details) this.details = details;
  }
}

/**
 * Local abort reasons written to messages.delivery_error when we never reached
 * the provider.
 *
 * None of these is in RETRYABLE_DELIVERY_CATEGORIES (which is a frozen
 * one-element list), so a locally aborted row can never be picked up for another
 * send — by the database, by the dashboard, or by an operator.
 */
export const LOCAL_ABORT_CATEGORY = Object.freeze({
  STATE_CHANGED: 'aborted_before_send',
  CREDENTIAL_MISSING: 'credential_missing',
  CHANNEL_UNSUPPORTED: 'channel_unsupported',
  CHANNEL_INACTIVE: 'channel_inactive',
  WINDOW_CLOSED: 'window_closed',
  INTERNAL: 'reply_internal_error'
});

/* --------------------------------------------------------------- authority */

/**
 * The caller's reply authority, derived from the session ONLY.
 *
 * `conversation.reply`     -> may reply to any conversation in scope.
 * `conversation.reply_own` -> may reply ONLY where an assignment record names
 *                             them. The check itself is in SQL, against
 *                             conversations.assigned_user_id, never here.
 *
 * A missing or malformed session yields zero of both, so the request fails
 * closed rather than defaulting to "permitted".
 */
export function resolveReplyAuthority(session) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  const custom = Array.isArray(session?.customAbilities) ? session.customAbilities : [];
  const tenantWide = Boolean(session?.brandIds === null && session?.allBrandsInCompany === true);
  return {
    tenantId: session?.tenantId ?? null,
    userId: session?.user?.id ?? null,
    tenantWide,
    brandIds: tenantWide ? [] : (Array.isArray(session?.brandIds) ? session.brandIds : []),
    canReplyAny: can(roles, 'conversation.reply', custom),
    canReplyOwn: can(roles, 'conversation.reply_own', custom)
  };
}

/**
 * Why this caller may or may not reply to this conversation — for the UI.
 *
 * PURE, and therefore the same function the API can use to explain itself. It
 * never grants anything: the server re-decides in SQL at write time.
 */
export function evaluateReplyEligibility({ authority, conversation }) {
  if (!authority?.canReplyAny && !authority?.canReplyOwn) return { allowed: false, reason: 'no_ability' };
  if (!conversation) return { allowed: false, reason: 'not_found' };
  if (conversation.state === CONVERSATION_STATES.AI_ACTIVE) return { allowed: false, reason: 'ai_active' };
  if (conversation.state === CONVERSATION_STATES.RESOLVED) return { allowed: false, reason: 'closed' };
  if (!REPLYABLE_STATES.includes(conversation.state)) return { allowed: false, reason: 'invalid_state' };
  if (!authority.canReplyAny && conversation.assignedUserId !== authority.userId) {
    return { allowed: false, reason: 'not_assigned' };
  }
  // The detail endpoint historically returned `provider`, the handoff endpoint returns
// `channelProvider`. Accept either so a reply is never blocked by a field-name
// mismatch between the two code paths.
const provider = conversation.channelProvider ?? conversation.provider;
if (!SENDABLE_CHANNEL_PROVIDERS.includes(provider)) {
    return { allowed: false, reason: 'channel_unsupported' };
  }
  if (conversation.channelStatus && conversation.channelStatus !== 'active') {
    return { allowed: false, reason: 'channel_inactive' };
  }
  if (!conversation.lastInboundAt) return { allowed: false, reason: 'window_closed' };
  const age = (Date.now() - new Date(conversation.lastInboundAt).getTime()) / 1000;
  if (age > messagingWindowSeconds()) return { allowed: false, reason: 'window_closed' };
  return { allowed: true, reason: 'ok' };
}

/** Human-readable eligibility, shared by the API and (translated) by the UI. */
export const REPLY_REASONS = Object.freeze({
  ok: 'you can reply to this conversation',
  no_ability: 'your role cannot send replies',
  not_assigned: 'reply on this conversation is restricted to its assigned agent',
  ai_active: 'the AI is answering this conversation — a handoff is required first',
  closed: 'this conversation is closed',
  invalid_state: 'this conversation is not in a replyable state',
  channel_unsupported: 'replies are not supported on this channel yet',
  channel_inactive: 'this channel is disconnected',
  channel_missing: 'this conversation has no active channel',
  window_closed: "the provider's messaging window for this customer has closed",
  not_found: 'conversation not found'
});

/* -------------------------------------------------------------- validation */

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Validate the request body. Returns ONLY these two values.
 *
 * Anything else a client might send (tenantId, brandId, channelId, provider,
 * recipient, senderUserId) is discarded here and never reaches a query, so it
 * cannot be used to address someone else's conversation.
 */
export function validateReplyPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ReplyValidationError(REPLY_ERRORS.VALIDATION, 'invalid request payload', { text: 'required' });
  }

  const rawText = body.text;
  if (typeof rawText !== 'string') {
    throw new ReplyValidationError(REPLY_ERRORS.VALIDATION, 'invalid request payload', { text: 'required' });
  }
  // Strip nothing: leading/trailing whitespace is trimmed, but the body itself
  // is preserved byte-for-byte so Arabic text, RTL marks and emoji survive
  // exactly as typed. Length is counted in code points, not UTF-16 units, so an
  // emoji costs 1 and an Arabic ligature costs 1 — not 2.
  const text = rawText.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    throw new ReplyValidationError(REPLY_ERRORS.VALIDATION, 'invalid request payload', { text: 'required' });
  }
  const textLength = [...text].length;
  if (textLength > MAX_REPLY_CHARS) {
    throw new ReplyValidationError(REPLY_ERRORS.VALIDATION, 'invalid request payload', {
      text: 'too_long', maxLength: MAX_REPLY_CHARS
    });
  }
  // No control characters other than newline/tab. This blocks a smuggled CRLF
  // header injection into the provider request while keeping multi-line replies.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new ReplyValidationError(REPLY_ERRORS.VALIDATION, 'invalid request payload', {
      text: 'invalid_characters'
    });
  }

  const key = body.idempotencyKey;
  if (key === undefined || key === null || key === '') {
    throw new ReplyValidationError(REPLY_ERRORS.IDEMPOTENCY_REQUIRED, 'an idempotency key is required');
  }
  if (typeof key !== 'string' || !IDEMPOTENCY_RE.test(key)
      || key.length < MIN_IDEMPOTENCY_KEY_CHARS || key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new ReplyValidationError(REPLY_ERRORS.IDEMPOTENCY_INVALID, 'invalid idempotency key', {
      min: MIN_IDEMPOTENCY_KEY_CHARS, max: MAX_IDEMPOTENCY_KEY_CHARS
    });
  }

  return { text, idempotencyKey: key };
}

/* ------------------------------------------------------------------- claim */

/**
 * Atomically authorise AND persist one employee reply.
 *
 * ONE statement, therefore ONE snapshot. It:
 *   - finds the conversation under the session's company AND brand scope,
 *   - reads its state, assignment, channel, recipient and last inbound time,
 *   - inserts the outbound row ONLY if every guard passes,
 *   - and loses cleanly to a previous request carrying the same key.
 *
 * The guards, all inside the INSERT's WHERE:
 *   - tenant_id comes from the session; brand scope from the grant tables.
 *   - state ∈ REPLYABLE_STATES  (never AI_ACTIVE, never RESOLVED)
 *   - channel provider ∈ SENDABLE_CHANNEL_PROVIDERS and channel status active
 *   - the provider messaging window is open
 *   - `conversation.reply` (any) OR `conversation.reply_own` AND
 *     assigned_user_id = the session's user id
 *
 * Returns one of:
 *   { outcome:'claimed', ... }  — we own the send, call dispatchClaimed()
 *   { outcome:'duplicate', ... } — a previous request with this key already did
 *   { outcome:'rejected', reason } — plus the conversation facts needed to explain
 *   { outcome:'not_found' }      — indistinguishable from "does not exist"
 */
export async function claimReplySlot({ authority, conversationId, text, idempotencyKey, db = pool }) {
  const { rows } = await db.query(
    `WITH target AS (
       SELECT c.state, c.assigned_user_id, c.external_key,
              ch.provider  AS channel_provider,
              ch.status    AS channel_status,
              ch.brand_id,
              (SELECT max(COALESCE(m.provider_ts, m.created_at)) FROM messages m
                WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS last_inbound_at
         FROM conversations c
         LEFT JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = $2
          AND c.tenant_id = $1
          -- BRAND SCOPE, in the same statement as the write. A company-wide
          -- (NULL brand) channel is visible only to a tenant-wide caller.
          AND ($6::boolean OR (ch.brand_id IS NOT NULL AND ch.brand_id = ANY($7::uuid[])))
     ),
     existing AS (
       SELECT id, delivery_status, provider_message_id
         FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2
          AND direction = 'outbound' AND idempotency_key = $5
     ),
     claimed AS (
       INSERT INTO messages (tenant_id, conversation_id, direction, sender_type,
                             sender_user_id, text, delivery_status,
                             provider_message_id, idempotency_key)
       SELECT $1, $2, 'outbound', 'employee', $3, $4, 'pending',
              'idem:' || $5, $5
        WHERE EXISTS (
                SELECT 1 FROM target t
                 WHERE t.state = ANY($10::text[])
                   -- ability + assignment, evaluated against the real row
                   AND ($8::boolean OR t.assigned_user_id = $3)
                   -- channel capability
                   AND t.channel_provider = ANY($11::text[])
                   AND t.channel_status = 'active'
                   -- provider messaging window
                   AND t.last_inbound_at IS NOT NULL
                   AND t.last_inbound_at > now() - ($9::double precision * interval '1 second')
             )
       -- No conflict target: the same key collides on the new partial unique
       -- index AND on the historical (conversation_id, provider_message_id)
       -- unique, and this form covers both without having to name either.
       ON CONFLICT DO NOTHING
       RETURNING id, delivery_status, provider_message_id
     )
     SELECT (SELECT count(*) FROM target)::int             AS target_count,
            (SELECT state FROM target LIMIT 1)             AS state,
            (SELECT assigned_user_id FROM target LIMIT 1)  AS assigned_user_id,
            (SELECT external_key FROM target LIMIT 1)      AS external_key,
            (SELECT channel_provider FROM target LIMIT 1) AS channel_provider,
            (SELECT channel_status FROM target LIMIT 1)   AS channel_status,
            (SELECT last_inbound_at FROM target LIMIT 1)  AS last_inbound_at,
            (SELECT count(*) FROM claimed)::int            AS claimed_count,
            (SELECT id::text FROM claimed LIMIT 1)         AS claimed_id,
            (SELECT count(*) FROM existing)::int           AS existing_count,
            (SELECT id::text FROM existing LIMIT 1)        AS existing_id,
            (SELECT delivery_status FROM existing LIMIT 1) AS existing_status,
            (SELECT provider_message_id FROM existing LIMIT 1) AS existing_provider_id`,
    [
      authority.tenantId,
      conversationId,
      authority.userId,
      text,
      idempotencyKey,
      authority.tenantWide,
      authority.brandIds,
      authority.canReplyAny,
      messagingWindowSeconds(),
      [...REPLYABLE_STATES],
      [...SENDABLE_CHANNEL_PROVIDERS]
    ]
  );

  const r = rows[0] ?? {};

  // Out of scope for this caller: identical to "no such conversation", so the
  // endpoint can never be used to discover that another company's conversation
  // exists.
  if (!r.target_count) return { outcome: 'not_found' };

  // Already answered under this key. Returned BEFORE the state guard: a reply
  // that genuinely succeeded must stay a success even if the conversation has
  // since changed state, otherwise a retried request would report an error for a
  // message the customer already has.
  if (r.existing_count) {
    return {
      outcome: 'duplicate',
      messageId: r.existing_id,
      deliveryStatus: r.existing_status,
      providerMessageId: r.existing_provider_id,
      externalKey: r.external_key,
      channelProvider: r.channel_provider
    };
  }

  if (r.claimed_count) {
    return {
      outcome: 'claimed',
      messageId: r.claimed_id,
      deliveryStatus: 'pending',
      providerMessageId: null,
      externalKey: r.external_key,
      channelProvider: r.channel_provider
    };
  }

  // Nothing inserted and nothing pre-existing: a guard refused. Explain it.
  return { outcome: 'rejected', reason: rejectionReason(r, authority), facts: r };
}

function rejectionReason(row, authority) {
  if (row.state === CONVERSATION_STATES.AI_ACTIVE) return 'ai_active';
  if (row.state === CONVERSATION_STATES.RESOLVED) return 'closed';
  if (!REPLYABLE_STATES.includes(row.state)) return 'invalid_state';
  if (!authority.canReplyAny && row.assigned_user_id !== authority.userId) return 'not_assigned';
  // A conversation whose channel row is gone cannot be delivered on at all, and
  // from the caller's point of view that is the same refusal.
  if (!row.channel_provider) return 'channel_unsupported';
  if (!SENDABLE_CHANNEL_PROVIDERS.includes(row.channel_provider)) return 'channel_unsupported';
  if (row.channel_status !== 'active') return 'channel_inactive';
  return 'window_closed';
}

/* ----------------------------------------------------------------- recheck */

/**
 * Re-read ownership and state IMMEDIATELY before dispatch.
 *
 * The claim already proved the guards held; this narrows the remaining window to
 * the microseconds between the write and the provider call. It exists so that a
 * conversation which is resumed to AI_ACTIVE, or reassigned away, in that window
 * does NOT receive a reply the human no longer owns.
 *
 * On refusal the claimed row is closed as a local abort, which is not retryable,
 * so nothing is left dangling and nothing can be re-sent.
 */
export async function confirmReplyStillOwned({ authority, conversationId, idempotencyKey, db = pool }) {
  const { rows } = await db.query(
    `SELECT c.state, c.assigned_user_id, ch.brand_id, ch.provider, ch.status, c.channel_id,
            c.external_key,
            (SELECT count(*) FROM messages m
              WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
                AND m.direction = 'outbound' AND m.idempotency_key = $3) AS still_mine
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $2 AND c.tenant_id = $1
        AND ($4::boolean OR (ch.brand_id IS NOT NULL AND ch.brand_id = ANY($5::uuid[])))`,
    [authority.tenantId, conversationId, idempotencyKey, authority.tenantWide, authority.brandIds]
  );
  const r = rows[0];
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.still_mine !== 1) return { ok: false, reason: 'state_changed' };
  if (r.state === CONVERSATION_STATES.AI_ACTIVE) return { ok: false, reason: 'ai_active' };
  if (r.state === CONVERSATION_STATES.RESOLVED) return { ok: false, reason: 'closed' };
  if (!REPLYABLE_STATES.includes(r.state)) return { ok: false, reason: 'invalid_state' };
  if (!authority.canReplyAny && r.assigned_user_id !== authority.userId) return { ok: false, reason: 'not_assigned' };
  if (!SENDABLE_CHANNEL_PROVIDERS.includes(r.provider)) return { ok: false, reason: 'channel_unsupported' };
  if (r.status !== 'active') return { ok: false, reason: 'channel_inactive' };
  return {
    ok: true,
    channelId: r.channel_id,
    channelProvider: r.provider,
    externalKey: r.external_key
  };
}

/* --------------------------------------------------------------- dispatch */

const RECIPIENT_LABEL = { meta_dm: 'messenger' };

/**
 * Deliver one already-claimed reply, then record what actually happened.
 *
 * Mirrors the AI outbound lifecycle exactly:
 *   1. resolve the credential for THIS channel in THIS company (never a global
 *      env fallback, never a credential belonging to another channel),
 *   2. call the provider ONCE,
 *   3. confirmed send  -> 'sent'  + the provider message id,
 *      confirmed refusal -> 'failed' + the classified category,
 *      never established  -> 'pending' + delivery_unknown (never retryable).
 *
 * A confirmed send whose bookkeeping write then fails is left 'pending' and
 * marked delivered_unrecorded: writing 'failed' there would offer a customer a
 * second copy of a message they already have.
 */
export async function dispatchClaimed({
  claim,
  authority,
  conversationId,
  text,
  deps = {}
}) {
  const {
    db = pool,
    resolveCredential = resolveCredentialForChannel,
    createClient = createMetaClient,
    updateDelivery = updateMessageDelivery,
    markReconciliation = recordReconciliationMarker,
    log = console
  } = deps;

  const base = {
    messageId: claim.messageId,
    providerMessageId: null,
    mechanism: RECIPIENT_LABEL[claim.channelProvider] ?? null
  };

  // ---- never reached the provider: local abort, not a delivery failure ----
  const abort = async (category) => {
    await updateDelivery({
      tenantId: authority.tenantId,
      messageId: claim.messageId,
      deliveryStatus: 'failed',
      errorCategory: category
    }).catch(() => undefined);
    return { ...base, deliveryStatus: 'failed', deliveryError: category, retryable: false };
  };

  const channelId = claim.channelId ?? deps.channelId;
  let credential;
  try {
    credential = await resolveCredential({ channelId, tenantId: authority.tenantId, db });
  } catch (e) {
    log.error?.(`manual reply: credential resolution failed [${safeErrorCode(e)}]`);
    credential = null;
  }
  if (!credential) return abort(LOCAL_ABORT_CATEGORY.CREDENTIAL_MISSING);

  // ---- THE IRREVERSIBLE CALL ----
  let response = null;
  let failure = null;
  try {
    const client = createClient({ accessToken: credential });
    response = await client.sendMessengerReply(claim.externalKey, text);
  } catch (err) {
    failure = err;
  }

  if (!failure) {
    // Meta accepted it. Nothing from here on may re-open a retry path.
    try {
      await updateDelivery({
        tenantId: authority.tenantId,
        messageId: claim.messageId,
        deliveryStatus: 'sent',
        providerMessageId: response?.message_id ?? null
      });
      return {
        ...base,
        providerMessageId: response?.message_id ?? null,
        deliveryStatus: 'sent',
        deliveryError: null,
        retryable: false
      };
    } catch (e) {
      log.error?.(`manual reply delivered but the record was not updated [${safeErrorCode(e)}]`);
      await markReconciliation({
        tenantId: authority.tenantId,
        messageId: claim.messageId,
        category: DELIVERY_CATEGORY.DELIVERED_UNRECORDED
      }).catch(() => false);
      return {
        ...base,
        deliveryStatus: 'pending',
        deliveryError: DELIVERY_CATEGORY.DELIVERED_UNRECORDED,
        retryable: false
      };
    }
  }

  // ---- the send did not succeed: classify with the shared state machine ----
  const outcome = classifyDeliveryError(failure);
  await updateDelivery({
    tenantId: authority.tenantId,
    messageId: claim.messageId,
    deliveryStatus: outcome.deliveryStatus,
    errorCategory: outcome.category
  }).catch(() => undefined);
  return {
    ...base,
    deliveryStatus: outcome.deliveryStatus,
    deliveryError: outcome.category ?? null,
    // Structural guarantee, not a hope: an UNKNOWN outcome is stored 'pending',
    // which claimFailedOutboundForRetry refuses by construction.
    retryable: outcome.retryable === true
  };
}

/* ------------------------------------------------------- human ownership */

/**
 * Is a human reply claimed-but-not-yet-delivered on this conversation?
 *
 * Consulted by the AI's FINAL pre-dispatch check (webhook.js). Without it there
 * is a real interleaving:
 *
 *     t0  AI passes finalAiSendCheck          (state is still AI_ACTIVE)
 *     t1  a handoff moves the conversation     → HUMAN_REQUIRED
 *     t2  an employee claims and sends a reply → the customer gets it
 *     t3  the AI's send lands                  → a second, out-of-context reply
 *
 * The first check cannot close this; it already ran. This one runs at the same
 * instant the human row exists, so t3 is refused instead. It never suppresses
 * the AI's ESCALATION work — only the send.
 *
 * Returns false when there is no persistence context, so legacy mode is silent.
 */
export async function humanReplyInFlight({ tenantId, conversationId, db = pool }) {
  if (!tenantId || !conversationId) return false;
  const { rows } = await db.query(
    `SELECT 1
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.tenant_id = $1
        AND m.conversation_id = $2
        AND m.direction = 'outbound'
        AND m.sender_type = 'employee'
        AND m.delivery_status = 'pending'
      LIMIT 1`,
    [tenantId, conversationId]
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------ orchestrator */

export const REPLY_MECHANISMS = Object.freeze({ meta_dm: 'messenger' });

/**
 * The whole operation: validate -> claim -> recheck -> dispatch -> audit.
 *
 * Returns a payload shaped for the API envelope. Throws ReplyError for every
 * refusal, each carrying the HTTP status and machine code.
 */
export async function sendManualReply({ session, conversationId, body, deps = {} }) {
  const { db = pool, auditFn = audit, log = console, ...dispatchDeps } = deps;

  const { text, idempotencyKey } = validateReplyPayload(body);
  const summary = textSummary(text);
  const authority = resolveReplyAuthority(session);

  if (!authority.tenantId || !authority.userId) {
    throw new ReplyError('no_ability', REPLY_ERRORS.NO_ABILITY);
  }
  if (!authority.canReplyAny && !authority.canReplyOwn) {
    throw new ReplyError('no_ability', REPLY_ERRORS.NO_ABILITY);
  }

  const claim = await claimReplySlot({
    authority, conversationId, text, idempotencyKey, db
  });

  if (claim.outcome === 'not_found') {
    auditFn({
      tenantId: authority.tenantId,
      actorUserId: authority.userId,
      action: 'conversation.reply.denied',
      objectType: 'conversation',
      objectId: String(conversationId),
      ip: deps.ip ?? null,
      metadata: { reason: 'not_found' }
    });
    throw new ReplyError('not_found', REPLY_REASONS.not_found);
  }

  if (claim.outcome === 'rejected') {
    auditFn({
      tenantId: authority.tenantId,
      actorUserId: authority.userId,
      action: 'conversation.reply.denied',
      objectType: 'conversation',
      objectId: String(conversationId),
      ip: deps.ip ?? null,
      metadata: { reason: claim.reason }
    });
    throw new ReplyError(claim.reason, REPLY_REASONS[claim.reason] ?? REPLY_REASONS.invalid_state);
  }

  const mechanism = REPLY_MECHANISMS[claim.channelProvider] ?? null;

  if (claim.outcome === 'duplicate') {
    log.log?.(
      `manual reply: duplicate idempotency key ${redactId(idempotencyKey)} — nothing resent`
    );
    auditFn({
      tenantId: authority.tenantId,
      actorUserId: authority.userId,
      action: 'conversation.reply.duplicate',
      objectType: 'conversation',
      objectId: String(conversationId),
      ip: deps.ip ?? null,
      metadata: { deliveryStatus: claim.deliveryStatus, channelProvider: claim.channelProvider }
    });
    return {
      messageId: claim.messageId,
      providerMessageId: claim.providerMessageId,
      deliveryStatus: claim.deliveryStatus,
      deliveryError: null,
      mechanism,
      duplicate: true,
      retryable: false,
      text: summary
    };
  }

  // ---- recheck immediately before the irreversible call ----
  const stillOwned = await confirmReplyStillOwned({
    authority, conversationId, idempotencyKey, db
  });
  if (!stillOwned.ok) {
    await closeAbortedClaim({
      updateDelivery: dispatchDeps.updateDelivery ?? updateMessageDelivery,
      log,
      args: {
        tenantId: authority.tenantId,
        messageId: claim.messageId,
        deliveryStatus: 'failed',
        errorCategory: LOCAL_ABORT_CATEGORY.STATE_CHANGED
      }
    });
    auditFn({
      tenantId: authority.tenantId,
      actorUserId: authority.userId,
      action: 'conversation.reply.denied',
      objectType: 'conversation',
      objectId: String(conversationId),
      ip: deps.ip ?? null,
      metadata: { reason: stillOwned.reason, phase: 'pre_dispatch' }
    });
    // The world moved between the claim and the send. The reason is reported
    // precisely when it is meaningful to the caller (still assigned? still
    // yours?) and collapsed to a generic state change otherwise, so this can
    // never be mistaken for the conversation simply not existing.
    const mapped = ['not_found', 'not_assigned', 'ai_active', 'closed',
      'channel_unsupported', 'channel_inactive'].includes(stillOwned.reason)
      ? stillOwned.reason
      : 'invalid_state';
    throw new ReplyError(mapped, REPLY_REASONS[mapped] ?? REPLY_REASONS.invalid_state);
  }

  const result = await dispatchClaimed({
    claim: { ...claim, channelId: stillOwned.channelId },
    authority,
    conversationId,
    text,
    deps: { ...dispatchDeps, db, log }
  });

  auditFn({
    tenantId: authority.tenantId,
    actorUserId: authority.userId,
    action: 'conversation.reply.sent',
    objectType: 'conversation',
    objectId: String(conversationId),
    ip: deps.ip ?? null,
    // Shape only. The reply text is customer content and is never audited.
    metadata: {
      messageId: result.messageId,
      provider: claim.channelProvider,
      deliveryStatus: result.deliveryStatus,
      deliveryError: result.deliveryError ?? null,
      idempotencyKey: redactId(idempotencyKey),
      textChars: summary.chars
    }
  });

  return {
    messageId: result.messageId,
    providerMessageId: result.providerMessageId,
    deliveryStatus: result.deliveryStatus,
    deliveryError: result.deliveryError ?? null,
    mechanism,
    duplicate: false,
    retryable: result.retryable === true,
    text: summary
  };
}

/**
 * Close a claim that was written but will never be sent.
 *
 * Uses the INJECTED delivery writer, not the module-level default, so the abort
 * path and the dispatch path always go through the same executor. Writing the
 * abort through a different connection would make it possible for a test (or a
 * future caller) to observe a row that was never closed.
 *
 * Never throws: this runs on an error path and must not mask the real answer.
 */
async function closeAbortedClaim({ updateDelivery, log, args }) {
  try {
    await updateDelivery(args);
  } catch (e) {
    log.error?.(`manual reply: could not close an aborted reply [${safeErrorCode(e)}]`);
  }
}