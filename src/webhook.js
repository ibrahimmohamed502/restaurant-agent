import crypto from 'node:crypto';
import express from 'express';
import { buildRouteContext } from './services/routeContext.js';
import { analyzeAndDraft } from './agent.js';
import { enforceGrounding, localize, NOT_CONFIRMED_REPLY } from './services/grounding.js';
import { runShadowRetrieval } from './services/shadowRetrieval.js';
import { generateWithRetrieval } from './services/activeGeneration.js';
import { notifyStaff } from './notify.js';
import { logEvent, addEscalation } from './db.js';
import { enabled } from './db/pg.js';
import {
  findOrCreateChannel,
  findOrCreateCustomer,
  findOrCreateConversation,
  persistInboundMessage,
  persistOutboundMessage,
  updateMessageDelivery,
  deliveryErrorCategory,
  createEscalationRecord,
  escalationCategory
} from './services/conversations.js';
import { evaluateAiGate } from './services/aiGate.js';
import { detectCustomerHumanRequest, detectAutoEscalation, HANDOFF_REASONS } from './services/handoffDetector.js';
import { requestHandoff, REQUESTED_BY } from './services/handoff.js';
import { alreadyReplied, markReplied, userOverLimit } from './store.js';
import { redactId, textSummary, safeErrorCode } from './services/redact.js';

export const webhookRouter = express.Router();

// Stage 4.3B.2 note: the routed path NEVER uses a global FB_PAGE_ID for routing or
// self-skip — every routed event uses ctx.pageId from buildRouteContext(entry).

/* ------------------------------------------------------------------ */
/* GET /webhook — Meta verification handshake                          */
/* ------------------------------------------------------------------ */
webhookRouter.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('⛔ Webhook verification failed — check WEBHOOK_VERIFY_TOKEN');
  return res.sendStatus(403);
});

/* ------------------------------------------------------------------ */
/* POST /webhook — incoming comment events                             */
/* ------------------------------------------------------------------ */
webhookRouter.post('/webhook', (req, res) => {
  // 1. Signature first: an unsigned or forged event never reaches the database.
  if (!verifySignature(req)) {
    console.warn('⛔ Invalid X-Hub-Signature-256 — request rejected');
    return res.sendStatus(401);
  }

  // 2. Shape only — never the payload (it carries text, PSIDs and names).
  const entries = Array.isArray(req.body?.entry) ? req.body.entry.length : 0;
  const dmCount = (req.body?.entry ?? []).reduce((n, e) => n + (e?.messaging?.length ?? 0), 0);
  console.log(`📩 Webhook POST received: entries=${entries} dm=${dmCount}`);

  // 3. DURABLE INTAKE BEFORE THE ACK.
  //    The event is recorded (provider, external_id) — the idempotency record —
  //    and only then acknowledged. No AI call, no outbound Meta call and no
  //    queue push happens before the 200, so the response stays fast.
  intakeWebhookBody(req.body)
    .then((intake) => {
      res.sendStatus(200); // accepted durably — Meta will not retry
      // 4. After the ACK: queue it, or handle inline if the queue is down.
      dispatchWebhookBody(req.body, intake)
        .catch((err) => console.error('❌ dispatch failed:', safeErrorCode(err)));
    })
    .catch((err) => {
      // Intake could not be persisted: answering 200 would silently lose the
      // event. 503 is retryable, so Meta re-delivers it later.
      console.error('⛔ durable intake failed — returning 503 for Meta retry:', safeErrorCode(err));
      if (!res.headersSent) res.sendStatus(503);
    });
});

/**
 * Verify the Meta webhook signature.
 *
 * FAIL CLOSED: a missing FB_APP_SECRET rejects every POST. Accepting unverified
 * events would let anyone forge an event and drive real outbound AI replies.
 */
function verifySignature(req) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) return false; // fail closed: no secret => no event is trusted
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Flow from the diagram: intake → AI engine → reply to EVERY comment  */
/* ------------------------------------------------------------------ */

/** Processing mode: 'inline' (default, current behavior) or 'queue' (worker). */
export function webhookProcessingMode() {
  return process.env.WEBHOOK_QUEUE_MODE === 'queue' ? 'queue' : 'inline';
}

