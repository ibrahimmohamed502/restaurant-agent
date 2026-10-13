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
  if (!verifySignature(req)) {
    console.warn('⛔ Invalid X-Hub-Signature-256 — request rejected');
    return res.sendStatus(401);
  }
  console.log('📩 Webhook POST received:', JSON.stringify(req.body).slice(0, 600));
  res.sendStatus(200); // ACK immediately so Meta doesn't retry
  handlePayload(req.body).catch((err) => console.error('❌ Handler error:', err));
});

function verifySignature(req) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) return true; // signature check disabled — set FB_APP_SECRET in production!
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
 * Stage 4 completion — queue-mode intake: normalize → dedupe (webhook_events)
 * → enqueue → fast ACK. Falls back to inline processing when the queue is
 * unavailable, so behavior is never silently lost.
 *
 * `queueIntake` is the per-event seam (exported for tests): record → enqueue,
 * and on enqueue failure it removes the intake row and returns the event so the
 * caller processes it inline exactly once.
 */
export async function queueIntake(events, deps = {}) {
  const {
    recordWebhookEvent,
    enqueueMetaEvent,
    deleteWebhookEvent
  } = deps;
  const result = { enqueued: 0, duplicates: 0, fallbackEvents: [] };
  for (const ev of events) {
    const recorded = await recordWebhookEvent(ev);
    if (!recorded) { result.duplicates++; continue; }
    try {
      await enqueueMetaEvent(ev);
      result.enqueued++;
    } catch (e) {
      // enqueue failed AFTER the row was recorded: undo the row so the event is
      // not permanently blocked, and process it inline exactly once.
      console.warn(`⚠️ enqueue failed for ${ev.eventId} — falling back to inline (${e?.code ?? 'error'})`);
      await deleteWebhookEvent(ev.provider, ev.eventId).catch(() => undefined);
      result.fallbackEvents.push(ev);
    }
  }
  return result;
}

async function enqueuePayload(body) {
  try {
    const { normalizeMetaWebhook } = await import('./providers/meta/normalizer.js');
    const { recordWebhookEvent, deleteWebhookEvent } = await import('./services/webhookEvents.js');
    const { enqueueMetaEvent } = await import('./queues/metaEvents.js');
    const events = normalizeMetaWebhook(body);
    return await queueIntake(events, { recordWebhookEvent, enqueueMetaEvent, deleteWebhookEvent });
  } catch (err) {
    // queue infrastructure unavailable → inline fallback (never drop the event)
    console.warn(`⚠️ queue intake unavailable (${err?.code ?? 'error'}) — processing inline`);
    return null;
  }
}

async function handlePayload(body, handlers = {}) {
  if (body.object !== 'page') return;

  const { buildCtx = buildRouteContext, onComment = processComment, onMessage = processMessage, enqueueFn = enqueuePayload, queueIntakeFn = queueIntake } = handlers;

  // ---- Stage 4 queue mode (default remains inline) ----
  if (webhookProcessingMode() === 'queue' && !handlers.skipQueue) {
    const outcome = await enqueueFn(body);
    if (outcome === null) {
      // intake infrastructure failed entirely → inline fallback below
    } else if (outcome.fallbackEvents?.length) {
      await processInline(body, { buildCtx, onComment, onMessage }, new Set(outcome.fallbackEvents.map((e) => e.eventId)));
      return;
    } else {
      if (outcome.enqueued || outcome.duplicates) {
        console.log(`📥 queued ${outcome.enqueued} event(s)${outcome.duplicates ? `, ${outcome.duplicates} duplicate(s) skipped` : ''}`);
      }
      return; // everything handled by the worker (or duplicates skipped)
    }
  }

  await processInline(body, { buildCtx, onComment, onMessage }, null);
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
        console.error(`❌ Failed on comment ${v?.comment_id}:`, err.message)
      );
    }

    // ---- Channel 2: Messenger DMs ----
    for (const event of entry.messaging ?? []) {
      const mid = event?.message?.mid;
      if (onlyEventIds && !onlyEventIds.has(mid)) continue;
      await onMessage(event, ctx).catch((err) =>
        console.error(`❌ Failed on DM from ${event?.sender?.id}:`, err.message)
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
      console.error('⚠️ stage7 customer handoff failed:', e?.message ?? 'error');
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
      console.error('⚠️ stage7 auto-escalation handoff failed:', e?.message ?? 'error');
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

export { handlePayload };
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
    console.warn(`⚠️ DM anti-abuse cap hit for ${psid} — skipping`);
    return;
  }

  const text = msg.text || '';
  console.log(`💬 New DM from ${psid}: "${text || '(media only)'}"`);

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
          console.log(`↩️  DM ${msg.mid} already persisted — skipping (webhook redelivery)`);
          return;
        }
      }
    } catch (e) {
      console.error('⚠️ inbound persist failed (dm):', e.message);
    }
  }

  // Stage 7 gate: check if AI should be suppressed BEFORE generation
  const gate = await applyStage7Gate({ tenantId: ctx?.tenantId, conversationId, text, pgEnabled });
  if (gate.suppressed) {
    console.log(`🤝 [stage7] AI suppressed for DM ${msg.mid} — state=${gate.state}`);
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
      console.error(`❌ AI failed on DM ${msg.mid}:`, err.message);
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
    console.log(`🤝 [stage7] AI suppressed at final check for DM ${msg.mid} — state=${finalCheck.state}`);
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
    console.error(`❌ Failed to deliver DM to ${psid}: [${category}]`);
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
    `✅ DM replied to ${psid} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
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
        console.error('⚠️ escalation persist failed (dm):', e.message);
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
    console.warn(`⚠️ User ${from.id} hit the hourly anti-abuse cap — skipping`);
    return;
  }

  console.log(`💬 New comment from ${from.name ?? from.id}: "${message || '(media only)'}"`);

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
          console.log(`↩️  Comment ${commentId} already persisted — skipping (webhook redelivery)`);
          return;
        }
      }
    } catch (e) {
      console.error('⚠️ inbound persist failed (comment):', e.message);
    }
  }

  // Stage 7 gate: check if AI should be suppressed BEFORE generation
  const gate = await applyStage7Gate({ tenantId: ctx?.tenantId, conversationId, text: message, pgEnabled });
  if (gate.suppressed) {
    console.log(`🤝 [stage7] AI suppressed for comment ${commentId} — state=${gate.state}`);
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
      console.error(`❌ AI failed on comment ${commentId}:`, err.message);
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
    console.log(`🤝 [stage7] AI suppressed at final check for comment ${commentId} — state=${finalCheck.state}`);
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
    console.error(`❌ Failed to deliver reply for comment ${commentId}: [${category}]`);
    if (outboundRow?.id) await updateMessageDelivery({ tenantId: ctx.tenantId, messageId: outboundRow.id, deliveryStatus: 'failed', errorCategory: category }).catch(() => {});
    else if (conversationId) await persistOutboundFailure(conversationId, ctx, { pgEnabled, text: finalMessage, errorCategory: category });
    mark(commentId, from.id); // prevent duplicate Meta retries from re-attempting publish
    return;
  }
  mark(commentId, from.id);

  console.log(
    `✅ Replied to ${commentId} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
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
        console.error('⚠️ escalation persist failed (comment):', e.message);
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
    console.error('⚠️ outbound failure persist failed (comment):', e.message);
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