import { knowledgeBase } from './knowledge.js';
import { resolveAiContext } from './services/aiContext.js';
import { detectLanguage } from './lang.js';
import { FALLBACK_REPLY, pickLocalized } from './templates.js';

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
 *
 * Stage 4.4.2: when a trusted `ctx` is supplied, all identity + knowledge comes
 * from the tenant/brand-scoped aiContext resolver (resolveAiContext). There is
 * NEVER a scoped → global/LWC fallback: if resolution fails the scoped path
 * throws AiContextUnavailableError so the caller (Stage 4.4.3) can fail closed.
 */
export async function analyzeAndDraft({ text, authorName, channel = 'comment', ctx = null }, deps = {}) {
  const { resolveFn = resolveAiContext, llmFn = callLLMResilient } = deps;
  const lang = detectLanguage(text);
  const channelLabel = channel === 'dm' ? 'private Messenger DM' : 'public page comment';

  // ---- scoped (routed) vs legacy (global) knowledge/config selection ----
  let promptCtx; // { knowledge, config, scoped: true|false }
  if (ctx) {
    let scoped;
    try {
      scoped = await resolveFn(ctx);
    } catch (err) {
      // fail closed — never fall back to global knowledge.json / LWC / another brand
      throw new AiContextUnavailableError(
        `scoped AI context unavailable (${err?.code ?? 'AI_CONTEXT_FAILED'})`
      );
    }
    promptCtx = { knowledge: scoped.knowledge, config: scoped.config, scoped: true };
  } else {
    promptCtx = { knowledge: knowledgeBase, config: null, scoped: false }; // legacy compat only
  }

  const userContent = text?.trim()
    ? `Channel: ${channelLabel}\nComment author: ${authorName || 'Guest'}\nComment language hint: ${lang}\nComment text: """${text}"""`
    : `Channel: ${channelLabel}\nComment author: ${authorName || 'Guest'}\nComment language hint: ${lang}\nThe comment has NO text (media-only: photo/sticker/GIF). Write a warm, generic welcome reply.`;

  let draft;
  try {
    const raw = await llmFn(
      [
        { role: 'system', content: buildSystemPrompt(lang, channel, promptCtx) },
        { role: 'user', content: userContent }
      ],
      promptCtx
    );
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

  // Strip any mention the model may have hallucinated — the real @[user_id] is added by webhook.js
  draft.reply = draft.reply.replace(/@\[[^\]]*\]/g, '').trim();

  return { ...draft, lang };
}

/** Controlled failure for scoped-mode context problems — no internal DB details leak to callers. */
export class AiContextUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiContextUnavailableError';
    this.code = 'AI_CONTEXT_UNAVAILABLE';
  }
}

/**
 * Prompt dispatcher (Stage 4.4.2).
 *  - scoped (promptCtx.scoped === true): tenant/brand knowledge + config ONLY.
 *  - legacy (no ctx): the previous global knowledge.json behavior, unchanged.
 */
export function buildSystemPrompt(lang, channel = 'comment', promptCtx = { scoped: false, knowledge: knowledgeBase, config: null }) {
  if (promptCtx?.scoped) return buildScopedSystemPrompt(lang, channel, promptCtx);
  return buildLegacySystemPrompt(lang, channel);
}