/**
 * INTAKE PHASE — runs BEFORE the HTTP 200 and never processes anything.
 *
 * Normalizes the payload and writes one idempotency row per event. The
 * UNIQUE (provider, external_id) constraint is what makes concurrent Meta
 * redelivery safe: the second insert returns nothing and is counted as a
 * duplicate.
 *
 * Throws if the row cannot be persisted, which the route turns into a 503 so
 * Meta re-delivers instead of the event being lost.
 */
export async function intakeWebhookBody(body, deps = {}) {
  if (body?.object !== 'page') return { events: [], duplicates: 0 };
  const { normalizeMetaWebhook } = await import('./providers/meta/normalizer.js');
  const normalize = deps.normalize ?? normalizeMetaWebhook;
  const events = normalize(body);

  // Legacy / local mode: no database is configured, so there is nothing to
  // record against. Behaviour is unchanged from before (inline only).
  const { enabled } = await import('./db/pg.js');
  if (!deps.record && !enabled) return { events, duplicates: 0, legacy: true };

  let record = deps.record;
  if (!record) {
    const svc = await import('./services/webhookEvents.js');
    record = svc.recordWebhookEvent;
  }
  const accepted = [];
  let duplicates = 0;
  for (const ev of events) {
    const row = await record(ev); // throws => 503 (Meta retries, nothing is lost)
    if (!row) { duplicates++; continue; }
    accepted.push(ev);
  }
  return { events: accepted, duplicates };
}

/**
 * DISPATCH PHASE — runs AFTER the 200 and never touches the database for
 * deduplication (that already happened).
 *
 * Each already-recorded event is pushed onto the queue. If the queue is
 * unavailable the event is handled inline and its durable row is kept, so a
 * redelivery is still suppressed.
 */
export async function queueIntake(events, deps = {}) {
  const {
    enqueueMetaEvent,
    markWebhookEventInline
  } = deps;
  const result = { enqueued: 0, duplicates: 0, fallbackEvents: [], noIntake: [] };
  for (const ev of events ?? []) {
    try {
      await enqueueMetaEvent(ev);
      result.enqueued++;
    } catch (e) {
      // The row is the idempotency record and is KEPT: deleting it would free
      // the (provider, external_id) slot and let a concurrent redelivery be
      // processed a second time — a duplicate AI reply.
      console.warn(`⚠️ enqueue failed (${safeErrorCode(e)}) — handling inline, intake row kept`);
      await markWebhookEventInline(ev.provider, ev.eventId).catch(() => undefined);
      result.fallbackEvents.push(ev);
    }
  }
  return result;
}

/** Terminal state for events that were handled inline instead of queued. */
async function completeInlineEvents(events, status) {
  const { updateWebhookEvent } = await import('./services/webhookEvents.js');
  for (const ev of events) {
    await updateWebhookEvent({
      provider: ev.provider,
      externalId: ev.eventId,
      status,
      error: status === 'done' ? null : 'INLINE_FAILED'
    }).catch(() => undefined);
  }
}

/**
 * Queue an already-recorded intake. Only queue infrastructure can fail here —
 * the idempotency row is already durable, so a redelivery stays suppressed.
 */
async function enqueueRecordedEvents(events) {
  const { markWebhookEventInline } = await import('./services/webhookEvents.js');
  const { enqueueMetaEvent } = await import('./queues/metaEvents.js');
  return queueIntake(events, { enqueueMetaEvent, markWebhookEventInline });
}

/**
 * DISPATCH PHASE — everything below runs AFTER the 200, so no AI inference and
 * no outbound Meta call delays the webhook response.
 *
 * `intake` is the result of intakeWebhookBody(): the events that were durably
 * recorded, plus the duplicate count.
 */
