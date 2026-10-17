/**
 * P0.3-C — the ONE customer acknowledgment sent when a customer asks for a human.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * When a customer writes "let me talk to a person", two things must happen in this
 * order:
 *
 *   1. the AI must stop and the conversation must be queued   (already done by
 *      requestHandoff, BEFORE anything in this file runs), and
 *   2. the customer must be told, once, that a person will pick this up.
 *
 * This file is only (2). It never changes conversation state, never resumes the AI,
 * and never assigns anyone. If this whole module failed, the conversation would
 * still be correctly queued and a human would still answer it — the only loss
 * would be the courtesy message. That is the whole risk profile: this feature is
 * deliberately incapable of stranding a conversation.
 *
 * WHY A FAILURE HERE MUST NOT REACTIVATE THE AI
 * ---------------------------------------------
 * It is tempting to "roll back" a failed acknowledgment by letting the AI resume.
 * That would be a serious error. The customer asked for a HUMAN; the AI resuming
 * because we failed to say "one is coming" means the customer is answered by a bot
 * after explicitly refusing to talk to one. There is no code path here that can do
 * that, and there is no `force`/`override` parameter that could be added later.
 *
 * AT MOST ONE, AND WHY THAT IS ENFORCED IN SQL
 * ---------------------------------------------
 * The durable idempotency record is INSERTed BEFORE the provider is called. Zero
 * affected rows means another actor already claimed this conversation's single
 * acknowledgment, and we return without sending. Because the insert and the
 * uniqueness constraint are what stand between the decision and the irreversible
 * provider call, a webhook redelivery, a Worker retry, a process restart between
 * insert and send, and two concurrent events on separate connections all collapse
 * to the same single message — by construction, not by convention.
 *
 * WE DO NOT CLAIM EXACTLY-ONCE PROVIDER DELIVERY
 * ----------------------------------------------
 * We guarantee at most one ATTEMPT. Once the provider has been called, a timeout
 * leaves the outcome genuinely unknown and it is recorded as `unknown`, which is
 * never retried. Retrying a timeout is exactly how a customer ends up with two
 * "someone will reply soon" messages. The database comment says the same thing.
 */

import { pool } from '../db/pg.js';
import { resolveCredentialForChannel } from './channelResolver.js';
import { createMetaClient } from '../facebook.js';
import { classifyDeliveryError } from './deliveryOutcome.js';
import {
  messagingWindowSeconds,
  SENDABLE_CHANNEL_PROVIDERS
} from './manualReplies.js';
import { REQUESTED_BY } from './handoff.js';
import { HANDOFF_REASONS } from './handoffDetector.js';

/* --------------------------------------------------------------- vocabulary */

export const ACK_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped'
});

/**
 * `pending` HAS TWO MEANINGS, and only one of them is benign.
 *
 * Normally it means "claimed a few milliseconds ago, the provider has not answered
 * yet". But if the process dies between the INSERT and the outcome UPDATE, the row
 * stays `pending` for ever. Nobody ever writes to it again.
 *
 * WHY IT IS LEFT ALONE RATHER THAN REAPED
 * ---------------------------------------
 *   - Retrying is unsafe. The provider call may have already delivered the message,
 *     so a retry risks the customer receiving two reassurances.
 *   - Deleting the row is worse. The unique index on (tenant_id, conversation_id) is
 *     the ONLY thing preventing a duplicate, so removing a stuck row would hand the
 *     single slot back and permit exactly the duplicate this design exists to stop.
 *   - Marking it `failed` would be a guess in the unsafe direction: it reads as
 *     "definitely not delivered", which is not something anyone knows.
 *
 * So the record stays `pending` forever, and the presentation is what does the work:
 * staff are shown it as an UNCERTAIN outcome — the same treatment as `unknown` —
 * together with its age, because how long it has been stuck is what tells an
 * operator this is a dead record rather than a send still landing.
 */

/**
 * Every way an acknowledgment can be declined WITHOUT attempting a send.
 *
 * All of these are silent and safe: the conversation is queued either way. They are
 * recorded rather than thrown so staff can see, afterwards, that no reassurance
 * was sent and why.
 */
