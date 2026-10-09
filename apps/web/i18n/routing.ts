export const locales = ['ar', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'ar';
export const localeDirection: Record<Locale, 'rtl' | 'ltr'> = { ar: 'rtl', en: 'ltr' };
export const localeNames: Record<Locale, string> = { ar: 'العربية', en: 'English' };

export function directionFor(locale: Locale | string): 'rtl' | 'ltr' {
  return locale === 'en' ? 'ltr' : 'rtl';
}