export async function dispatchWebhookBody(body, intake = { events: [], duplicates: 0 }, handlers = {}) {
  const {
    buildCtx = buildRouteContext,
    onComment = processComment,
    onMessage = processMessage,
    enqueueFn = enqueueRecordedEvents
  } = handlers;
  if (body?.object !== 'page') return;

  const recorded = intake?.events ?? [];
  const duplicates = intake?.duplicates ?? 0;

  // Legacy mode (no database configured): there is no intake to deduplicate
  // against, so the whole payload is processed — exactly as before intake
  // existed.
  if (intake?.legacy) {
    await processInline(body, { buildCtx, onComment, onMessage }, null);
    return;
  }

  // Inline mode: everything recorded is handled here, still deduplicated by the
  // durable rows (a redelivery never reaches this point twice).
  if (webhookProcessingMode() !== 'queue' || handlers.skipQueue) {
    if (recorded.length) {
      await processInline(body, { buildCtx, onComment, onMessage }, new Set(recorded.map((e) => e.eventId)));
      await completeInlineEvents(recorded, 'done');
    }
    return;
  }

  let outcome;
  try {
    outcome = await enqueueFn(recorded);
  } catch (err) {
    // Queue infrastructure is unavailable: answer the customer inline instead
    // of dropping the event. The intake rows stay, so a redelivery of the same
    // event is still suppressed.
    console.warn(`⚠️ queue unavailable (${safeErrorCode(err)}) — handling inline`);
    outcome = { enqueued: 0, duplicates: 0, fallbackEvents: recorded, noIntake: [] };
  }

  if (outcome.fallbackEvents?.length) {
    try {
      await processInline(body, { buildCtx, onComment, onMessage }, new Set(outcome.fallbackEvents.map((e) => e.eventId)));
      await completeInlineEvents(outcome.fallbackEvents, 'done');
    } catch (err) {
      await completeInlineEvents(outcome.fallbackEvents, 'failed');
      throw err;
    }
  }
  if (outcome.enqueued || duplicates) {
    console.log(`📥 queued ${outcome.enqueued} event(s)${duplicates ? `, ${duplicates} duplicate(s) skipped` : ''}`);
  }
}

/**
 * Legacy entry point: normalise → dispatch. Callers that already hold a durable
 * intake must use dispatchWebhookBody instead. Kept for the inline/test paths.
 */
export async function handlePayload(body, handlers = {}) {
  // A caller that already holds a durable intake can pass it in (tests, and
  // any future caller that records elsewhere). Otherwise it is computed here.
  const intake = handlers.intake ?? await intakeWebhookBody(body);
  return dispatchWebhookBody(body, intake, handlers);
}

/** Original inline processing loop. `onlyEventIds` restricts processing to a subset. */
async function processInline(body, { buildCtx, onComment, onMessage }, onlyEventIds) {
  for (const entry of body.entry ?? []) {
    // ---- Resolve the DB-driven routing context ONCE per entry (fail closed) ----
    let ctx;
    try {
      ctx = await buildCtx(entry);
    } catch (err) {
      // sanitized: only the safe error code / page id — never credentials
      console.warn(`⏭️ Skipping webhook entry ${entry?.id ?? '(no id)'} — routing failed: ${err?.code ?? 'RESOLVE_FAILED'}`);
      continue;
    }

    // ---- Channel 1: page feed comments ----
    for (const change of entry.changes ?? []) {
      if (change.field !== 'feed') continue;
      const v = change.value;
      // Only brand-new comments (skip edits, deletes, reactions, posts…)
      if (v?.item !== 'comment' || v?.verb !== 'add') continue;
      if (onlyEventIds && !onlyEventIds.has(v?.comment_id)) continue;

      await onComment(v, ctx).catch((err) =>
        console.error(`❌ Failed on comment (${redactId(v?.comment_id)}):`, safeErrorCode(err))
      );
    }

    // ---- Channel 2: Messenger DMs ----
    for (const event of entry.messaging ?? []) {
      const mid = event?.message?.mid;
      if (onlyEventIds && !onlyEventIds.has(mid)) continue;
      await onMessage(event, ctx).catch((err) =>
        console.error(`❌ Failed on DM (${redactId(event?.sender?.id)}):`, safeErrorCode(err))
      );
    }
  }
}

/**
 * Stage 7 — the shared AI stop/continue gate.
 *
 * Runs for BOTH comment and DM processing, AFTER the inbound customer message
 * has been persisted and BEFORE retrieval / generation / grounding / outbound
 * persistence / provider send.
 *
 * Two ways the AI gets switched off, and only these two:
 *   1. the conversation is already in a human-handled state, or
 *   2. the customer has explicitly requested a human (deterministic detector).
 *
 * When suppressed: the inbound message is already persisted, nothing is
 * generated, no outbound row is created, and no provider call is made.
 * Existing escalation behaviour (complaints / contact data) is NOT affected —
 * it never pauses the AI.
 *
 * @returns {Promise<{suppressed: boolean, state: string|null}>}
 */
