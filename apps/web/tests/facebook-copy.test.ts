import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

// The Facebook integration screen had two strings that contradicted each other,
// and contradicted the server.
//
//   connections.reconnectHint  said a Page CAN be moved to another brand by
//                               reconnecting and choosing that brand.
//   errors.CROSS_BRAND_...     said reconnecting is only allowed to the same
//                               brand.
//
// The server is the authority: a Page's brand is fixed, and a reconnect to a
// different brand is refused with 409 PAGE_CROSS_BRAND_TRANSFER_FORBIDDEN.
// These tests pin the copy to the server's behaviour, in both languages, so
// the two strings can never drift apart again.

/** Every leaf key of an object, as dotted paths. */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return [prefix];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out.push(...leafKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

describe('facebook integration copy: brand ownership', () => {
  it('the English hint does not tell the user a Page can move between brands', () => {
    const hint = en.facebook.connections.reconnectHint;
    expect(hint).toBeTypeOf('string');
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toMatch(/move a page to another brand/i);
    expect(hint).not.toMatch(/updated in place/i);
    expect(hint).not.toMatch(/choose that brand/i);
  });

  it('the English hint states that reconnect is allowed only for the same brand', () => {
    expect(en.facebook.connections.reconnectHint).toMatch(/only allowed for the same brand/i);
    expect(en.facebook.connections.reconnectHint).toMatch(/cannot be moved to another brand/i);
  });

  it('the Arabic hint does not tell the user a Page can move between brands', () => {
    const hint = ar.facebook.connections.reconnectHint;
    expect(hint).toBeTypeOf('string');
    expect(hint.length).toBeGreaterThan(0);
    // "لنقل صفحة" = "to move a page" - the instruction that was removed.
    expect(hint).not.toMatch(/لنقل صفحة/);
    expect(hint).not.toMatch(/يتم تحديث الصفحة في مكانها/);
  });

  it('the Arabic hint states that reconnect is allowed only for the same brand', () => {
    // "للعلامة التجارية نفسها" = "for the same brand"
    expect(ar.facebook.connections.reconnectHint).toMatch(/للعلامة التجارية نفسها/);
    // "لا يمكن نقل الصفحة" = "the page cannot be moved"
    expect(ar.facebook.connections.reconnectHint).toMatch(/لا يمكن نقل الصفحة/);
  });

  it('the count label says the count is the Facebook-login (OAuth) connections', () => {
    expect(en.facebook.connections.count).toMatch(/facebook login/i);
    expect(en.facebook.connections.count).toMatch(/\{count\}/);
    expect(ar.facebook.connections.count).toMatch(/تسجيل دخول فيسبوك/);
    expect(ar.facebook.connections.count).toMatch(/\{count\}/);
  });

  it('the cross-brand error is still described correctly in both languages', () => {
    expect(en.facebook.errors.CROSS_BRAND_TRANSFER_FORBIDDEN).toMatch(/same brand/i);
    expect(ar.facebook.errors.CROSS_BRAND_TRANSFER_FORBIDDEN).toMatch(/للعلامة التجارية نفسها/);
  });
});

describe('facebook integration copy: translation consistency', () => {
  it('en.json and ar.json have exactly the same keys in the facebook namespace', () => {
    const enKeys = leafKeys(en.facebook).sort();
    const arKeys = leafKeys(ar.facebook).sort();
    expect(arKeys, 'ar.json is missing keys that en.json has').toEqual(enKeys);
  });

  it('no facebook string is left empty in either language', () => {
    for (const key of leafKeys(en.facebook)) {
      const enValue = key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], en.facebook);
      const arValue = key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], ar.facebook);
      expect(typeof enValue, `en.${key}`).toBe('string');
      expect((enValue as string).length, `en.${key}`).toBeGreaterThan(0);
      expect(typeof arValue, `ar.${key}`).toBe('string');
      expect((arValue as string).length, `ar.${key}`).toBeGreaterThan(0);
    }
  });

  it('neither language contains the removed instruction any more', () => {
    const blob = JSON.stringify({ en: en.facebook, ar: ar.facebook });
    expect(blob).not.toMatch(/move a page to another brand/i);
    expect(blob).not.toMatch(/لنقل صفحة/);
  });
});

describe('facebook integration screen: the count is not a total', () => {
  const src = readFileSync(new URL('../app/(app)/integrations/facebook/page.tsx', import.meta.url), 'utf8');

  it('counts only connections the API reports as healthy and active', () => {
    expect(src).toMatch(/c\.connectionHealthy && c\.status === 'active'/);
  });

  it('does not present a live legacy integration as a missing connection', () => {
    // A live legacy integration is a working integration, so the badge must not
    // be rendered as a warning while one is present.
    expect(src).toMatch(/hasLegacyConnections/);
    expect(src).toMatch(/connectedCount > 0 \? 'success' : hasLegacyConnections \? 'neutral' : 'warning'/);
  });
});