export const ACK_SKIP_REASONS = Object.freeze({
  NOT_CUSTOMER_REQUESTED: 'not_customer_requested',
  CONVERSATION_MISSING: 'conversation_missing',
  CHANNEL_UNSUPPORTED: 'channel_unsupported',
  CHANNEL_INACTIVE: 'channel_inactive',
  WINDOW_CLOSED: 'window_closed',
  LANGUAGE_UNDETERMINED: 'language_undetermined',
  DUPLICATE: 'duplicate'
});

export const ACK_LANGUAGES = Object.freeze(['ar', 'en']);

/**
 * The acknowledgment text.
 *
 * Egyptian Arabic for Arabic conversations, English for English ones.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. It does not claim the customer has been
 * answered, name an employee, or promise a specific time. It says only that the
 * request reached a queue a person works from.
 *
 * WHY THE EARLIER WORDING WAS REPLACED, AND WHAT WAS WRONG WITH IT
 * --------------------------------------------------------------
 * The previous text said the team had been NOTIFIED and would reply SHORTLY.
 * Neither was true at the moment the message was sent:
 *
 *   - Nothing notifies anybody on this path. `notifyStaff` is wired to the
 *     AUTOMATIC-escalation branch, not to customer-requested-human. A request for
 *     a person produced a queue row that a human has to notice by themselves, so
 *     telling the customer "we notified the team" described something the system
 *     had not done.
 *   - There is no SLA and no queue-age alarm anywhere in this codebase, so
 *     "shortly" was a promise nothing was ever going to be measured against.
 *
 * The replacement claims only what is verifiable: the request was ADDED TO A
 * QUEUE and a team member will FOLLOW UP. Both are already true when this text is
 * sent, because `requestHandoff` has committed the transition to QUEUED and written
 * the escalation row before this file is reached.
 *
 * It still gives the customer something worth receiving — their message reached a
 * person-controlled queue instead of a bot — and that is the one reassurance the
 * system can actually back up.
 */
export const ACKNOWLEDGMENT_TEXT = Object.freeze({
  ar: 'تم تحويل طلبك لفريق خدمة العملاء، وهيتم متابعة محادثتك من خلال أحد أفراد الفريق. شكرًا لانتظارك.',
  en: 'Your request has been added to our customer support queue for a team member to follow up. Thank you for your patience.'
});

/**
 * Why the English variant exists in a product that is Arabic-first: a customer
 * writing in English is far more likely to be served by an agent who also writes in
 * English. Sending them Egyptian Arabic is not a courtesy, it is noise.
 */

/* ------------------------------------------------------- pure helpers (tests) */

/**
 * Resolve the acknowledgment language, or null when it cannot be determined.
 *
 * Returning null rather than a default is the important part. Guessing Arabic for a
 * conversation whose language nobody recorded would send an Arabic message to a
 * customer who demonstrably does not read it, which is worse than sending nothing.
 * A `skipped` record explains the gap to staff; a wrong message cannot be undone.
 *
 * ABSENT AND UNSUPPORTED ARE DIFFERENT THINGS, and conflating them is the bug this
 * ordering prevents:
 *
 *   - No language recorded  -> fall back to the BRAND's configured language. The
 *     company has stated what its customers write in; that is real information.
 *   - A language recorded that we do not speak (`fr`, `de`) -> null. We know the
 *     customer writes something we cannot serve, so falling back to the brand
 *     default would send Arabic to a French speaker. "Unknown" is not the same as
 *     "unsupported", and treating it as such produces confidently wrong messages.
 *
 * `ar-EG`, `ar_EG`, `AR` all resolve to `ar`: the prefix is what identifies the
 * language, the region is not a separate language.
 */
