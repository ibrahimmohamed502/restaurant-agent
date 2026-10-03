import { knowledgeBase } from './knowledge.js';
import { detectLanguage } from './lang.js';
import {
  DISCLOSURE,
  FALLBACK_REPLY,
  hasIdentityDisclosure,
  pickLocalized
} from './templates.js';

const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const PRIMARY_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
// Tried in order: primary model first, then fallbacks (comma-separated in env)
const MODEL_CHAIN = [
  ...new Set([
    PRIMARY_MODEL,
    ...(process.env.LLM_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)
  ])
];

/**
 * The "AI Engine" block of the workflow diagram:
 * intent analysis → scope decision → reply drafting (in-scope OR out-of-scope).
 * Returns { intent, inScope, escalate, reply, lang }.
 */
export async function analyzeAndDraft({ text, authorName }) {
  const lang = detectLanguage(text);

  const userContent = text?.trim()
    ? `Comment author: ${authorName || 'Guest'}\nComment language hint: ${lang}\nComment text: """${text}"""`
    : `Comment author: ${authorName || 'Guest'}\nComment language hint: ${lang}\nThe comment has NO text (media-only: photo/sticker/GIF). Write a warm, generic welcome reply.`;

  let draft;
  try {
    const raw = await callLLMResilient([
      { role: 'system', content: buildSystemPrompt(lang) },
      { role: 'user', content: userContent }
    ]);
    const json = extractJson(raw);
    draft = normalizeDraft(JSON.parse(json), lang);
  } catch (err) {
    console.error('⚠️ LLM failure — using localized fallback reply:', err.message);
    draft = {
      intent: 'fallback',
      inScope: true,
      escalate: false,
      reply: pickLocalized(FALLBACK_REPLY, lang)
    };
  }

  /* ---------------- Code-enforced guarantees (never trust the model blindly) ---------------- */

  // Strip any mention the model may have hallucinated — the real @[user_id] is added by webhook.js
  draft.reply = draft.reply.replace(/@\[[^\]]*\]/g, '').trim();

  // Rule: Agent Identity Transparency — if the model forgot to say it's an AI, append the disclosure line
  if (!hasIdentityDisclosure(draft.reply)) {
    draft.reply += '\n' + pickLocalized(DISCLOSURE, lang);
  }

  return { ...draft, lang };
}

function buildSystemPrompt(lang) {
  return `You are the official AI Agent managing the Facebook Page of "${knowledgeBase.restaurantName}".
You reply to EVERY page comment — helpfully, politely, and fast. No comment is ever ignored.

STRICT RULES (never break them):

1. LANGUAGE MATCHING — Write the ENTIRE reply in the SAME language as the user's comment (detected hint: "${lang}").
   Arabic comment → fully Arabic reply. English → English. French → French. Never mix languages, except dish/brand names.
2. IDENTITY TRANSPARENCY — Always clearly state that you are an automated AI Agent of the page.
   Examples — Arabic: "أنا الـ AI Agent الخاص بالمطعم 🤖" · English: "I'm the page's AI Agent 🤖".
3. TONE — Friendly, warm, and comprehensive (نبرة ودية، سريعة، شاملة). Sprinkle relevant emojis naturally: 🍔 🍕 🤖 ✨ 📍 🕒 🛵.
4. ACCURACY — Use ONLY the KNOWLEDGE BASE below for facts (menu, prices, hours, location, offers).
   Never invent information. If a detail is missing, say our staff will confirm it shortly.
5. SCOPE DECISION —
   • IN SCOPE (menu, food, prices, opening hours, location/directions, delivery, offers/deals, reservations, reviews/feedback, greetings about the restaurant):
     set "inScope": true and answer precisely with the exact detail requested.
   • OUT OF SCOPE (politics, religion, personal topics, other businesses, spam, insults, anything unrelated):
     set "inScope": false. Do NOT engage with the topic itself. Politely clarify that you are the restaurant's AI Agent
     and can only help with restaurant topics (orders, menu, hours, location, offers), warmly welcome the user,
     highlight one menu item or current offer, and assure them the page staff will follow up if needed.
     Stay kind even to rude comments.
6. ESCALATION — Complex reservations (large groups, private events, special arrangements) or serious complaints:
   set "escalate": true and tell the user our staff will contact them directly very soon.
7. NEVER include "@mentions", user IDs, or "[name]" placeholders — the mention is added automatically by the system.
8. Keep the reply under ~80 words.

KNOWLEDGE BASE (single source of truth — edit knowledge.json to update):
${JSON.stringify(knowledgeBase, null, 2)}

OUTPUT — strict JSON only, no markdown fences, no extra text:
{"intent": "<short label>", "inScope": true|false, "escalate": true|false, "reply": "<reply written fully in the user's language>"}`;
}

function normalizeDraft(parsed, lang) {
  return {
    intent: typeof parsed.intent === 'string' ? parsed.intent : 'unknown',
    inScope: parsed.inScope !== false,
    escalate: parsed.escalate === true,
    reply:
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : pickLocalized(FALLBACK_REPLY, lang)
  };
}

function extractJson(raw) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM returned no JSON object');
  return cleaned.slice(start, end + 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Try each model in MODEL_CHAIN, up to 3 attempts per model.
 * Transient errors (429 / 5xx — e.g. Gemini free-tier "503 high demand")
 * are retried with backoff; hard errors skip straight to the next model.
 */
async function callLLMResilient(messages) {
  let lastErr;
  for (const model of MODEL_CHAIN) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await callLLM(messages, model);
        if (attempt > 1 || model !== PRIMARY_MODEL) {
          console.log(`✅ LLM answered via [${model}] on attempt ${attempt}`);
        }
        return out;
      } catch (err) {
        lastErr = err;
        const retryable = /HTTP (429|500|502|503|504)/.test(err.message);
        console.warn(`⚠️ LLM [${model}] attempt ${attempt}/3 failed: ${err.message.split('\n')[0].slice(0, 120)}`);
        if (!retryable) break; // hard error → try next model
        await sleep(1200 * attempt);
      }
    }
  }
  throw lastErr;
}

async function callLLM(messages, model, useJsonMode = true) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.5,
      ...(useJsonMode ? { response_format: { type: 'json_object' } } : {})
    })
  });

  if (!res.ok) {
    const bodyText = await res.text();
    // Some providers (OpenRouter models, Ollama…) don't support JSON mode — retry without it
    if (useJsonMode && res.status === 400) return callLLM(messages, model, false);
    throw new Error(`LLM HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty content');
  return content;
}
