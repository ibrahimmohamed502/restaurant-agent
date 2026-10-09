import { describe, expect, it } from 'vitest';
import { pickLocale } from '@/i18n/request';
import { directionFor, localeDirection, locales } from '@/i18n/routing';

describe('i18n', () => {
  it('defaults to Arabic', () => {
    expect(pickLocale(undefined, '')).toBe('ar');
  });

  it('respects an explicit cookie', () => {
    expect(pickLocale('en', 'ar')).toBe('en');
  });

  it('falls back to accept-language when no cookie', () => {
    expect(pickLocale(undefined, 'en-US,en;q=0.9')).toBe('en');
    expect(pickLocale(undefined, 'fr-FR,fr;q=0.9')).toBe('ar');
  });

  it('maps locale → direction (RTL/LTR)', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
    expect(localeDirection).toEqual({ ar: 'rtl', en: 'ltr' });
    expect(locales).toEqual(['ar', 'en']);
  });
});
