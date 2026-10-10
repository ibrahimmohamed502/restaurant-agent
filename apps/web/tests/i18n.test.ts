import { describe, expect, it } from 'vitest';
import { pickLocale } from '@/i18n/request';
import { directionFor, localeDirection, locales } from '@/i18n/routing';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const enAuth = en.auth as Record<string, unknown>;
const arAuth = ar.auth as Record<string, unknown>;

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

describe('auth/login translation parity', () => {
  it('auth namespace has exact EN/AR key parity (incl. csrfError)', () => {
    const en = Object.keys(enAuth).sort().join(',');
    const ar = Object.keys(arAuth).sort().join(',');
    expect(en).toBe(ar);
  });

  it('login uses loginTitle/loginSubtitle and csrfError — no raw auth.title keys', () => {
    expect(enAuth.loginTitle).toBeTruthy();
    expect(enAuth.loginSubtitle).toBeTruthy();
    expect(arAuth.loginTitle).toBeTruthy();
    expect(arAuth.loginSubtitle).toBeTruthy();
    expect(enAuth.csrfError).toBeTruthy();
    expect(arAuth.csrfError).toBeTruthy();
    expect(enAuth.title).toBeUndefined();
    expect(enAuth.subtitle).toBeUndefined();
    expect(arAuth.title).toBeUndefined();
    expect(arAuth.subtitle).toBeUndefined();
  });
});
