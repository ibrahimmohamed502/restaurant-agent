/**
 * Server-side brand access policy (single source of truth).
 *
 * TENANT OWNERSHIP ALONE IS NOT SUFFICIENT. Once a company restricts a user to
 * specific brands, every brand-scoped endpoint must honour that restriction —
 * and, critically, a MISSING grant must never be read as "everything is
 * allowed". That default is what let any authenticated user act on any brand.
 *
 * HOW SCOPE IS RESOLVED (fail-closed, in this order):
 *
 *   1. `brandIds` is a non-empty array of valid uuids
 *        -> RESTRICTED to exactly those brands.
 *   2. `brandIds === []`
 *        -> RESTRICTED to ZERO brands. An explicit empty scope means "none".
 *   3. `brandIds` is present but malformed (string, object, number, array-like)
 *        -> RESTRICTED to ZERO brands. A malformed grant is never treated as
 *           "no grant given", and never falls back to tenant-wide.
 *   4. `brandIds` is absent (undefined | null)
 *        -> resolved from an EXPLICIT ROLE POLICY, not from the absence of a
 *           grant: the caller gets tenant-wide scope only if their roles carry
 *           `brand.read` (TENANT_WIDE_BRAND_ABILITY). Every other role —
 *           including Platform Super Admin and any unrecognised/custom role —
 *           resolves to ZERO brands.
 *
 * Case 4 is the change that closes the gap. Previously an absent `brandIds`
 * meant tenant-wide, so every session was implicitly unrestricted. It now
 * requires a positive authorisation.
 *
 * Platform Super Admin deliberately gets NO tenant-wide scope: platform
 * privileges must not imply the right to see or act on a company's brands.
 *
 * FURTHER RULES:
 *  - A restricted caller NEVER sees company-wide (brand_id IS NULL) channels:
 *    those are not attributable to one of their brands.
 *  - A brand outside the scope is indistinguishable from one that does not
 *    exist, so an endpoint cannot be used as an existence oracle.
 */

import { hasTenantWideBrandScope } from '../../auth/abilities.js';

export const BRAND_SCOPE_TENANT = 'tenant';
export const BRAND_SCOPE_RESTRICTED = 'restricted';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/**
 * Resolve the caller's brand scope from the authenticated session.
 *
 * Accepts the dashboard's `req.auth` and the v1 API's `req.v1` — both expose
 * `{ roles, brandIds }`. Fail-closed: only an explicit role policy or an
 * explicit grant ever yields more than zero brands.
 */
export function brandScopeFromSession(auth) {
  const raw = auth?.brandIds;
  const roles = auth?.roles ?? [];

  // An explicit, well-formed grant list is the strongest signal.
  if (Array.isArray(raw)) {
    return { mode: BRAND_SCOPE_RESTRICTED, brandIds: [...new Set(raw.filter(isUuid))] };
  }

  // Present but malformed -> fail closed. NEVER falls through to tenant-wide.
  if (raw !== undefined && raw !== null) {
    return { mode: BRAND_SCOPE_RESTRICTED, brandIds: [] };
  }

  // Absent: resolve from an explicit role policy, not from the missing grant.
  if (hasTenantWideBrandScope(roles)) {
    return { mode: BRAND_SCOPE_TENANT, brandIds: null };
  }
  return { mode: BRAND_SCOPE_RESTRICTED, brandIds: [] };
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

/**
 * SQL fragments that apply this scope inside an existing query.
 *
 * Used so authorisation is evaluated by the DATABASE in the same statement as
 * the mutation it guards — closing the time-of-check/time-of-use window between
 * a separate permission query and the retry claim.
 *
 * `alias` is the channels table alias (e.g. 'ch').
 */
export function brandScopeSql(alias = 'ch', { tenantWideParam = 1, brandIdsParam = 2 } = {}) {
  return {
    // NULL brand_id (company-wide channel) is visible ONLY to a tenant-wide caller.
    //
    // The parameter positions are bound placeholders ($1, $2, ...), NOT literal
    // numbers: interpolating `5` instead of `$5` would emit `(5::boolean ...)`,
    // which is a different expression entirely.
    sql: `($${tenantWideParam}::boolean OR (${alias}.brand_id IS NOT NULL AND ${alias}.brand_id = ANY($${brandIdsParam}::uuid[])))`,
    params: (scope) => [
      scope?.mode === BRAND_SCOPE_TENANT,
      scope?.mode === BRAND_SCOPE_TENANT ? [] : (scope?.brandIds ?? [])
    ]
  };
}