export function resolveAckLanguage({ conversationLanguage, brandDefaultLanguage } = {}) {
  const primary = (value) =>
    (typeof value === 'string' && value.trim())
      ? value.trim().toLowerCase().split(/[-_]/)[0]
      : null;

  const fromConversation = primary(conversationLanguage);
  if (fromConversation !== null) {
    // A language WAS recorded. If we do not support it, do not substitute another.
    return ACK_LANGUAGES.includes(fromConversation) ? fromConversation : null;
  }

  const fromBrand = primary(brandDefaultLanguage);
  return fromBrand !== null && ACK_LANGUAGES.includes(fromBrand) ? fromBrand : null;
}

/**
 * The acknowledgment text for a resolved language.
 * Returns null for an undetermined language so the caller records a skip rather
 * than sending something guessed.
 */
export function acknowledgmentTextFor(language) {
  return ACKNOWLEDGMENT_TEXT[language] ?? null;
}

/**
 * Pure provider-eligibility check.
 *
 * Mirrors the manual-reply rules exactly (SENDABLE_CHANNEL_PROVIDERS, an active
 * channel, an open messaging window) so a customer can never find themselves in a
 * state where a human could reply but the acknowledgment could not, or worse.
 *
 * It grants nothing. The provider call is still guarded by the insert below, and
 * still re-checks nothing it was told: a pure predicate is documentation and a test
 * surface, never an authorisation boundary.
 */
export function evaluateAckEligibility({ conversation } = {}) {
  if (!conversation) return { eligible: false, reason: ACK_SKIP_REASONS.CONVERSATION_MISSING };
  if (!conversation.channelProvider || !SENDABLE_CHANNEL_PROVIDERS.includes(conversation.channelProvider)) {
    return { eligible: false, reason: ACK_SKIP_REASONS.CHANNEL_UNSUPPORTED };
  }
  if (conversation.channelStatus && conversation.channelStatus !== 'active') {
    return { eligible: false, reason: ACK_SKIP_REASONS.CHANNEL_INACTIVE };
  }
  if (!conversation.lastInboundAt) {
    return { eligible: false, reason: ACK_SKIP_REASONS.WINDOW_CLOSED };
  }
  const age = (Date.now() - new Date(conversation.lastInboundAt).getTime()) / 1000;
  if (age > messagingWindowSeconds()) {
    return { eligible: false, reason: ACK_SKIP_REASONS.WINDOW_CLOSED };
  }
  if (!resolveAckLanguage({
    conversationLanguage: conversation.language,
    brandDefaultLanguage: conversation.brandDefaultLanguage
  })) {
    return { eligible: false, reason: ACK_SKIP_REASONS.LANGUAGE_UNDETERMINED };
  }
  return { eligible: true, reason: null };
}

/* -------------------------------------------------------------- the record */

/**
 * Build the idempotency key.
 *
 * Derived from the conversation, not from the event, so that a webhook redelivery
 * of the same message and a Worker retry of the same handoff both produce the same
 * key. It is not a secret and not a credential.
 */
export function acknowledgmentIdempotencyKey(tenantId, conversationId) {
  return `handoff-ack:${tenantId}:${conversationId}`;
}

/* ------------------------------------------------------------- the sender */

/**
 * Send the acknowledgment for a conversation whose handoff has ALREADY happened.
 *
 * Call this ONLY from the customer-requested-human branch, AFTER `requestHandoff`
 * returned. It is never called for staff-initiated handoff (nobody has approved
 * telling a customer their team took a conversation nobody was in) and never for an
 * automatic escalation (the customer never asked for a person, so promising one
 * would be a lie).
 *
 * Never throws for an expected condition — every refusal is a return value. The one
 * exception is an unexpected infrastructure failure, which propagates so the caller
 * can log it; even then no conversation state has been touched by the time it can.
 */
