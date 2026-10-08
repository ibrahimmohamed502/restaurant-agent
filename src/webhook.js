import crypto from 'node:crypto';
import express from 'express';
import { buildRouteContext } from './services/routeContext.js';
import { analyzeAndDraft } from './agent.js';
import { notifyStaff } from './notify.js';
import { logEvent, addEscalation } from './db.js';
import { enabled } from './db/pg.js';
import {
  findOrCreateChannel,
  findOrCreateCustomer,
  findOrCreateConversation,
  persistMessage,
  createEscalationRecord,
  escalationCategory
} from './services/conversations.js';
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
async function handlePayload(body, handlers = {}) {
  if (body.object !== 'page') return;

  const { buildCtx = buildRouteContext, onComment = processComment, onMessage = processMessage } = handlers;

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

      await onComment(v, ctx).catch((err) =>
        console.error(`❌ Failed on comment ${v?.comment_id}:`, err.message)
      );
    }

    // ---- Channel 2: Messenger DMs ----
    for (const event of entry.messaging ?? []) {
      await onMessage(event, ctx).catch((err) =>
        console.error(`❌ Failed on DM from ${event?.sender?.id}:`, err.message)
      );
    }
  }
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

  // Stage 4.4.3: scoped AI path — ctx is mandatory. No legacy/global retry.
  let draft;
  try {
    draft = await analyze({ text, authorName, channel: 'dm', ctx });
  } catch (err) {
    if (err?.code === 'AI_CONTEXT_UNAVAILABLE') {
      console.warn(`⛔ [${ctx.pageId}] scoped AI context unavailable — DM not answered (fail closed)`);
      return;
    }
    throw err;
  }
  const sendResp = await ctx.metaClient.sendMessengerReply(psid, draft.reply);
  mark(msg.mid, psid);

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

  // ---- Stage 3: persist conversation in Postgres (best-effort) ----
  let conversationId = null;
  if (pgEnabled) {
    try {
      // Stage 4.3B.3: routed events persist ONLY under the resolved routing tenant.
      // No getDefaultTenantId() fallback — fail closed for persistence if ctx is incomplete.
      const tenantId = ctx?.tenantId;
      if (tenantId) {
        const channelId = await findOrCreateChannel({ tenantId, brandId: ctx.brandId ?? null, provider: 'meta_dm', externalId: ctx.pageId, displayName: 'Messenger DM' });
        const customerId = await findOrCreateCustomer({ tenantId, provider: 'meta_dm', externalId: psid, name: authorName });
        conversationId = await findOrCreateConversation({ tenantId, channelId, externalKey: psid, customerId, lang: draft.lang });
        await persistMessage({ tenantId, conversationId, direction: 'inbound', senderType: 'customer', text, providerMessageId: msg.mid, providerTs: event.timestamp ? new Date(event.timestamp) : null });
        await persistMessage({ tenantId, conversationId, direction: 'outbound', senderType: 'ai', text: draft.reply, providerMessageId: sendResp?.message_id });
      }
    } catch (e) {
      console.error('⚠️ conversation persist failed (dm):', e.message);
    }
  }

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

  // ---- AI Engine: intent analysis + language detection + reply drafting ----
  // Stage 4.4.3: scoped AI path — ctx is mandatory. No legacy/global retry.
  let draft;
  try {
    draft = await analyze({ text: message, authorName: from.name, channel: 'comment', ctx });
  } catch (err) {
    if (err?.code === 'AI_CONTEXT_UNAVAILABLE') {
      console.warn(`⛔ [${ctx.pageId}] scoped AI context unavailable — comment not answered (fail closed)`);
      return;
    }
    throw err;
  }

  // Rule: User Mention — prepend the Graph API mention tag @[user_id]
  const finalMessage = `@[${from.id}] ${draft.reply}`;

  // ---- Publish via the request-scoped routed Meta client (ctx.metaClient) ----
  const replyResp = await ctx.metaClient.replyToComment(commentId, finalMessage);
  mark(commentId, from.id);

  console.log(
    `✅ Replied to ${commentId} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
  );

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
  let conversationId = null;
  if (pgEnabled) {
    try {
      // Stage 4.3B.3: routed events persist ONLY under the resolved routing tenant.
      const tenantId = ctx?.tenantId;
      if (tenantId) {
        const channelId = await findOrCreateChannel({ tenantId, brandId: ctx.brandId ?? null, provider: 'meta_comment', externalId: ctx.pageId, displayName: 'Facebook comments' });
        const customerId = await findOrCreateCustomer({ tenantId, provider: 'meta_comment', externalId: from.id, name: from.name });
        const externalKey = value.parent_id && value.parent_id !== value.post_id ? value.parent_id : commentId;
        conversationId = await findOrCreateConversation({ tenantId, channelId, externalKey, customerId, lang: draft.lang });
        await persistMessage({ tenantId, conversationId, direction: 'inbound', senderType: 'customer', text: message, providerMessageId: commentId, providerTs: value.created_time ? new Date(value.created_time * 1000) : null });
        await persistMessage({ tenantId, conversationId, direction: 'outbound', senderType: 'ai', text: draft.reply, providerMessageId: replyResp?.id });
      }
    } catch (e) {
      console.error('⚠️ conversation persist failed (comment):', e.message);
    }
  }

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

/** Safety net: catches phone numbers / emails / social handles even if the LLM missed them. */
function containsContactData(text = '') {
  return /(\+?\d[\d\s-]{6,}\d)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.test(text);
}

// notifyStaff lives in ./notify.js (webhook + email channels)
