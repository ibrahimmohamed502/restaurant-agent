/**
 * Stage 7 — server-authoritative RBAC.
 *
 * Roles come from the authenticated session (req.v1.roles), which is populated
 * from the `roles` table. 'Company Admin' is always full access.
 *
 * The UI hides buttons, but the API is the ONLY authority — hiding a control is
 * not a security boundary.
 */
import { apiError } from './index.js';

const ROLE_ABILITIES = {
  'Company Admin': ['*'],
  Supervisor: [
    'conversation.read', 'conversation.handoff', 'conversation.assign',
    'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply',
    'note.read', 'note.create', 'note.delete_any', 'notification.read'
  ],
  Agent: [
    'conversation.read', 'conversation.handoff', 'conversation.assign_self',
    'conversation.reply_own', 'conversation.resolve_own',
    'note.read', 'note.create', 'note.delete_own', 'notification.read'
  ]
};

/** Can these roles do this? */
export function can(roles = [], ability) {
  if (!Array.isArray(roles)) return false;
  return roles.some((r) => {
    const abilities = ROLE_ABILITIES[r];
    if (!abilities) return false;
    return abilities.includes('*') || abilities.includes(ability);
  });
}

export function isSupervisorOrAdmin(roles = []) {
  return can(roles, 'conversation.assign');
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
