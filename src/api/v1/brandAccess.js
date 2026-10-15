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
 * RULES (fail-closed):
 *  - `brandIds === undefined | null` -> tenant-wide scope (all brands). This is
 *    the ONLY tenant-wide case: it means "no explicit scope was provided",
 *    pending a future explicit grants model.
 *  - `brandIds === []` -> restricted to ZERO brands (never tenant-wide): an
 *    explicit empty scope means "no brands".
 *  - non-empty array -> only the validated uuids inside it.
 *  - any other shape (string, object, number, array-like) -> malformed ->
 *    fail closed with ZERO brands. Never tenant-wide.
 *  - array holding only invalid ids -> ZERO brands.
 *  - A restricted caller NEVER sees company-wide (brand_id IS NULL) channels:
 *    those are not attributable to one of their brands.
 *  - A brand outside the scope is indistinguishable from a brand that does not
 *    exist (404), so the API cannot be used as an existence oracle.
 */

export const BRAND_SCOPE_TENANT = 'tenant';
export const BRAND_SCOPE_RESTRICTED = 'restricted';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/**
 * Resolve the caller's brand scope from the authenticated session.
 *
 * Fail-closed: only an absent scope (undefined/null) is tenant-wide. Anything
 * that is not a valid brand-id array yields zero-brand access.
 */
export function brandScopeFromSession(v1) {
  const raw = v1?.brandIds;

  // The only tenant-wide case: no explicit scope was provided.
  if (raw === undefined || raw === null) {
    return { mode: BRAND_SCOPE_TENANT, brandIds: null };
  }

  // Malformed scope (string, object, number, array-like) -> fail closed.
  if (!Array.isArray(raw)) {
    return { mode: BRAND_SCOPE_RESTRICTED, brandIds: [] };
  }

  // An array is an explicit scope: keep only valid, unique uuids.
  // [] and all-invalid arrays intentionally resolve to ZERO brands.
  const brandIds = [...new Set(raw.filter(isUuid))];
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