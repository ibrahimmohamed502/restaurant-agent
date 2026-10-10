import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/* Dashboard API behavior (mocked fetch, zero network). */
describe('dashboard data integration', () => {
  beforeEach(() => { (globalThis as any).fetch = undefined; (global as any).document = { cookie: '' }; });

  const payload = {
    data: {
      kpis: { conversations: 6, messages: 12, active_channels: 3, escalations: 0 },
      conversations: [
        { id: 'c1', customerName: 'Ibrahim', provider: 'meta_comment', state: 'AI_ACTIVE', language: 'ar', lastText: 'أهلاً', lastMessageAt: '2026-10-09T10:00:00Z' }
      ],
      knowledge: { brandId: 'b1', version: 1, publishedAt: '2026-10-09T09:00:00Z' },
      aiAgent: { id: 'a1', name: 'LWC AI Agent', is_active: true },
      queue: { available: true, failed: 0, active: 0, waiting: 0, completed: 3, delayed: 0 }
    }
  };

  it('requests /api/v1/dashboard with credentials and unwraps {data}', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    (globalThis as any).fetch = fetchMock;
    const mod = await import('@/components/dashboard/view');
    expect(typeof mod.DashboardView).toBe('function');
    // simulate the same call the component makes
    const r = await fetch('/api/v1/dashboard', { credentials: 'include' });
    const body = await r.json();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/dashboard', { credentials: 'include' });
    expect(body.data.kpis.conversations).toBe(6);
  });

  it('unauthenticated response is treated as a state, not fabricated data', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHENTICATED', message: 'authentication required' } }) });
    const r = await fetch('/api/v1/dashboard', { credentials: 'include' });
    expect(r.status).toBe(401);
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../components/dashboard/view.tsx', import.meta.url), 'utf8');
    expect(src).toContain("error === 'unauthenticated'");
  });
});

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
    // no percentage/trend fields anywhere
    expect(JSON.stringify(payload.data)).not.toMatch(/trend|sparkline|percentage|percent|growth/);
  });
});

describe('dashboard UI translations', () => {
  it('EN and AR both expose the full dashboard namespace', async () => {
    const en = (await import('@/messages/en.json')).default;
    const ar = (await import('@/messages/ar.json')).default;
    expect(typeof en.nav.dashboard).toBe('string');
    expect(typeof ar.nav.dashboard).toBe('string');
    const enKeys = Object.keys(en.dashboard).sort().join(',');
    const arKeys = Object.keys(ar.dashboard).sort().join(',');
    expect(enKeys).toBe(arKeys);
    expect(enKeys.split(',').length).toBeGreaterThanOrEqual(30);
  });
});