async function applyStage7Gate({ tenantId, conversationId, text, pgEnabled }) {
  if (!pgEnabled || !tenantId || !conversationId) return { suppressed: false, state: null };

  const gate = await evaluateAiGate({ tenantId, conversationId });
  if (gate.suppressed) {
    console.log(`🤝 [stage7] AI suppressed for ${conversationId} — state=${gate.state} (human handling)`);
    return { suppressed: true, state: gate.state };
  }

  // 1) Check explicit human request
  const detection = detectCustomerHumanRequest(text);
  if (detection.matched) {
    try {
      await requestHandoff(
        {
          tenantId,
          conversationId,
          reason: HANDOFF_REASONS.CUSTOMER_REQUESTED_HUMAN,
          priority: 'high',
          requestedBy: REQUESTED_BY.CUSTOMER
        }
      );
      console.log(`🤝 [stage7] customer requested a human for ${conversationId} — AI stopped`);
    } catch (e) {
      const after = await evaluateAiGate({ tenantId, conversationId });
      if (after.suppressed) return { suppressed: true, state: after.state };
      console.error('⚠️ stage7 customer handoff failed:', safeErrorCode(e));
    }
    return { suppressed: true, state: 'QUEUED' };
  }

  // 2) Check auto-escalation triggers (food blogger, supplier, legal, events, etc.)
  const autoDetection = detectAutoEscalation(text);
  if (autoDetection.matched) {
    try {
      await requestHandoff(
        {
          tenantId,
          conversationId,
          reason: HANDOFF_REASONS.AUTO_ESCALATION,
          priority: 'high',
          requestedBy: REQUESTED_BY.CUSTOMER
        }
      );
      console.log(`🤝 [stage7] auto-escalation triggered for ${conversationId} (pattern: ${autoDetection.pattern}) — AI stopped`);
    } catch (e) {
      const after = await evaluateAiGate({ tenantId, conversationId });
      if (after.suppressed) return { suppressed: true, state: after.state };
      console.error('⚠️ stage7 auto-escalation handoff failed:', safeErrorCode(e));
    }
    return { suppressed: true, state: 'QUEUED' };
  }

  return { suppressed: false, state: gate.state };
}

/**
 * Stage 7 / OBJ-8 — final lightweight state check, taken immediately before the
 * AI outbound row is created and the provider send is issued.
 *
 * This does NOT eliminate the bounded in-flight window (an AI event that passed
 * the gate a moment before a handoff can still be in flight) — it only shrinks
 * it. Persist-first inbound behaviour is never compromised.
 */
async function finalAiSendCheck({ tenantId, conversationId, pgEnabled }) {
  if (!pgEnabled || !tenantId || !conversationId) return { suppressed: false };
  const gate = await evaluateAiGate({ tenantId, conversationId });
  return { suppressed: gate.suppressed, state: gate.state };
}

// handlePayload is exported inline above (legacy inline/test entry point).
export { processComment, processMessage };

