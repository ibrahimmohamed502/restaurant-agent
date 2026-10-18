/**
 * P0.5-C — typed client for /api/v1/brand-grants.
 *
 * Brand access is NOT owned by /teams. It has its own abilities
 * (brand.grant, brand.revoke, brand.grant_all, brand.revoke_all, brand.read)
 * and its own routes. This client is the thin bridge so the /teams screen can
 * show and edit it without re-implementing it - two places that both "manage
 * access" would eventually disagree about who can see what.
 *
 * The server stays the authority on everything, including the delegation
 * ceiling: a Company Admin can only grant brands they can already reach.
 */

import { api, ApiError } from './api';

export type GrantRow = {
  id: string;
  brandId: string;
  brandName: string;
  grantedAt: string;
  revokedAt: string | null;
  live: boolean;
  reason: string | null;
};

export type BrandScope = {
  allBrands: boolean;
  brandIds: string[] | null;
};

export const brandGrantsApi = {
  me: () =>
    api.get<BrandScope & { tenantId: string; roles: string[]; isPlatformSuperAdmin: boolean }>(
      '/brand-grants/me'
    ).then((d) => d),

  history: (userId: string) =>
    api.get<GrantRow[]>(`/brand-grants/users/${userId}/brands`).then((d) => d),

  grant: (userId: string, brandId: string, reason?: string) =>
    api.post<{ granted: true; id: string; grantedAt: string }>(
      `/brand-grants/users/${userId}/brands/${brandId}`, { reason }
    ).then((d) => d),

  revoke: (userId: string, brandId: string) =>
    api.del<{ revoked: true; id: string }>(`/brand-grants/users/${userId}/brands/${brandId}`).then((d) => d),

  grantAll: (userId: string, reason?: string) =>
    api.post<{ granted: true; id: string }>(`/brand-grants/users/${userId}/brands/all`, { reason }).then((d) => d),

  revokeAll: (userId: string) =>
    api.del<{ revoked: true; id: string }>(`/brand-grants/users/${userId}/brands/all`).then((d) => d)
};

export function describeGrantError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'SELF_REVOKE_FORBIDDEN': return 'self-revoke';
      case 'BRAND_NOT_FOUND': return 'brand-not-found';
      case 'TARGET_NOT_FOUND': return 'target-not-found';
      case 'GRANT_NOT_FOUND': return 'grant-not-found';
      default: return e.code;
    }
  }
  return 'UNKNOWN';
}
