/* ------------------------------------------------------------------ */
/* Localized fallback replies — used when the LLM call fails entirely. */
/* Still guarantees a reply to every comment.                          */
/* Add more languages freely; lookup falls back to English.            */
/* ------------------------------------------------------------------ */
export const FALLBACK_REPLY = {
  ar: 'هلا والله! 🌟 حياك الله، أقدر أفيدك بأي سؤال عن المنيو أو الفروع أو المواعيد 🍫✨ وفريقنا بيتابع وياك عن قريب.',
  en: "Welcome! 🌟 I'd be happy to help with any question about our menu, hours, location, or offers 🍔✨ Our page staff will also follow up with you shortly.",
  fr: "Bienvenue ! 🌟 Je serais ravi de vous aider avec notre menu, nos horaires, notre adresse ou nos offres 🍔✨ Notre équipe vous contactera également très vite.",
  es: '¡Bienvenido! 🌟 Con gusto te ayudo con el menú, horarios, ubicación u ofertas 🍔✨ Nuestro equipo también te contactará pronto.',
  de: 'Willkommen! 🌟 Ich helfe dir gerne bei Fragen zu Speisekarte, Öffnungszeiten, Standort oder Angeboten 🍔✨ Unser Team meldet sich außerdem bald bei dir.',
  tr: 'Hoş geldiniz! 🌟 Menü, çalışma saatleri, konum veya kampanyalar hakkında size yardımcı olmaktan mutluluk duyarım 🍔✨ Ekibimiz de kısa süre içinde sizinle iletişime geçecek.',
  ur: 'خوش آمدید! 🌟 مینیو، اوقات، مقام یا آفرز کے بارے میں کسی بھی سوال میں میں آپ کی مدد کر سکتا ہوں 🍔✨ ہماری ٹیم بھی جلد آپ سے رابطہ کرے گی۔'
};

export function pickLocalized(table, lang) {
  return table[lang] || table.en;
}
