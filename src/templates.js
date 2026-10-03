/* ------------------------------------------------------------------ */
/* Localized, code-guaranteed text snippets.                           */
/* The LLM is instructed to include identity disclosure itself —       */
/* these are the safety net if it forgets, plus fallback replies.      */
/* Add more languages freely; lookup falls back to English.            */
/* ------------------------------------------------------------------ */

// Rule: Agent Identity Transparency (appended if the model forgot)
export const DISCLOSURE = {
  ar: '🤖 هذا رد تلقائي من الـ AI Agent الخاص بصفحة المطعم.',
  en: "🤖 This is an automated reply from the page's AI Agent.",
  fr: "🤖 Ceci est une réponse automatique de l'agent IA de la page.",
  es: '🤖 Esta es una respuesta automática del agente de IA de la página.',
  de: '🤖 Dies ist eine automatische Antwort des KI-Agenten dieser Seite.',
  tr: '🤖 Bu, sayfanın yapay zekâ asistanından gelen otomatik bir yanıttır.',
  ur: '🤖 یہ صفحے کے AI ایجنٹ کا خودکار جواب ہے۔'
};

// Used when the LLM call fails entirely — still guarantees a reply to every comment
export const FALLBACK_REPLY = {
  ar: 'أهلاً وسهلاً بك! 🌟 يسعدني مساعدتك في أي استفسار عن المنيو أو المواعيد أو الموقع أو العروض 🍔✨ وسيقوم فريق الصفحة بالمتابعة معك قريباً.',
  en: "Welcome! 🌟 I'd be happy to help with any question about our menu, hours, location, or offers 🍔✨ Our page staff will also follow up with you shortly.",
  fr: "Bienvenue ! 🌟 Je serais ravi de vous aider avec notre menu, nos horaires, notre adresse ou nos offres 🍔✨ Notre équipe vous contactera également très vite.",
  es: '¡Bienvenido! 🌟 Con gusto te ayudo con el menú, horarios, ubicación u ofertas 🍔✨ Nuestro equipo también te contactará pronto.',
  de: 'Willkommen! 🌟 Ich helfe dir gerne bei Fragen zu Speisekarte, Öffnungszeiten, Standort oder Angeboten 🍔✨ Unser Team meldet sich außerdem bald bei dir.',
  tr: 'Hoş geldiniz! 🌟 Menü, çalışma saatleri, konum veya kampanyalar hakkında size yardımcı olmaktan mutluluk duyarım 🍔✨ Ekibimiz de kısa süre içinde sizinle iletişime geçecek.',
  ur: 'خوش آمدید! 🌟 مینیو، اوقات، مقام یا آفرز کے بارے میں کسی بھی سوال میں میں آپ کی مدد کر سکتا ہوں 🍔✨ ہماری ٹیم بھی جلد آپ سے رابطہ کرے گی۔'
};

// Heuristic: does the drafted reply already disclose the AI identity?
const IDENTITY_MARKERS = [
  'ai', 'bot', 'agent', 'automated', 'automat', 'robot',
  'ذكاء', 'آلي', 'تلقائي', 'بوت', 'روبوت',
  'asistan', 'assistant', 'asistente', 'assistent'
];

export function hasIdentityDisclosure(text = '') {
  const t = text.toLowerCase();
  return IDENTITY_MARKERS.some((m) => t.includes(m));
}

export function pickLocalized(table, lang) {
  return table[lang] || table.en;
}
