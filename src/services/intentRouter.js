/**
 * Stage 6 Batch 2 — deterministic AR/EN intent router.
 *
 * No LLM in the loop: keyword/regex rules only, so classification costs
 * nothing and never consumes generation quota. Confidence drives routing
 * (exact facts → structured lookup; general → pgvector).
 *
 * NOTE: `\b` never matches Arabic letters (\w is ASCII-only) — Arabic patterns
 * use `(?<![A-Za-z])`/lookarounds instead of `\b`.
 */

const RULES = [
  {
    intent: 'price',
    patterns: [
      /(?<![A-Za-z])(?:بكم|سعر|كام|تكلفة|كم سعر|بكام)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:price|cost|how much)(?![A-Za-z])/i
    ],
    confidence: 0.85
  },
  {
    intent: 'hours',
    patterns: [
      /(?<![A-Za-z])(?:يفتح|بتفتح|تفتح|مواعيد|أوقات|ساعات العمل|ساعة)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:open|opening|hours|close|closing)(?![A-Za-z])/i
    ],
    confidence: 0.85
  },
  {
    intent: 'branch_location',
    patterns: [
      /(?<![A-Za-z])(?:فين|عنوان|موقع|فرع)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:where|location|address|located)(?![A-Za-z])/i
    ],
    confidence: 0.8
  },
  {
    intent: 'phone',
    patterns: [
      /(?<![A-Za-z])(?:تليفون|هاتف|رقم|يتصل|اتصل)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:phone|call you|contact number)(?![A-Za-z])/i
    ],
    confidence: 0.85
  },
  {
    intent: 'menu',
    patterns: [
      /(?<![A-Za-z])(?:منيو|قائمة|قايمة|اصناف|اكلات)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:menu|what do you have)(?![A-Za-z])/i
    ],
    confidence: 0.8
  },
  {
    intent: 'halal',
    patterns: [/(?:حلال|حلوم)(?![A-Za-z])|halal/i],
    confidence: 0.9
  },
  {
    intent: 'reservations',
    patterns: [/(?:حجز|احجز|حجوزات)(?![A-Za-z])|reserv/i],
    confidence: 0.9
  },
  {
    intent: 'faq',
    patterns: [
      /(?<![A-Za-z])(?:عندكم|هل|كيف|ممكن|اقدر|بيوصّلوا|توصيل)(?![A-Za-z])/,
      /(?<![A-Za-z])(?:do you|can i|is there|deliver)(?![A-Za-z])/i
    ],
    confidence: 0.5
  }
];

const IRRELEVANT = /(?<![A-Za-z])(?:اخبار|سياسة|رياضة|طقس)(?![A-Za-z])|weather|politics|news/i;

const STRONG = new Set(['price', 'hours', 'branch_location', 'phone', 'menu', 'halal', 'reservations']);

/**
 * @param {string} text customer message
 * @returns {{ intent: string; confidence: number }}
 */
export function classifyIntent(text) {
  const t = String(text ?? '');
  if (!t.trim()) return { intent: 'empty', confidence: 0 };
  if (IRRELEVANT.test(t)) return { intent: 'irrelevant', confidence: 0.9 };

  let best = { intent: 'general', confidence: 0.3 };
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(t))) {
      if (rule.confidence > best.confidence) best = { intent: rule.intent, confidence: rule.confidence };
    }
  }

  // "فرع" + "menu item" hints can sharpen vague questions
  if (best.intent === 'general') {
    if (/(?<![A-Za-z])(?:فرع)(?![A-Za-z])/.test(t)) best = { intent: 'branch_location', confidence: 0.6 };
    else if (/(?<![A-Za-z])(?:كاكاو|قاتو|cake|bomb)(?![A-Za-z])/i.test(t)) best = { intent: 'price', confidence: 0.6 };
  }
  return best;
}

export function isExactIntent(intent) {
  return STRONG.has(intent);
}

export const INTENTS = ['price', 'hours', 'branch_location', 'phone', 'menu', 'halal', 'reservations', 'faq', 'general', 'irrelevant', 'empty'];
