'use client';

import { directionFor, defaultLocale, type Locale } from '@/i18n/routing';

const ONE_YEAR = 60 * 60 * 24 * 365;

export function setLocaleCookie(locale: Locale) {
  if (typeof document === 'undefined') return;
  document.cookie = `locale=${locale}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

export function setThemeCookie(theme: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  document.cookie = `theme=${theme}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  return document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.split('=')[1] ?? null;
}

export { directionFor, defaultLocale };
export type { Locale };