/* ------------------------------------------------------------------ */
/* Messenger DM flow: typing → same AI engine → reply                  */
/* ------------------------------------------------------------------ */
async function processMessage(event, ctx, deps = {}) {
  const {
    analyze = analyzeAndDraft,
    notify = notifyStaff,
    logEvt = logEvent,
    addEsc = addEscalation,
    isReplied = alreadyReplied,
    mark = markReplied,
    overLimit = userOverLimit,
    pgEnabled = enabled
  } = deps;
  const msg = event.message;
  const psid = event.sender?.id;

  if (!psid || psid === ctx.pageId) return;
  // Skip our own echoed messages, delivery/read receipts, postbacks…
  if (!msg || msg.is_echo || msg.delivery || msg.read) return;
  if (isReplied(msg.mid)) return;

  const limit = Number(process.env.MAX_REPLIES_PER_USER_PER_HOUR || 30);
  if (overLimit(psid, limit)) {
    console.warn(`⚠️ DM anti-abuse cap hit for ${redactId(psid)} — skipping`);
    return;
  }

  const text = msg.text || '';
  console.log(`💬 New DM: who=${redactId(psid)} chars=${textSummary(text).chars} media=${textSummary(text).mediaOnly}`);

  await ctx.metaClient.sendTypingIndicator(psid);
  const authorName = await ctx.metaClient.getUserFirstName(psid);

  // ---- Stage 4.4.6: PERSIST INBOUND FIRST (before AI / grounding / Meta) ----
  let conversationId = null;
  if (pgEnabled) {
    try {
      const tenantId = ctx?.tenantId;
      if (tenantId) {
        const channelId = await findOrCreateChannel({ tenantId, brandId: ctx.brandId ?? null, provider: 'meta_dm', externalId: ctx.pageId, displayName: 'Messenger DM' });
        const customerId = await findOrCreateCustomer({ tenantId, provider: 'meta_dm', externalId: psid, name: authorName });
        conversationId = await findOrCreateConversation({ tenantId, channelId, externalKey: psid, customerId });
        const inbound = await persistInboundMessage({ tenantId, conversationId, text, providerMessageId: msg.mid, providerTs: event.timestamp ? new Date(event.timestamp) : null });
        if (inbound.duplicate) {
          console.log(`↩️  DM (${redactId(msg.mid)}) already persisted — skipping (webhook redelivery)`);
          return;
        }
      }
    } catch (e) {
      console.error('⚠️ inbound persist failed (dm):', safeErrorCode(e));
    }
  }

  // Stage 7 gate: check if AI should be suppressed BEFORE generation
  const gate = await applyStage7Gate({ tenantId: ctx?.tenantId, conversationId, text, pgEnabled });
  if (gate.suppressed) {
    console.log(`🤝 [stage7] AI suppressed for DM ${redactId(msg.mid)} — state=${gate.state}`);
    return;
  }

  // Stage 4.4.3: scoped AI path — ctx is mandatory. No legacy/global retry.
  // Stage 6 Batch 3B: active mode → retrieval-grounded generation (safe fallback
  // on failure — never the legacy Path A).
  let draft;
  try {
    draft = (await generateWithRetrieval({ text, authorName, channel: 'dm', ctx, analyzeFn: analyze })).draft;
  } catch (err) {
    if (err?.code === 'AI_CONTEXT_UNAVAILABLE') {
      console.warn(`⛔ [${ctx.pageId}] scoped AI context unavailable — DM not answered (fail closed)`);
    } else {
      console.error(`❌ AI failed on DM ${redactId(msg.mid)}:`, safeErrorCode(err));
    }
    await persistOutboundFailure(conversationId, ctx, { pgEnabled });
    return;
  }
  // ---- Deterministic grounding guard (Stage 4.4.5) ----
  const dmKnowledge = draft?._knowledge ?? null;
  if (dmKnowledge) {
    const guarded = enforceGrounding(draft, { knowledge: dmKnowledge, lang: draft.lang });
    if (guarded.rejected) {
      console.warn(`⚠️ [${ctx.pageId}] grounding violation (${guarded.reasons.join(',')}) — using safe fallback reply`);
      draft = { ...draft, reply: localize(NOT_CONFIRMED_REPLY, draft.lang), _knowledge: dmKnowledge };
    } else {
      draft = guarded.draft;
    }
  }

  // Stage 7 final check before sending
  const finalCheck = await finalAiSendCheck({ tenantId: ctx?.tenantId, conversationId, pgEnabled });
  if (finalCheck.suppressed) {
    console.log(`🤝 [stage7] AI suppressed at final check for DM ${redactId(msg.mid)} — state=${finalCheck.state}`);
    return;
  }

  // ---- Deliver with explicit outbound lifecycle (Stage 4.4.6) ----
  let sendResp = null;
  let outboundRow = null;
  try {
    outboundRow = conversationId ? await persistOutboundMessage({ tenantId: ctx.tenantId, conversationId, text: draft.reply, deliveryStatus: 'pending' }) : null;
    sendResp = await ctx.metaClient.sendMessengerReply(psid, draft.reply);
    if (outboundRow?.id) await updateMessageDelivery({ tenantId: ctx.tenantId, messageId: outboundRow.id, deliveryStatus: 'sent', providerMessageId: sendResp?.message_id ?? null });
  } catch (err) {
    const category = deliveryErrorCategory(err);
    console.error(`❌ Failed to deliver DM to ${redactId(psid)}: [${category}]`);
    if (outboundRow?.id) await updateMessageDelivery({ tenantId: ctx.tenantId, messageId: outboundRow.id, deliveryStatus: 'failed', errorCategory: category }).catch(() => {});
    else await persistOutboundFailure(conversationId, ctx, { pgEnabled, text: draft.reply, errorCategory: category });
    mark(msg.mid, psid);
    return;
  }
  mark(msg.mid, psid);

  // Stage 6 Batch 2 — SHADOW retrieval (AFTER the reply is delivered).
  // Fire-and-forget + fail-safe: never blocks, never changes the reply path.
  void runShadowRetrieval({
    text, tenantId: ctx.tenantId, brandId: ctx.brandId,
    messageId: outboundRow?.id ?? null, conversationId
  }).catch(() => {});
  console.log(
    `✅ DM replied to ${redactId(psid)} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
  );

  // ---- Dashboard activity log ----
  logEvt({
    channel: 'messenger',
    customerName: authorName,
    customerId: psid,
    message: text,
    reply: draft.reply,
    intent: draft.intent,
    inScope: draft.inScope,
    lang: draft.lang,
    escalate: draft.escalate
  });

  // (inbound + outbound persistence already handled above — Stage 4.4.6)

  // ---- Staff alert for DMs too (blogger collabs, complaints, contact data) ----
  const reason = draft.escalate
    ? 'تصعيد في الماسنجر (شكوى/تعاون/حجز/بيانات تواصل)'
    : containsContactData(text)
      ? 'العميل ترك بيانات تواصل في الماسنجر'
      : null;
  if (reason) {
    addEsc({ channel: 'messenger', customerName: authorName, customerId: psid, message: text, reply: draft.reply, reason });
    if (conversationId) {
      try {
        await createEscalationRecord({ tenantId: ctx?.tenantId, conversationId, category: escalationCategory(reason), reason, summary: draft.intent });
      } catch (e) {
        console.error('⚠️ escalation persist failed (dm):', safeErrorCode(e));
      }
    }
    await notify({
      channel: 'messenger',
      from: { id: psid, name: authorName },
      message: text,
      reason,
      draft
    });
  }
}

async function processComment(value, ctx, deps = {}) {
  const {
    analyze = analyzeAndDraft,
    notify = notifyStaff,
    logEvt = logEvent,
    addEsc = addEscalation,
    isReplied = alreadyReplied,
    mark = markReplied,
    overLimit = userOverLimit,
    pgEnabled = enabled
  } = deps;

  const { comment_id: commentId, message = '', from } = value;
  if (!commentId || !from?.id) return;

  // Safety: never reply to the Page's own comments (prevents infinite loops)
  if (from.id === ctx.pageId) {
    console.log(`⏭️ Skipping comment ${commentId} — authored by the Page itself (comment as your PERSONAL profile to test)`);
    return;
  }

  // Safety: never reply twice to the same comment (webhook redeliveries)
  if (isReplied(commentId)) {
    console.log(`↩️  Already handled comment ${commentId} — skipping`);
    return;
  }

  // Anti-abuse cap only — genuine commenters still always get a reply
  const limit = Number(process.env.MAX_REPLIES_PER_USER_PER_HOUR || 30);
  if (overLimit(from.id, limit)) {
    console.warn(`⚠️ User ${redactId(from.id)} hit the hourly anti-abuse cap — skipping`);
    return;
  }

  console.log(`💬 New comment: who=${redactId(from.id)} chars=${textSummary(message).chars} media=${textSummary(message).mediaOnly}`);

  // ---- Stage 4.4.6: PERSIST INBOUND FIRST (before AI / grounding / Meta) ----
  // The customer's message must survive even if the LLM, grounding, or the Meta
  // publish fails. Idempotent: a Meta redelivery of the same comment is detected
  // via ON CONFLICT on (conversation_id, provider_message_id) and skips processing.
  let conversationId = null;
  if (pgEnabled) {
    try {
      const tenantId = ctx?.tenantId;
      if (tenantId) {
        const channelId = await findOrCreateChannel({ tenantId, brandId: ctx.brandId ?? null, provider: 'meta_comment', externalId: ctx.pageId, displayName: 'Facebook comments' });
        const customerId = await findOrCreateCustomer({ tenantId, provider: 'meta_comment', externalId: from.id, name: from.name });
        const externalKey = value.parent_id && value.parent_id !== value.post_id ? value.parent_id : commentId;
        conversationId = await findOrCreateConversation({ tenantId, channelId, externalKey, customerId });
        const inbound = await persistInboundMessage({ tenantId, conversationId, text: message, providerMessageId: commentId, providerTs: value.created_time ? new Date(value.created_time * 1000) : null });
        if (inbound.duplicate) {
          console.log(`↩️  Comment (${redactId(commentId)}) already persisted — skipping (webhook redelivery)`);
          return;
        }
      }
    } catch (e) {
      console.error('⚠️ inbound persist failed (comment):', safeErrorCode(e));
    }
  }

  // Stage 7 gate: check if AI should be suppressed BEFORE generation
  const gate = await applyStage7Gate({ tenantId: ctx?.tenantId, conversationId, text: message, pgEnabled });
  if (gate.suppressed) {
    console.log(`🤝 [stage7] AI suppressed for comment ${redactId(commentId)} — state=${gate.state}`);
    return;
  }

  // Stage 4.4.3: scoped AI path — ctx is mandatory. No legacy/global retry.
  // Stage 6 Batch 3B: active mode → retrieval-grounded generation (safe fallback
  // on failure — never the legacy Path A).
  let draft;
  try {
    draft = (await generateWithRetrieval({ text: message, authorName: from.name, channel: 'comment', ctx, analyzeFn: analyze })).draft;
  } catch (err) {
    if (err?.code === 'AI_CONTEXT_UNAVAILABLE') {
      console.warn(`⛔ [${ctx.pageId}] scoped AI context unavailable — comment not answered (fail closed)`);
    } else {
      console.error(`❌ AI failed on comment ${redactId(commentId)}:`, safeErrorCode(err));
    }
    await persistOutboundFailure(conversationId, ctx, { pgEnabled });
    return;
  }

  // ---- Deterministic grounding guard (Stage 4.4.5) ----
  // Reject any invented URL / phone / price not present in the scoped knowledge.
  const knowledge = draft?._knowledge ?? null;
  if (knowledge) {
    const guarded = enforceGrounding(draft, { knowledge, lang: draft.lang });
    if (guarded.rejected) {
      console.warn(`⚠️ [${ctx.pageId}] grounding violation (${guarded.reasons.join(',')}) — using safe fallback reply`);
      draft = { ...draft, reply: localize(NOT_CONFIRMED_REPLY, draft.lang), _knowledge: knowledge };
    } else {
      draft = guarded.draft;
    }
  }

  // Stage 7 final check before sending
  const finalCheck = await finalAiSendCheck({ tenantId: ctx?.tenantId, conversationId, pgEnabled });
  if (finalCheck.suppressed) {
    console.log(`🤝 [stage7] AI suppressed at final check for comment ${redactId(commentId)} — state=${finalCheck.state}`);
    return;
  }

  // Rule: reply is posted PLAIN (no @[user_id] mention). Meta rejects the legacy
  // mention syntax with "Graph API 500 (code 1)" for this app/page; a reply posted
  // to /{comment-id}/comments is already threaded under the comment and notifies
  // the commenter.
  // Meta ALSO rejects public comment replies that contain URLs (Graph error code 1,
  // "An unknown error has occurred") — links are delivered via Messenger instead.
  const finalMessage = sanitizeCommentMessage(draft.reply);

  // ---- Publish via the request-scoped routed Meta client (ctx.metaClient) ----
  let replyResp = null;
  let outboundRow = null;
  try {
    outboundRow = conversationId ? await persistOutboundMessage({ tenantId: ctx.tenantId, conversationId, text: finalMessage, deliveryStatus: 'pending' }) : null;
    replyResp = await ctx.metaClient.replyToComment(commentId, finalMessage);
    if (outboundRow?.id) await updateMessageDelivery({ tenantId: ctx.tenantId, messageId: outboundRow.id, deliveryStatus: 'sent', providerMessageId: replyResp?.id ?? null });
  } catch (err) {
    const category = deliveryErrorCategory(err);
    console.error(`❌ Failed to deliver reply for comment (${redactId(commentId)}): [${category}]`);
    if (outboundRow?.id) await updateMessageDelivery({ tenantId: ctx.tenantId, messageId: outboundRow.id, deliveryStatus: 'failed', errorCategory: category }).catch(() => {});
    else if (conversationId) await persistOutboundFailure(conversationId, ctx, { pgEnabled, text: finalMessage, errorCategory: category });
    mark(commentId, from.id); // prevent duplicate Meta retries from re-attempting publish
    return;
  }
  mark(commentId, from.id);

  console.log(
    `✅ Replied to ${redactId(commentId)} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
  );

  // Stage 6 Batch 2 — SHADOW retrieval (AFTER the reply is delivered).
  // Fire-and-forget + fail-safe: never blocks, never changes the reply path.
  void runShadowRetrieval({
    text: message, tenantId: ctx.tenantId, brandId: ctx.brandId,
    messageId: outboundRow?.id ?? null, conversationId
  }).catch(() => {});

  // ---- Dashboard activity log ----
  logEvt({
    channel: 'comment',
    customerName: from.name,
    customerId: from.id,
    message,
    reply: draft.reply,
    intent: draft.intent,
    inScope: draft.inScope,
    lang: draft.lang,
    escalate: draft.escalate
  });

  // ---- Stage 3: persist conversation in Postgres (best-effort, never breaks replies) ----
  // (Inbound was already persisted at the top of this handler — Stage 4.4.6.)

  // ---- Staff alert: escalation (complaint/collab/reservation) OR customer shared contact data ----
  const reason = draft.escalate
    ? 'تصعيد (شكوى/تعاون/حجز/بيانات تواصل)'
    : containsContactData(message)
      ? 'العميل ترك بيانات تواصل (رقم/إيميل/حساب)'
      : null;
  if (reason) {
    addEsc({ channel: 'comment', customerName: from.name, customerId: from.id, message, reply: draft.reply, reason });
    if (conversationId) {
      try {
        await createEscalationRecord({ tenantId: ctx?.tenantId, conversationId, category: escalationCategory(reason), reason, summary: draft.intent });
      } catch (e) {
        console.error('⚠️ escalation persist failed (comment):', safeErrorCode(e));
      }
    }
    await notify({ channel: 'comment', commentId, from, message, reason, draft });
  }
}

