import crypto from 'node:crypto';
import express from 'express';
import {
  replyToComment,
  sendMessengerReply,
  sendTypingIndicator,
  getUserFirstName
} from './facebook.js';
import { analyzeAndDraft } from './agent.js';
import { alreadyReplied, markReplied, userOverLimit } from './store.js';

export const webhookRouter = express.Router();

const PAGE_ID = process.env.FB_PAGE_ID;

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
async function handlePayload(body) {
  if (body.object !== 'page') return;

  for (const entry of body.entry ?? []) {
    // ---- Channel 1: page feed comments ----
    for (const change of entry.changes ?? []) {
      if (change.field !== 'feed') continue;
      const v = change.value;
      // Only brand-new comments (skip edits, deletes, reactions, posts…)
      if (v?.item !== 'comment' || v?.verb !== 'add') continue;

      await processComment(v).catch((err) =>
        console.error(`❌ Failed on comment ${v?.comment_id}:`, err.message)
      );
    }

    // ---- Channel 2: Messenger DMs ----
    for (const event of entry.messaging ?? []) {
      await processMessage(event).catch((err) =>
        console.error(`❌ Failed on DM from ${event?.sender?.id}:`, err.message)
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Messenger DM flow: typing → same AI engine → reply                  */
/* ------------------------------------------------------------------ */
async function processMessage(event) {
  const msg = event.message;
  const psid = event.sender?.id;

  if (!psid || psid === PAGE_ID) return;
  // Skip our own echoed messages, delivery/read receipts, postbacks…
  if (!msg || msg.is_echo || msg.delivery || msg.read) return;
  if (alreadyReplied(msg.mid)) return;

  const limit = Number(process.env.MAX_REPLIES_PER_USER_PER_HOUR || 30);
  if (userOverLimit(psid, limit)) {
    console.warn(`⚠️ DM anti-abuse cap hit for ${psid} — skipping`);
    return;
  }

  const text = msg.text || '';
  console.log(`💬 New DM from ${psid}: "${text || '(media only)'}"`);

  await sendTypingIndicator(psid);
  const authorName = await getUserFirstName(psid);
  const draft = await analyzeAndDraft({ text, authorName, channel: 'dm' });
  await sendMessengerReply(psid, draft.reply);
  markReplied(msg.mid, psid);

  console.log(
    `✅ DM replied to ${psid} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
  );
}

async function processComment(value) {
  const { comment_id: commentId, message = '', from } = value;
  if (!commentId || !from?.id) return;

  // Safety: never reply to the Page's own comments (prevents infinite loops)
  if (from.id === PAGE_ID) {
    console.log(`⏭️ Skipping comment ${commentId} — authored by the Page itself (comment as your PERSONAL profile to test)`);
    return;
  }

  // Safety: never reply twice to the same comment (webhook redeliveries)
  if (alreadyReplied(commentId)) {
    console.log(`↩️  Already handled comment ${commentId} — skipping`);
    return;
  }

  // Anti-abuse cap only — genuine commenters still always get a reply
  const limit = Number(process.env.MAX_REPLIES_PER_USER_PER_HOUR || 30);
  if (userOverLimit(from.id, limit)) {
    console.warn(`⚠️ User ${from.id} hit the hourly anti-abuse cap — skipping`);
    return;
  }

  console.log(`💬 New comment from ${from.name ?? from.id}: "${message || '(media only)'}"`);

  // ---- AI Engine: intent analysis + language detection + reply drafting ----
  const draft = await analyzeAndDraft({ text: message, authorName: from.name });

  // Rule: User Mention — prepend the Graph API mention tag @[user_id]
  const finalMessage = `@[${from.id}] ${draft.reply}`;

  // ---- Publish via FB API ----
  await replyToComment(commentId, finalMessage);
  markReplied(commentId, from.id);

  console.log(
    `✅ Replied to ${commentId} | intent=${draft.intent} | inScope=${draft.inScope} | lang=${draft.lang} | escalate=${draft.escalate}`
  );

  // ---- Optional step from the diagram: escalate complex reservations to staff ----
  if (draft.escalate) {
    await notifyStaff({ commentId, from, message, draft });
  }
}

async function notifyStaff(info) {
  console.warn('🚨 ESCALATION — staff follow-up needed:', JSON.stringify(info, null, 2));
  const url = process.env.STAFF_ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'staff_escalation', ...info })
  }).catch((e) => console.error('Staff alert webhook failed:', e.message));
}
