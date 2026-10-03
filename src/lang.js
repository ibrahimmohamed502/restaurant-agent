import { franc } from 'franc-min';

// Rule: Language Matching — detect the comment's language before drafting the reply.

const ARABIC_SCRIPT = /[\u0600-\u06FF]/;
// Urdu shares the Arabic script; these letters are Urdu-specific
const URDU_SPECIFIC = /[ٹڈڑںہھےۓ]/;

// franc (ISO 639-3) → short codes used by our templates
const ISO3_TO_SHORT = {
  arb: 'ar', arz: 'ar', ary: 'ar', apc: 'ar', acm: 'ar', ara: 'ar', // Arabic variants
  eng: 'en', fra: 'fr', spa: 'es', deu: 'de', ita: 'it', por: 'pt',
  nld: 'nl', tur: 'tr', rus: 'ru', ukr: 'uk', pol: 'pl', swe: 'sv',
  urd: 'ur', hin: 'hi', ben: 'bn', fas: 'fa', heb: 'he', ell: 'el',
  zho: 'zh', cmn: 'zh', jpn: 'ja', kor: 'ko', ind: 'id', msa: 'ms',
  vie: 'vi', tha: 'th'
};

/**
 * Returns a short language code: 'ar', 'en', 'fr', 'es', ...
 * Falls back to 'ar' for Arabic-script text and 'en' otherwise.
 */
export function detectLanguage(text = '') {
  const trimmed = text.trim();
  if (!trimmed) return 'en';

  // Fast path: franc is unreliable on very short Arabic comments
  if (ARABIC_SCRIPT.test(trimmed) && !URDU_SPECIFIC.test(trimmed)) return 'ar';

  const iso3 = franc(trimmed, { minLength: 3 }); // 'und' when unsure
  if (ISO3_TO_SHORT[iso3]) return ISO3_TO_SHORT[iso3];

  return ARABIC_SCRIPT.test(trimmed) ? 'ar' : 'en';
}
