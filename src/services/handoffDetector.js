/**
 * Stage 7 — deterministic customer "I want a human" detector.
 *
 * NO LLM is involved. Regex/keyword rules only, so classification costs nothing
 * and never consumes generation quota.
 *
 * SAFETY DIRECTION (deliberate): ambiguous text keeps the AI ACTIVE.
 *   - no match  → AI answers normally
 *   - match     → handoff (AI is switched off)
 * A false negative is a safe failure mode. A false positive would silence the
 * AI on a normal customer — so the patterns are intentionally narrow.
 *
 * RULE: a handoff requires BOTH
 *   (a) a first-person REQUEST verb, AND
 *   (b) a HUMAN noun.
 * A human noun on its own ("the manager") is never enough.
 *
 * NOTE on Arabic: `\b` never matches Arabic letters (`\w` is ASCII-only), so
 * Arabic patterns use `(?<![A-Za-z])` / `(?![A-Za-z])` lookarounds, matching the
 * convention already established in src/services/intentRouter.js.
 *
 * NEVER triggers on:
 *   - menu / price / hours / branch / delivery / reservation questions
 *   - contact data (phone/email) — that stays an escalation, AI keeps answering
 *   - complaints / `escalate` — those keep the existing Stage 3-6 behaviour
 *   - negated requests
 */

const AR_VERBS =
  '(?:بدي|أبدي|ابدي|ابغى|أبغى|عايز|عاوز|عايزه|أريد|اريد|نفسي|ممكن|اكلم|أكلم|تكلم|تكلمني|احكي|أحب|احب|حول|حوّل|وصلني|وصل)';
const AR_HUMAN =
  '(?:موظف|موظفة|موظفين|شخص|إنسان|انسان|بشري|بشر|مسؤول|مسؤولين|المسؤول|مدير|مديرين|الاداره|الإدارة|خدمة العملاء|خدمه العملاء|حد|واحد| Reception|receptionist)';
const EN_VERBS =
  "(?:i want|i need|i'd like|i would like|i wanna|can i|could i|may i|let me|get me|put me|speak|speaking|talk|talking|connect|transfer|reach|contact)";
const EN_HUMAN =
  '(?:human|real person|actual person|person|agent|staff|manager|supervisor|representative|someone|somebody|employee|team member|live person|customer service|customer support|receptionist)';

/**
 * First-person request verb + human noun, close together (≤ ~8 tokens).
 * Three directions are covered: AR→AR, EN→EN, and MIXED (AR verb + EN human
 * noun or EN verb + AR human noun), because customers code-switch constantly.
 */
const AR_REQUEST = new RegExp(
  `${AR_VERBS}[^\\n]{0,32}?${AR_HUMAN}|${AR_HUMAN}[^\\n]{0,32}?${AR_VERBS}`
);
const EN_REQUEST = new RegExp(
  `${EN_VERBS}[^.\\n]{0,40}?${EN_HUMAN}|${EN_HUMAN}[^.\\n]{0,40}?${EN_VERBS}`,
  'i'
);
const MIXED_REQUEST = new RegExp(
  `${AR_VERBS}[^.\\n]{0,40}?${EN_HUMAN}|${EN_VERBS}[^.\\n]{0,40}?${AR_HUMAN}`,
  'i'
);

/** "not a bot / are you a robot" style requests for a human. */
const AR_NOT_BOT = /(?<![A-Za-z])(?:مش|مو|ليس)\s*(?:بوت|روبوت|رد\s*آلي|رد自动|آلي)(?![A-Za-z])|(?<![A-Za-z])(?:ابداء|تكلمني)\s*(?:شخص|إنسان|انسان)/;
const EN_NOT_BOT = /(?:not\s+a\s+bot|not\s+an?\s+automated|are\s+you\s+a\s+(?:bot|robot)|real\s+human\s+please|talk\s+to\s+a\s+human)/i;

/** Negation guard: "مش عايز أكلم موظف" / "I don't need an agent". */
const NEGATION_AR = /(?<![A-Za-z])(?:مش|مو|ليس|لا|مابي|ما أبي|ماني)\s*(?:عايز|بدي|أبغى|ابغى|أريد|اريد|ممكن|اكلم|أكلم|نفسي)/;
const NEGATION_EN = /(?:don'?t|do not|doesn'?t|dont|no need to|not looking to|no longer want to|never want to)\s+(?:want|need|speak|talk|contact|reach|get|have)/i;

/** Strong business intents that must NEVER be treated as a human request. */
const BUSINESS_HINT = /(?<![A-Za-z])(?:منيو|قائمة|قايمة|اصناف|اكلات|بكم|سعر|كام|تكلفة|وين|فين|عنوان|موقع|فرع|مواعيد|ساعات|يفتح|تفتح|حجز|احجز|توصيل|يوصل|حلال|عندكم|هل|cake|menu|price|cost|how much|where|location|address|branch|hours|open|closing|deliver|delivery|reservation|reserve|halal)(?![A-Za-z])/i;

/** Human-readable reason labels (never log the raw customer text). */
export const HANDOFF_REASONS = Object.freeze({
  CUSTOMER_REQUESTED_HUMAN: 'customer_requested_human',
  STAFF_REQUESTED: 'staff_requested'
});

/**
 * @param {string} text customer message
 * @returns {{matched: boolean, actor?: 'customer', reason?: string, pattern?: string}}
 */
export function detectCustomerHumanRequest(text) {
  const raw = String(text ?? '');
  const t = raw.trim();
  if (!t) return { matched: false };
  // Very long messages are treated as ambiguous (safe: AI stays active).
  if (t.length > 600) return { matched: false };

  // 1) Negation wins over everything else.
  if (NEGATION_AR.test(t) || NEGATION_EN.test(t)) return { matched: false };

  // 2) Explicit "you're not a bot / get me a human" phrasing.
  if (AR_NOT_BOT.test(t) || EN_NOT_BOT.test(t)) {
    return { matched: true, actor: 'customer', reason: HANDOFF_REASONS.CUSTOMER_REQUESTED_HUMAN, pattern: 'not_a_bot' };
  }

  // 3) Explicit first-person request for a human.
  let pattern = null;
  if (AR_REQUEST.test(t)) pattern = 'ar_request';
  else if (EN_REQUEST.test(t)) pattern = 'en_request';
  else if (MIXED_REQUEST.test(t)) pattern = 'mixed_request';

  if (!pattern) return { matched: false };

  /**
   * 4) Guard: if the same message ALSO carries a strong business intent, only
   *    treat it as a handoff when the human request is clearly dominant — i.e.
   *    the message is short (a pure request) or contains no business keyword at
   *    all. "بكم الكيك وعايز أكلم موظف" still hands off (the request is real);
   *    a passing mention of a human noun inside a business question does not.
   */
  if (BUSINESS_HINT.test(t) && t.length > 120) return { matched: false };

  return { matched: true, actor: 'customer', reason: HANDOFF_REASONS.CUSTOMER_REQUESTED_HUMAN, pattern };
}

export default detectCustomerHumanRequest;
