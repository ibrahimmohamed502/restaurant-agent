import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const PAGES = ['ai', 'audit', 'brands', 'channels', 'companies', 'customers', 'integrations', 'settings'];

/** Roadmap modules must render the localized placeholder text — never the raw key. */
describe('roadmap placeholder pages', () => {
  it('every roadmap page reads the placeholder key from the root messages', () => {
    for (const p of PAGES) {
      const src = readFileSync(new URL(`../app/(app)/${p}/page.tsx`, import.meta.url), 'utf8');
      expect(src, p).toContain("tp('placeholder')");
      expect(src, p).not.toContain("tp('')");
      expect(src, p).not.toContain("getTranslations('placeholder')");
    }
  });

  it('placeholder copy exists as a translated string in EN and AR', () => {
    expect(typeof (en as Record<string, unknown>).placeholder).toBe('string');
    expect(typeof (ar as Record<string, unknown>).placeholder).toBe('string');
    expect((en as unknown as Record<string, string>).placeholder).not.toContain('placeholder');
  });

  it('empty state uses the localized states namespace (no raw keys)', () => {
    expect(en.states.emptyTitle).toBeTruthy();
    expect(ar.states.emptyTitle).toBeTruthy();
    expect(en.states.emptyDescription).toBeTruthy();
    expect(ar.states.emptyDescription).toBeTruthy();
  });
});