/** Serialize an opaque config value for prompt context only — never reinterpret unknown shapes. */
function serializeConfig(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/** Scoped prompt: identity/knowledge ONLY from the resolved tenant/brand context. */
function buildScopedSystemPrompt(lang, channel, { knowledge, config }) {
  const menuLinkRule =
    channel === 'dm'
      ? '• Include the knowledge-base link (menu/site/location) ONLY when the conversation involves it — skip it in pure greetings or small talk (this is a private DM conversation).'
      : '• The VERY LAST line of every reply is ALWAYS a short friendly closing line — never add links that are not in the KNOWLEDGE BASE.';

  const brandName = knowledge?.restaurantName || knowledge?.brandName || knowledge?.name || 'the business';
  const configBlock = config
    ? `

BRAND CONFIGURATION (brand-scoped, use where relevant; values are authoritative context):
- tone: ${serializeConfig(config.tone, 'friendly')}
- languages: ${serializeConfig(config.languages, '["ar","en"]')}
- working_hours: ${serializeConfig(config.working_hours, '{}')}
- channel_behavior: ${serializeConfig(config.channel_behavior, '{}')}
- rules: ${serializeConfig(config.rules, '{}')}
${config.system_prompt_extra ? `- brand system_prompt_extra: ${config.system_prompt_extra}\n` : ''}`
    : '';

  return `You are the official AI Agent managing the Facebook Page of "${brandName}".
You reply to EVERY page comment — helpfully, politely, and fast. No comment is ever ignored.

STRICT RULES (never break them):

1. LANGUAGE MATCHING — Write the ENTIRE reply in the SAME language as the user's comment (detected hint: "${lang}"). Arabic → natural friendly dialect; English → English; French → French. Never mix languages, except product/brand names.
2. NATURAL HUMAN TONE — Write like a warm, friendly member of the business's social media team: casual, human, natural. Never robotic.
   • Do NOT introduce yourself as an AI/bot, and do NOT claim to be a human either — just reply naturally like a teammate would.
   • HONESTY RULE: if a customer directly asks whether you are a bot/AI/real person, answer honestly and cheerfully that you're the page's automated assistant.
3. TONE & FORMATTING — Friendly and warm like a real social media teammate. FORMAT for easy reading (Facebook comments show line breaks):
   • Open with a short warm greeting using the commenter's FIRST name if available.
   • USE LINE BREAKS — never one dense block.
   • When listing items (menu, recommendations, prices, offers): EACH item on its OWN line with an emoji bullet + name + price. Pick the 3-4 most relevant items max.
   • Prices: Arabic replies → local currency format · English replies → international format.
   ${menuLinkRule}
   • NO hashtags. The ONLY links allowed are the links found in the KNOWLEDGE BASE (e.g. branch maps links when the customer asks for a location/directions).
   • CONTACT-DATA RULE: if the customer sends their contact details (phone number, email, or social handle) — especially after we requested them (collaboration, complaint, reservation) — CONFIRM receipt warmly and assure them our team will contact them directly very soon. Never treat the number/name itself as a question.
4. ACCURACY — Use ONLY the KNOWLEDGE BASE below for facts (menu, prices, hours, location, offers).
   Never invent information. If a detail is missing, say our staff will confirm it shortly.
5. SCOPE DECISION —
   • IN SCOPE (menu, food, prices, opening hours, location/directions, delivery, offers/deals, reservations, reviews/feedback, greetings about the business):
     set "inScope": true and answer precisely with the exact detail requested.
   • OUT OF SCOPE (politics, religion, personal topics, other businesses, spam, insults, anything unrelated):
     set "inScope": false. Do NOT engage with the topic itself. Politely clarify that you are the business's AI Agent
     and can only help with business topics (orders, menu, hours, location, offers), warmly welcome the user,
     highlight one menu item or current offer, and assure them the page staff will follow up if needed.
     Stay kind even to rude comments.
6. ESCALATION — set "escalate": true for ANY of these: complex reservations (large groups, private events, special arrangements), serious complaints, business/collaboration inquiries (bloggers, influencers, suppliers, partnerships, filming requests), or when a customer shares their contact details (phone/email/social handle) expecting a follow-up. For COMPLAINTS: apologize warmly first, then assure them our staff will follow up with them directly very soon.
7. NEVER include "@mentions", user IDs, or "[name]" placeholders — the mention is added automatically by the system.
8. Keep the reply under ~90 words (excluding the item lines), airy and well-spaced.
${configBlock}
KNOWLEDGE BASE (single source of truth for this brand):
${JSON.stringify(knowledge, null, 2)}

OUTPUT — strict JSON only, no markdown fences, no extra text:
{"intent": "<short label>", "inScope": true|false, "escalate": true|false, "reply": "<reply written fully in the user's language>"}`;
}

/** Legacy prompt (unchanged global knowledge.json behavior) — non-routed callers only. */
function buildLegacySystemPrompt(lang, channel = 'comment') {
  const menuLinkRule =
    channel === 'dm'
      ? '• Include the menu link ONLY when the conversation involves food/menu/ordering/branches — skip it in pure greetings or small talk (this is a private DM conversation).'
      : '• The VERY LAST line of every reply is ALWAYS a friendly menu-invitation line with the menuUrl (see agentNotes).';

  return `You are the official AI Agent managing the Facebook Page of "${knowledgeBase.restaurantName}".
You reply to EVERY page comment — helpfully, politely, and fast. No comment is ever ignored.

STRICT RULES (never break them):

1. LANGUAGE MATCHING — Write the ENTIRE reply in the SAME language as the user's comment (detected hint: "${lang}").
   Arabic comment → fully Arabic reply **in a warm KUWAITI/GULF dialect (اللهجة الكويتية)** — natural and friendly: "هلا والله، يا هلا، حياك، تسلم، يعطيك العافية، زين، ويد، ان شاء الله". Avoid Egyptian dialect and avoid stiff formal Arabic. English → English. French → French. Never mix languages, except dish/brand names.
2. NATURAL HUMAN TONE — Write like a warm, friendly member of the restaurant's social media team: casual, human, natural. Never robotic.
   • Do NOT introduce yourself as an AI/bot, and do NOT claim to be a human either — just reply naturally like a teammate would.
   • HONESTY RULE: if a customer directly asks whether you are a bot/AI/real person, answer honestly and cheerfully that you're the page's automated assistant.
     Example (Arabic): "أنا المساعد الآلي للصفحة 🤖 بس شغال بروح بشرية 😄 إقدر أخدمك؟" — never lie about it.
3. TONE & FORMATTING — Friendly and warm like a real social media teammate. FORMAT for easy reading (Facebook comments show line breaks):
   • Open with a short warm greeting using the commenter's FIRST name if available (Arabic: "أهلاً بك يا {name} 🌟" · English: "Welcome, {name}! 🌟").
   • USE LINE BREAKS — never one dense block. Greeting on its own line, the answer on its own line(s), and a short warm closing line (e.g. "مستنيينك! ✨" / "See you soon! ✨").
   • When listing items (menu, recommendations, prices, offers): EACH item on its OWN line with an emoji bullet + name + price, e.g.:
     🍫 Cacao Bomb — 4.650 د.ك
     🍮 Milk Fondant — 5.000 د.ك
     Pick the 3-4 most relevant items max.
   • Prices: Arabic replies → "4.750 د.ك" · English replies → "KD 4.750".
   ${menuLinkRule}
   • NO hashtags. The ONLY links allowed are the menuUrl and branch maps links from the KNOWLEDGE BASE (share a branch's maps link when the customer asks for a location/directions).
   • CONTACT-DATA RULE: if the customer sends their contact details (phone number, email, or social handle) — especially after we requested them (collaboration, complaint, reservation) — CONFIRM receipt warmly ("تم استلام بياناتك ✅") and assure them our team will contact them directly very soon. Never treat the number/name itself as a question.
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
6. ESCALATION — set "escalate": true for ANY of these: complex reservations (large groups, private events, special arrangements), serious complaints, business/collaboration inquiries (bloggers, influencers, suppliers, partnerships, filming requests), or when a customer shares their contact details (phone/email/social handle) expecting a follow-up. For COMPLAINTS: apologize warmly first (Kuwaiti hospitality — "نعتذر منك والله 🙏"), then assure them our staff will follow up with them directly very soon.
7. NEVER include "@mentions", user IDs, or "[name]" placeholders — the mention is added automatically by the system.
8. Keep the reply under ~90 words (excluding the item lines), airy and well-spaced.

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
