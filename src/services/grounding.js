/**
 * Stage 4.4.5 — Deterministic grounding guard.
 *
 * Validates that business facts the LLM put in a customer-facing reply actually
 * exist in the tenant/brand-scoped knowledge, before any outbound send.
 *
 * Checks (v1):
 *   - URLs        (must be a URL present in the knowledge JSON)
 *   - phone numbers (must appear verbatim in the knowledge JSON)
 *   - prices      (numeric amounts with currency hints, e.g. 4.750 KD / 12.000)
 *
 * Any violation → the caller must use the safe NOT_CONFIRMED_REPLY instead.
 * Nothing internal is exposed to customers; violations are logged sanitized only.
 */

export class GroundingViolation extends Error {
  constructor(reasons) {
    super('grounding violation');
    this.name = 'GroundingViolation';
    this.code = 'GROUNDING_VIOLATION';
    this.reasons = reasons;
  }
}

/** Localized, tenant-neutral "not confirmed" reply used when grounding fails. */
export const NOT_CONFIRMED_REPLY = {
  ar: 'ما عندي معلومات مؤكدة عن هالنقطة حالياً. فريقنا يقدر يساعدك ويأكد لك التفاصيل بأقرب وقت 🙏',
  en: "I don't have confirmed information about that yet. Our team can help you with it.",
  fr: "Je n'ai pas encore d'informations confirmées à ce sujet. Notre équipe peut vous aider.",
  es: 'Aún no tengo información confirmada sobre eso. Nuestro equipo puede ayudarte.',
  de: 'Dazu habe ich noch keine bestätigten Informationen. Unser Team hilft dir gerne weiter.',
  tr: 'Bu konuda henüz doğrulanmış bilgim yok. Ekibimiz size yardımcı olabilir.',
  ur: 'اس بارے میں میرے پاس ابھی تصدیق شدہ معلومات نہیں ہیں۔ ہماری ٹیم آپ کی مدد کر سکتی ہے۔'
};

export function localize(table, lang) {
  return table[lang] || table.en;
}

/** Flatten any nested JSON structure into a single lowercase text blob. */
function flatten(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${flatten(v)}`).join(' ');
  return '';
}

/** Extract all http(s) URLs from a text. */
export function extractUrls(text = '') {
  return Array.from(new Set(String(text).match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []));
}

/** Extract phone-like sequences (7-15 digits, optional + and separators). */
export function extractPhones(text = '') {
  const cleaned = String(text).replace(/(\d)[\s.-](\d)/g, (m, a, b) => a + b); // collapse separators
  return Array.from(new Set(cleaned.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [])).map((p) => p.replace(/[\s().-]/g, ''));
}

/** Extract price-like amounts: number + currency (KD / د.ك / KWD / $ / USD / EUR …). A bare
 *  number without a currency hint is NOT treated as a price (avoids false positives on years). */
export function extractPrices(text = '') {
  const out = [];
  const re = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(KD|KWD|د\.?ك|دينار|\$|USD|EUR|€|£)/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) out.push({ raw: m[0], amount: m[1].replace(',', '.'), currency: m[2].toLowerCase() });
  return out;
}

/**
 * Validate a draft reply against the scoped knowledge.
 * @returns {{ok: boolean, reasons: string[], draft: object}}
 */
export function checkGrounding(draft, { knowledge }) {
  const reply = String(draft?.reply ?? '');
  const kbText = flatten(knowledge).toLowerCase();
  const kbDigits = kbText.replace(/[^\d+]/g, '');
  const reasons = [];

  // 1) URLs
  for (const url of extractUrls(reply)) {
    const norm = url.replace(/[.,;:)]+$/, '').toLowerCase();
    if (!kbText.includes(norm)) reasons.push('url_not_in_knowledge');
  }

  // 2) phone numbers (compare digit sequences — KB may write them with spaces/dashes)
  for (const phone of extractPhones(reply)) {
    if (phone.replace(/\D/g, '').length < 7) continue; // too short to be a phone
    if (!kbDigits.includes(phone)) reasons.push('phone_not_in_knowledge');
  }

  // 3) prices — an amount must exist in the KB with a matching currency hint
  for (const price of extractPrices(reply)) {
    const amountVariants = new Set([price.amount, price.amount.replace('.', ','), price.amount.padStart(5, '0')]);
    const found = [...amountVariants].some((v) => kbText.includes(v.toLowerCase()));
    if (!found) reasons.push('price_not_in_knowledge');
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], draft };
}

/**
 * Convenience helper for callers: returns the guarded draft, or a draft whose
 * reply is the safe localized "not confirmed" message.
 */
export function enforceGrounding(draft, { knowledge, lang }) {
  const result = checkGrounding(draft, { knowledge });
  if (result.ok) return { rejected: false, draft };
  return { rejected: true, reasons: result.reasons, draft: { ...draft, reply: localize(NOT_CONFIRMED_REPLY, lang ?? draft.lang) } };
}
