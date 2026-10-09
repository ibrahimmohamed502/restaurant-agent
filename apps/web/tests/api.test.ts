import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

declare const global: { document?: { cookie: string } };

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
}

/** Install a fetch stub without tripping TypeScript. */
function stubFetch(fn: unknown) {
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
}

describe('api client', () => {
  beforeEach(() => {
    global.document = { cookie: 'csrf_token=abc123' };
  });
  afterEach(() => {
    stubFetch(undefined);
  });

  it('unwraps { data } on success', async () => {
    stubFetch(mockFetchOnce(200, { data: { ok: true } }));
    const { api } = await import('@/lib/api');
    await expect(api.get<{ ok: boolean }>('/auth/me')).resolves.toEqual({ ok: true });
  });

  it('maps the error envelope to ApiError with code/status', async () => {
    stubFetch(mockFetchOnce(401, { error: { code: 'INVALID_CREDENTIALS', message: 'nope' } }));
    const { authApi } = await import('@/lib/api');
    await expect(authApi.login('a@b.co', 'x')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INVALID_CREDENTIALS',
      status: 401
    });
  });

  it('sends CSRF header on mutations and credentials include', async () => {
    stubFetch(mockFetchOnce(200, { data: { ok: true } }));
    const { authApi } = await import('@/lib/api');
    await authApi.logout();
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers['x-csrf-token']).toBe('abc123');
  });

  it('reads the CSRF token from the cookie', async () => {
    const { csrfToken } = await import('@/lib/api');
    expect(csrfToken()).toBe('abc123');
  });

  it('maps network failures to NETWORK_ERROR', async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error('offline')));
    const { api, ApiError } = await import('@/lib/api');
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
  });
});