/** Stage 4.4.6 — record a sanitized delivery failure for an outbound AI message. */
async function persistOutboundFailure(conversationId, ctx, { pgEnabled, text = null, errorCategory = 'llm_error' } = {}) {
  if (!pgEnabled || !conversationId || !ctx?.tenantId) return;
  try {
    await persistOutboundMessage({ tenantId: ctx.tenantId, conversationId, text, deliveryStatus: 'failed', errorCategory });
  } catch (e) {
    console.error('⚠️ outbound failure persist failed (comment):', safeErrorCode(e));
  }
}

/** Safety net: catches phone numbers / emails / social handles even if the LLM missed them. */
function containsContactData(text = '') {
  return /(\+?\d[\d\s-]{6,}\d)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.test(text);
}

/**
 * Meta rejects PUBLIC comment replies that contain URLs (Graph error code 1,
 * "An unknown error has occurred") while Messenger accepts them. For comments we
 * drop the whole line carrying the link so the reply stays clean and delivers.
 * Phone numbers and business text are preserved.
 */
export function sanitizeCommentMessage(text = '') {
  const lines = String(text)
    .split('\n')
    .filter((line) => !/https?:\/\/\S/i.test(line));
  const cleaned = lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // never post an empty comment — fall back to a short safe line
  return cleaned.length > 0 ? cleaned : localize(NOT_CONFIRMED_REPLY, 'ar');
}

// notifyStaff lives in ./notify.js (webhook + email channels)