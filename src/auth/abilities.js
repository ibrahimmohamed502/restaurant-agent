/**
 * Server-authoritative abilities — PURE, dependency-free.
 *
 * Split out of src/api/v1/stage7-rbac.js so modules that must not pull in the
 * v1 router (which imports brandAccess, which would then create an import cycle)
 * can still ask the same question. stage7-rbac.js re-exports everything here,
 * so every existing import path keeps working unchanged.
 *
 * Roles come from the authenticated session and are resolved from the `roles`
 * table. Platform Super Admin has platform-level access, which is a SEPARATE
 * security boundary: it deliberately carries NO tenant-level conversation
 * abilities, so platform privileges never imply the right to send messages on
 * behalf of a company.
 *
 * The UI hides buttons; this map is the authority. An unrecognised role name is
 * NOT in this map, so it matches nothing and is denied every ability — the
 * fail-closed default.
 */

/**
 * The single ability that grants TENANT-WIDE brand scope.
 *
 * This is the explicit policy that answers "may this caller see every brand?",
 * instead of inferring it from an absent grant. It matches the existing,
 * already-approved behaviour of GET /brands, which is guarded by
 * requireAbility('brand.read') — Company Admin, Supervisor and Agent all hold it.
 */
export const TENANT_WIDE_BRAND_ABILITY = 'brand.read';

export const ROLE_ABILITIES = {
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

/** Can these roles do this? Unknown roles match nothing. */
export function can(roles = [], ability) {
  if (!Array.isArray(roles)) return false;
  return roles.some((r) => {
    const abilities = ROLE_ABILITIES[r];
    if (!abilities) return false;
    return abilities.includes('*')
      || abilities.includes(ability)
      || abilities.some((a) => a.endsWith('*') && ability.startsWith(a.slice(0, -1)));
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

/** Does this user hold a handling role at all? */
export function hasHandlingRole(roles = []) {
  return ['Company Admin', 'Supervisor', 'Agent'].some((r) => roles.includes(r));
}

/**
 * Is this caller authorised for TENANT-WIDE brand visibility?
 *
 * Derived from an explicit ability, never from the absence of a grant.
 * Platform Super Admin deliberately returns false: platform privileges must not
 * imply tenant-wide access to a company's brands or conversations.
 */
export function hasTenantWideBrandScope(roles = []) {
  return can(roles, TENANT_WIDE_BRAND_ABILITY);
}