import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '@/lib/navigation';

describe('navigation (information architecture)', () => {
  it('contains the full Stage 5 module set', () => {
    const keys = NAV_ITEMS.map((i) => i.key);
    for (const k of ['dashboard', 'inbox', 'customers', 'companies', 'brands', 'channels', 'ai', 'knowledge', 'team', 'integrations', 'audit', 'settings']) {
      expect(keys).toContain(k);
    }
  });

  it('marks super-admin-only modules for RBAC hiding', () => {
    const superOnly = NAV_ITEMS.filter((i) => i.superAdminOnly).map((i) => i.key);
    expect(superOnly).toEqual(['companies', 'audit']);
  });

  it('has unique routes', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('keeps the provider-neutral overview separate from the B1 Facebook flow', () => {
    // '/integrations' stays read-only and provider-neutral by design. B1's
    // connect flow is a distinct, provider-specific route directly after it -
    // not a mode bolted onto the overview, which would drag provider knowledge
    // into a screen that deliberately has none.
    const overview = NAV_ITEMS.find((i) => i.href === '/integrations');
    const facebook = NAV_ITEMS.find((i) => i.href === '/integrations/facebook');
    expect(overview).toBeDefined();
    expect(facebook).toBeDefined();
    expect(overview?.key).toBe('integrations');
    expect(facebook?.key).toBe('facebook');
    expect(NAV_ITEMS.indexOf(facebook!)).toBe(NAV_ITEMS.indexOf(overview!) + 1);
    expect(facebook?.superAdminOnly).toBeUndefined();
  });
});
