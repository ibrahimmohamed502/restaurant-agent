/**
 * API client for the existing Express backend (/api/v1).
 * - cookies always included (session)
 * - CSRF double-submit header on mutations
 * - typed error envelope mapping
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  return document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.split('=')[1] ?? null;
}

export function csrfToken(): string | null {
  return readCookie('csrf_token');
}

/**
 * Ensures the double-submit CSRF cookie exists before a mutating request.
 * GET /auth/me never returns credentials (401 when anonymous) but the API's
 * csrfGuard sets a fresh `csrf_token` cookie on any first touch — so calling
 * it once "warms up" the cookie without weakening CSRF in any way.
 * Safe to call repeatedly: no-op when the cookie is already present.
 */
export async function ensureCsrfToken(): Promise<string | null> {
  const existing = csrfToken();
  if (existing) return existing;
  await api.get<MeResponse>('/auth/me').catch(() => {});
  return csrfToken();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'network error');
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(res.status, err.code || 'UNKNOWN', err.message || 'unexpected error', err.details);
  }
  return payload?.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body)
};

export type MeResponse = {
  user: { id: string; email: string; name: string | null; roles: string[] };
  tenantId: string;
  roles: string[];
};

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ user: MeResponse['user']; tenantId: string }>('/auth/login', { email, password }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  me: () => api.get<MeResponse>('/auth/me')
};
