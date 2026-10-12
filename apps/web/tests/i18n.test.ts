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

describe('knowledge workspace translation parity', () => {
  it('knowledge namespace has exact EN/AR key parity', () => {
    const enK = (en as Record<string, unknown>).knowledge as Record<string, unknown>;
    const arK = (ar as Record<string, unknown>).knowledge as Record<string, unknown>;
    expect(Object.keys(enK).sort().join(',')).toBe(Object.keys(arK).sort().join(','));
  });

  it('knowledge namespace covers sections, menu, branches, actions and dialogs', () => {
    const enK = (en as Record<string, unknown>).knowledge as Record<string, Record<string, unknown>>;
    expect(enK.sections.branches).toBeTruthy();
    expect(enK.sections.overview).toBeTruthy();
    expect(enK.sections.faq).toBeTruthy();
    expect(enK.sections.policies).toBeTruthy();
    expect(enK.sections.sources).toBeTruthy();
    expect(enK.menu.addCategory).toBeTruthy();
    expect(enK.menu.editItem).toBeTruthy();
    expect(enK.branches.add).toBeTruthy();
    expect(enK.actions.publish).toBeTruthy();
    expect(enK.actions.saveDraft).toBeTruthy();
    expect((enK.dialog as Record<string, Record<string, unknown>>).publish.title).toBeTruthy();
    expect(enK.back).toBeTruthy();
    // all leaves are strings (no nested empty values)
    const walk = (o: unknown): unknown[] => (typeof o === 'object' && o !== null ? Object.values(o).flatMap(walk) : [o]);
    expect(walk(enK).every((v) => typeof v === 'string')).toBe(true);
  });
});
