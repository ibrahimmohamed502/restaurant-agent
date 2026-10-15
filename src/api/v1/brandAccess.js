/**
 * Stage 8 Batch 2 — server-side brand access policy (single source of truth).
 *
 * Tenant ownership alone is NOT sufficient: once a company restricts a user to
 * specific brands, every brand-scoped endpoint must honour that restriction.
 * Today no per-user brand grants exist (no table, no session field), so every
 * session resolves to the tenant-wide scope and behaviour is unchanged. The
 * extension point is `auth.brandIds` on the validated session: when brand
 * grants are introduced, only `sessions.js` needs to populate it — every
 * endpoint that calls this helper inherits the rule automatically.
 *
 * RULES:
 *  - `brandIds === null/undefined`  → tenant-wide scope (all brands of the tenant)
 *  - `brandIds = [...]`             → restricted to exactly those brands
 *  - A restricted caller NEVER sees company-wide (brand_id IS NULL) channels:
 *    those are not attributable to one of their brands.
 *  - A brand outside the scope is indistinguishable from a brand that does not
 *    exist (404), so the API cannot be used as an existence oracle.
 */

export const BRAND_SCOPE_TENANT = 'tenant';
export const BRAND_SCOPE_RESTRICTED = 'restricted';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Resolve the caller's brand scope from the authenticated session. */
export function brandScopeFromSession(v1) {
  const raw = v1?.brandIds;
  if (!Array.isArray(raw)) return { mode: BRAND_SCOPE_TENANT, brandIds: null };
  const brandIds = [...new Set(raw.filter(isUuid))];
  if (brandIds.length === 0) return { mode: BRAND_SCOPE_TENANT, brandIds: null };
  return { mode: BRAND_SCOPE_RESTRICTED, brandIds };
}

/** Is a channel's brand visible under this scope? */
export function brandVisibleToScope(brandId, scope) {
  if (scope.mode === BRAND_SCOPE_TENANT) return true;
  return Boolean(brandId) && scope.brandIds.includes(brandId);
}

/**
 * Is this brand id owned by the tenant AND inside the caller's scope?
 * Used before applying a `?brandId=` filter.
 */
export async function brandIsAccessible({ db, tenantId, brandId, scope }) {
  if (!isUuid(brandId)) return false;
  if (!brandVisibleToScope(brandId, scope)) return false;
  const { rows } = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`,
    [brandId, tenantId]
  );
  return Boolean(rows[0]);
}