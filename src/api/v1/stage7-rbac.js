/**
 * Stage 7 + Stage 8 Batch 1 — server-authoritative RBAC.
 *
 * Roles come from the authenticated session (req.v1.roles), which is populated
 * from the `roles` table. Platform Super Admin has platform-level access.
 *
 * The UI hides buttons, but the API is the ONLY authority — hiding a control is
 * not a security boundary.
 *
 * The ability map itself now lives in src/auth/abilities.js, which is pure and
 * dependency-free. It is re-exported here so every existing import path
 * (`from './stage7-rbac.js'`) keeps working, and so modules that must not import
 * the v1 router can still evaluate abilities without an import cycle.
 */
import { apiError } from './index.js';
import {
  can,
  isSupervisorOrAdmin,
  isPlatformSuperAdmin,
  isCompanyAdmin,
  hasHandlingRole,
  hasTenantWideBrandScope,
  ROLE_ABILITIES,
  TENANT_WIDE_BRAND_ABILITY
} from '../../auth/abilities.js';

export {
  can,
  isSupervisorOrAdmin,
  isPlatformSuperAdmin,
  isCompanyAdmin,
  hasHandlingRole,
  hasTenantWideBrandScope,
  ROLE_ABILITIES,
  TENANT_WIDE_BRAND_ABILITY
};

/** Express guard: requires one of the given abilities. */
export function requireAbility(...abilities) {
  return (req, res, next) => {
    if (!abilities.some((a) => can(req.v1?.roles, a))) {
      return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    }
    next();
  };
}

/** Guard: only Platform Super Admin may access platform-level endpoints. */
export function requirePlatformSuperAdmin(req, res, next) {
  if (!isPlatformSuperAdmin(req.v1?.roles)) {
    return apiError(res, 403, 'FORBIDDEN', 'platform super admin required');
  }
  next();
}