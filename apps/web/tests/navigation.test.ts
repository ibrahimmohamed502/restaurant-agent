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
});
