/**
 * Stage 7 + Stage 8 Batch 1 — server-authoritative RBAC.
 *
 * Roles come from the authenticated session (req.v1.roles), which is populated
 * from the `roles` table. Platform Super Admin has platform-level access.
 *
 * The UI hides buttons, but the API is the ONLY authority — hiding a control is
 * not a security boundary.
 */
import { apiError } from './index.js';

// Platform Super Admin: platform-level permissions (separate security boundary)
// Company Admin: full access within their tenant (NO platform.*)
// Supervisor: inbox management, assignments, limited brand/user management
// Agent: own conversations only, notes, notifications

const ROLE_ABILITIES = {
  'Platform Super Admin': [
    'platform.*',
    'company.read', 'company.create', 'company.update', 'company.disable',
    'company.metrics'
  ],
  'Company Admin': [
    'brand.read', 'brand.create', 'brand.update', 'brand.disable',
    'user.read', 'user.create', 'user.update', 'user.disable',
    'brand.integration.connect', 'brand.integration.disconnect',
    'brand.integration.reconnect', 'brand.integration.status',
    'company.read', 'company.update',
    'conversation.read', 'conversation.handoff', 'conversation.assign',
    'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply',
    'note.read', 'note.create', 'note.delete_any', 'notification.read',
    'conversation.assign_self', 'conversation.reply_own', 'conversation.resolve_own',
    'note.delete_own'
  ],
  Supervisor: [
    'conversation.read', 'conversation.handoff', 'conversation.assign',
    'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply',
    'note.read', 'note.create', 'note.delete_any', 'notification.read',
    'brand.read', 'brand.update', 'brand.integration.connect',
    'brand.integration.disconnect', 'brand.integration.reconnect',
    'brand.integration.status', 'user.read', 'user.update'
  ],
  Agent: [
    'conversation.read', 'conversation.handoff', 'conversation.assign_self',
    'conversation.reply_own', 'conversation.resolve_own',
    'note.read', 'note.create', 'note.delete_own', 'notification.read',
    'brand.read', 'brand.integration.status'
  ]
};

/** Can these roles do this? */
export function can(roles = [], ability) {
  if (!Array.isArray(roles)) return false;
  return roles.some((r) => {
    const abilities = ROLE_ABILITIES[r];
    if (!abilities) return false;
    return abilities.includes('*') || abilities.includes(ability) || abilities.some(a => a.endsWith('*') && ability.startsWith(a.slice(0, -1)));
  });
}

export function isSupervisorOrAdmin(roles = []) {
  return can(roles, 'conversation.assign');
}

export function isPlatformSuperAdmin(roles = []) {
  return roles.includes('Platform Super Admin');
}

export function isCompanyAdmin(roles = []) {
  return roles.includes('Company Admin');
}

/** Express guard: requires one of the given abilities. */
export function requireAbility(...abilities) {
  return (req, res, next) => {
    if (!abilities.some((a) => can(req.v1?.roles, a))) {
      return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    }
    next();
  };
}

/** Does this user hold a handling role at all? */
export function hasHandlingRole(roles = []) {
  return ['Company Admin', 'Supervisor', 'Agent'].some((r) => roles.includes(r));
}

/** Guard: only Platform Super Admin may access platform-level endpoints. */
export function requirePlatformSuperAdmin(req, res, next) {
  if (!isPlatformSuperAdmin(req.v1?.roles)) {
    return apiError(res, 403, 'FORBIDDEN', 'platform super admin required');
  }
  next();
}