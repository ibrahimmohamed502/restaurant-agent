import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { brandGrantsApi, describeGrantError } from '@/lib/brand-grants-api';
import { ApiError } from '@/lib/api';

declare const global: { document?: { cookie: string }; fetch?: unknown };

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
}

function stubFetch(fn: unknown) {
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
}

describe('brand-grants client', () => {
  beforeEach(() => { global.document = { cookie: 'csrf_token=abc123' }; });
  afterEach(() => { stubFetch(undefined); });

  it('unwraps the { data } envelope on grant', async () => {
    stubFetch(mockFetchOnce(201, { data: { granted: true, id: 'g1', grantedAt: '2026-01-01' } }));
    await expect(brandGrantsApi.grant('u1', 'b1')).resolves.toEqual({ granted: true, id: 'g1', grantedAt: '2026-01-01' });
  });

  it('unwraps the history envelope', async () => {
    stubFetch(mockFetchOnce(200, { data: [{ id: 'g1', brandId: 'b1', brandName: 'B1', live: true }] }));
    await expect(brandGrantsApi.history('u1')).resolves.toHaveLength(1);
  });

  it('unwraps the scope envelope', async () => {
    stubFetch(mockFetchOnce(200, { data: { allBrands: false, brandIds: ['b1'], roles: [], tenantId: 't1', isPlatformSuperAdmin: false } }));
    const s = await brandGrantsApi.me();
    expect(s.allBrands).toBe(false);
    expect(s.brandIds).toEqual(['b1']);
  });

  it('passes the CSRF pair on mutations, not on reads', async () => {
    const fn = mockFetchOnce(200, { data: [] });
    stubFetch(fn);
    await brandGrantsApi.history('u1');
    const h = (fn as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(h['x-csrf-token']).toBeUndefined();

    stubFetch(mockFetchOnce(201, { data: { granted: true, id: 'g2', grantedAt: 'x' } }));
    const fn2 = global.fetch as ReturnType<typeof vi.fn>;
    await brandGrantsApi.grant('u1', 'b1');
    const h2 = fn2.mock.calls[0][1].headers;
    expect(h2['x-csrf-token']).toBe('abc123');
  });

  it('surfaces 403 FORBIDDEN as an ApiError with the server code', async () => {
    stubFetch(mockFetchOnce(403, { error: { code: 'FORBIDDEN', message: 'insufficient permissions' } }));
    await expect(brandGrantsApi.grant('u1', 'b1')).rejects.toMatchObject({
      name: 'ApiError', code: 'FORBIDDEN', status: 403
    });
  });

  it('surfaces 409 SELF_REVOKE_FORBIDDEN', async () => {
    stubFetch(mockFetchOnce(409, { error: { code: 'SELF_REVOKE_FORBIDDEN', message: 'no' } }));
    await expect(brandGrantsApi.revoke('u1', 'b1')).rejects.toMatchObject({
      name: 'ApiError', code: 'SELF_REVOKE_FORBIDDEN', status: 409
    });
  });

  it('surfaces 404 BRAND_NOT_FOUND', async () => {
    stubFetch(mockFetchOnce(404, { error: { code: 'BRAND_NOT_FOUND', message: 'no' } }));
    await expect(brandGrantsApi.grant('u1', 'missing')).rejects.toMatchObject({
      name: 'ApiError', code: 'BRAND_NOT_FOUND', status: 404
    });
  });

  it('surfaces 404 TARGET_NOT_FOUND', async () => {
    stubFetch(mockFetchOnce(404, { error: { code: 'TARGET_NOT_FOUND', message: 'no' } }));
    await expect(brandGrantsApi.grant('ghost', 'b1')).rejects.toMatchObject({
      name: 'ApiError', code: 'TARGET_NOT_FOUND', status: 404
    });
  });

  it('turns a network failure into ApiError(0, NETWORK_ERROR)', async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error('boom')));
    await expect(brandGrantsApi.grant('u1', 'b1')).rejects.toMatchObject({
      name: 'ApiError', code: 'NETWORK_ERROR', status: 0
    });
  });

  it('maps server codes to stable UI keys via describeGrantError', () => {
    expect(describeGrantError(new ApiError(409, 'SELF_REVOKE_FORBIDDEN', 'x'))).toBe('self-revoke');
    expect(describeGrantError(new ApiError(404, 'BRAND_NOT_FOUND', 'x'))).toBe('brand-not-found');
    expect(describeGrantError(new ApiError(404, 'TARGET_NOT_FOUND', 'x'))).toBe('target-not-found');
    expect(describeGrantError(new ApiError(404, 'GRANT_NOT_FOUND', 'x'))).toBe('grant-not-found');
    expect(describeGrantError(new Error('boom'))).toBe('UNKNOWN');
  });

  it('revokeAll passes the right method and path', async () => {
    const fn = mockFetchOnce(200, { data: { revoked: true, id: 'g9' } });
    stubFetch(fn);
    await brandGrantsApi.revokeAll('u1');
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain('/brand-grants/users/u1/brands/all');
    expect(call[1].method).toBe('DELETE');
  });
});
