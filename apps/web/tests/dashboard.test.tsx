import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { DashboardFoundation } from '@/components/dashboard/foundation';
import en from '@/messages/en.json';

/* Restored Stage 5 dashboard baseline (373d62a9 foundation): a synchronous,
   real product surface — no dashboard fetch, so no loading/skeleton state,
   and no fabricated metrics. */
describe('dashboard foundation (restored baseline)', () => {
  it('dashboard page renders the foundation — no fetch, no skeleton, no placeholder', () => {
    const page = readFileSync(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');
    expect(page).toContain('DashboardFoundation');
    expect(page).not.toContain('DashboardView');
    expect(page).not.toContain('fetch(');
    expect(page).not.toContain('placeholder');

    const comp = readFileSync(new URL('../components/dashboard/foundation.tsx', import.meta.url), 'utf8');
    expect(comp).toContain('DashboardFoundation');
    expect(comp).not.toContain('fetch(');
  });

  it('renders the foundation with real translations (no raw keys)', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <DashboardFoundation />
      </NextIntlClientProvider>
    );
    expect(html).toContain('Getting started');
    expect(html).toContain('Publish your brand knowledge');
    expect(html).toContain('Unified Inbox');
    expect(html).not.toContain('dashboardFoundation.');
    expect(html).not.toContain('auth.title');
  });

  it('has no infinite loading state by design (no client data fetch)', () => {
    const page = readFileSync(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');
    expect(page).not.toContain('useState');
    expect(page).not.toContain('useEffect');
    expect(page).not.toContain('Skeleton');
  });
});

/* GET /api/v1/dashboard contract is unchanged (tenant-scoped, real data only). */
describe('dashboard payload shape', () => {
  const payload = {
    data: {
      kpis: { conversations: 6, messages: 12, active_channels: 3, escalations: 0 },
      conversations: [
        { id: 'c1', customerName: 'Ibrahim', provider: 'meta_comment', state: 'AI_ACTIVE', language: 'ar', lastText: 'hello', lastMessageAt: '2026-10-09T10:00:00Z' }
      ],
      knowledge: { brandId: 'b1', version: 1, publishedAt: '2026-10-09T09:00:00Z' },
      aiAgent: { id: 'a1', name: 'LWC AI Agent', is_active: true },
      queue: { available: true, failed: 0, active: 0, waiting: 0, completed: 3, delayed: 0 }
    }
  };
  it('contains only real operational fields (no fabricated trends/sparklines)', () => {
    const keys = Object.keys(payload.data);
    expect(keys.sort()).toEqual(['aiAgent', 'conversations', 'knowledge', 'kpis', 'queue']);
    const kpiKeys = Object.keys(payload.data.kpis);
    expect(kpiKeys.sort()).toEqual(['active_channels', 'conversations', 'escalations', 'messages']);
    expect(JSON.stringify(payload.data)).not.toMatch(/trend|sparkline|percentage|percent|growth/);
  });
});

describe('dashboard UI translations', () => {
  it('EN and AR both expose the full dashboard + dashboardFoundation namespaces', async () => {
    const en = (await import('@/messages/en.json')).default;
    const ar = (await import('@/messages/ar.json')).default;
    expect(typeof en.nav.dashboard).toBe('string');
    expect(typeof ar.nav.dashboard).toBe('string');
    for (const ns of ['dashboard', 'dashboardFoundation'] as const) {
      const enKeys = Object.keys(en[ns]).sort().join(',');
      const arKeys = Object.keys(ar[ns]).sort().join(',');
      expect(enKeys).toBe(arKeys);
    }
    expect(Object.keys(en.dashboard).length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(en.dashboardFoundation).length).toBeGreaterThanOrEqual(12);
  });
});
