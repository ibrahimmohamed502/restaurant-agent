import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { defaultLocale, locales, directionFor, type Locale } from './routing';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

const MESSAGES: Record<Locale, typeof ar> = { ar, en };

/** Cookie-based locale (Arabic default), Accept-Language fallback. */
export function pickLocale(cookieLocale?: string, acceptLanguage?: string): Locale {
  if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) return cookieLocale as Locale;
  const preferred = (acceptLanguage || '').split(',').map((p) => p.split(';')[0].trim().slice(0, 2));
  const match = preferred.find((p) => (locales as readonly string[]).includes(p));
  return (match as Locale) || defaultLocale;
}

export default getRequestConfig(async () => {
  const jar = cookies();
  const hdrs = headers();
  const locale = pickLocale(jar.get('locale')?.value, hdrs.get('accept-language') || '');
  return { locale, messages: MESSAGES[locale], direction: directionFor(locale), timeZone: 'Asia/Kuwait' };
});