export async function maybeAcknowledgeHandoff({ tenantId, conversationId, requestedBy, reason }, deps = {}) {
  const {
    db = pool,
    resolveCredential = resolveCredentialForChannel,
    createClient = createMetaClient,
    log = console
  } = deps;

  // ---- 0. Is this even an approved acknowledgment? -----------------------
  // Both conditions are required. `requestedBy` alone is not enough, because an
  // AUTO escalation is also raised by the customer; only an explicit request for a
  // person is something we are entitled to acknowledge.
  if (requestedBy !== REQUESTED_BY.CUSTOMER || reason !== HANDOFF_REASONS.CUSTOMER_REQUESTED_HUMAN) {
    return { attempted: false, status: ACK_STATUS.SKIPPED, skipReason: ACK_SKIP_REASONS.NOT_CUSTOMER_REQUESTED };
  }

  // ---- 1. Load the conversation and decide eligibility -------------------
  const { rows } = await db.query(
    `SELECT c.id, c.state, c.channel_id, c.external_key, c.language,
            ch.provider AS channel_provider,
            ch.status   AS channel_status,
            ch.brand_id,
            br.default_language AS brand_default_language,
            (SELECT max(COALESCE(m.provider_ts, m.created_at)) FROM messages m
              WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS last_inbound_at
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN brands   br ON br.id = ch.brand_id
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );

  const row = rows[0];
  const conversation = row && {
    id: row.id,
    state: row.state,
    channelId: row.channel_id,
    externalKey: row.external_key,
    language: row.language,
    channelProvider: row.channel_provider,
    channelStatus: row.channel_status,
    brandId: row.brand_id,
    brandDefaultLanguage: row.brand_default_language,
    lastInboundAt: row.last_inbound_at
  };

  const eligibility = evaluateAckEligibility({ conversation });
  const language = conversation ? resolveAckLanguage(conversation) : null;

  if (!eligibility.eligible) {
    // A conversation we cannot even load still gets a record, so that "why was
    // there no reassurance?" has an answer in the panel rather than being silence.
    await recordSkip({ tenantId, conversationId, conversation, language, reason: eligibility.reason, db })
      .catch((e) => log.error?.(`handoff ack: could not record skip [${e?.code ?? 'error'}]`));
    return { attempted: false, status: ACK_STATUS.SKIPPED, skipReason: eligibility.reason };
  }

  const text = acknowledgmentTextFor(language);
  const idempotencyKey = acknowledgmentIdempotencyKey(tenantId, conversationId);

  // ---- 2. CLAIM THE SINGLE SLOT, BEFORE touching the provider -----------
  // This is the whole idempotency mechanism. Zero rows means somebody else already
  // claimed it — a redelivered webhook, a retried worker, a restart mid-send — and
  // the correct action is to do nothing at all.
  let claimed;
  try {
    const ins = await db.query(
      `INSERT INTO handoff_acknowledgments
         (tenant_id, conversation_id, channel_id, brand_id, provider, external_key,
          language, status, message_text, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
       ON CONFLICT (tenant_id, conversation_id) DO NOTHING
       RETURNING id`,
      [
        tenantId, conversationId, conversation.channelId ?? null, conversation.brandId ?? null,
        conversation.channelProvider, conversation.externalKey ?? null,
        language, text, idempotencyKey
      ]
    );
    claimed = ins.rows[0];
  } catch (e) {
    // If the table does not exist yet (migration 018 not applied) this throws. The
    // conversation is already queued and safe, so degrade to "not attempted" and
    // say so loudly rather than taking the webhook down.
    log.error?.(`handoff ack: could not create the idempotency record [${e?.code ?? 'error'}]`);
    return { attempted: false, status: ACK_STATUS.SKIPPED, skipReason: 'record_unavailable' };
  }

  if (!claimed) {
    return {
      attempted: false,
      status: ACK_STATUS.SKIPPED,
      skipReason: ACK_SKIP_REASONS.DUPLICATE,
      alreadyAcknowledged: true
    };
  }

  const ackId = claimed.id;

  // ---- 3. Resolve the credential ----------------------------------------
  // Provider authorisation that cannot be established is not a licence to guess.
  let credential = null;
  try {
    credential = await resolveCredential({
      channelId: conversation.channelId,
      tenantId,
      db
    });
  } catch (e) {
    log.error?.(`handoff ack: credential resolution failed [${e?.code ?? 'error'}]`);
  }
  if (!credential) {
    await finalise({ db, ackId, status: ACK_STATUS.FAILED, deliveryError: 'credential_missing' });
    return { attempted: false, status: ACK_STATUS.FAILED, deliveryError: 'credential_missing', ackId };
  }

  // ---- 4. THE IRREVERSIBLE CALL ------------------------------------------
  let response = null;
  let failure = null;
  try {
    const client = createClient({ accessToken: credential });
    response = await client.sendMessengerReply(conversation.externalKey, text);
  } catch (err) {
    failure = err;
  }

  // ---- 5. Record the outcome. No retry path exists from here. -----------
  if (!failure) {
    const providerMessageId = response?.message_id ?? null;
    await finalise({ db, ackId, status: ACK_STATUS.SENT, providerMessageId, deliveryStatus: 'sent' });
    log.log?.(`🤝 [ack] customer acknowledged on ${conversationId} (${language})`);
    return { attempted: true, status: ACK_STATUS.SENT, providerMessageId, ackId };
  }

  // A timeout or a 5xx leaves the outcome genuinely undetermined. Recording it as
  // `unknown` — never as `failed` and never as retryable — is what stops a later
  // pass from offering the customer a second copy of a message they may already
  // have. The shared classifier already encodes this; reusing it rather than
  // re-deriving it keeps the two send paths from disagreeing.
  const outcome = classifyDeliveryError(failure);
  const status = outcome.deliveryStatus === 'failed'
    ? ACK_STATUS.FAILED
    : ACK_STATUS.UNKNOWN;
  await finalise({
    db,
    ackId,
    status,
    deliveryStatus: outcome.deliveryStatus,
    deliveryError: outcome.category ?? null
  });
  log.error?.(`handoff ack: delivery ${status} [${outcome.category ?? 'unknown'}]`);
  return {
    attempted: true,
    status,
    deliveryError: outcome.category ?? null,
    // Explicitly false even when the classifier calls it retryable: an
    // acknowledgment is never retried by this module, under any outcome.
    retryable: false,
    retrySuppressed: outcome.retryable === true,
    ackId
  };
}

/* ------------------------------------------------------------- persistence */

async function recordSkip({ tenantId, conversationId, conversation, language, reason, db }) {
  await db.query(
    `INSERT INTO handoff_acknowledgments
       (tenant_id, conversation_id, channel_id, brand_id, provider, external_key,
        language, status, skip_reason, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'skipped',$8,$9)
     ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
    [
      tenantId, conversationId,
      conversation?.channelId ?? null, conversation?.brandId ?? null,
      conversation?.channelProvider ?? 'unknown', conversation?.externalKey ?? null,
      language, reason, acknowledgmentIdempotencyKey(tenantId, conversationId)
    ]
  );
}

/**
 * Close out the claimed record.
 *
 * A failure to write here is logged and swallowed: the message may already have
 * reached the customer, and losing the bookkeeping must not turn a delivered
 * reassurance into a thrown error that the webhook reports as a failure. The row
 * stays `pending`, which is the honest representation of "we cannot say".
 */
async function finalise({ db, ackId, status, deliveryStatus = null, deliveryError = null, providerMessageId = null }) {
  try {
    await db.query(
      `UPDATE handoff_acknowledgments
          SET status = $2,
              delivery_status = $3,
              delivery_error = $4,
              provider_message_id = $5,
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
              updated_at = now()
        WHERE id = $1`,
      [ackId, status, deliveryStatus, deliveryError, providerMessageId]
    );
  } catch {
    /* deliberately swallowed — see the doc comment above */
  }
}

/**
 * Read the acknowledgment for a conversation, for staff display.
 *
 * Returns null when none exists. The panel uses this to explain, without ever
 * implying the customer was answered, whether a reassurance was sent and what
 * became of it.
 */
export async function getHandoffAcknowledgment({ tenantId, conversationId, db = pool }) {
  const { rows } = await db.query(
    `SELECT id, status, skip_reason, language, provider, delivery_status,
            delivery_error, provider_message_id, created_at, sent_at
       FROM handoff_acknowledgments
      WHERE tenant_id = $1 AND conversation_id = $2`,
    [tenantId, conversationId]
  );
  return rows[0] ?? null;
}