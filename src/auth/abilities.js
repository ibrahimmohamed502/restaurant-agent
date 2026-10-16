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
 * No ability grants TENANT-WIDE brand scope.
 *
 * It previously read 'brand.read', which Company Admin, Supervisor AND Agent all
 * hold - so an absent grant silently became company-wide access. R1 removes that:
 * company-wide visibility is issued only by an audited, per-user
 * "all brands inside my company" delegation row (user_brand_scope_all),
 * resolved per request in sessions.js and surfaced as auth.allBrandsInCompany.
 *
 * The symbol is retained (it matches nothing) so existing call sites keep
 * compiling and any future use of it fails loudly in review rather than
 * silently authorising a whole tenant.
 */
export const TENANT_WIDE_BRAND_ABILITY = '__none__';



export const ROLE_ABILITIES = {
  'Platform Super Admin': [
    'platform.*',
    'company.read', 'company.create', 'company.update', 'company.disable',
    'company.metrics'
  ],
  'Company Admin': [
    'brand.read', 'brand.create', 'brand.update', 'brand.disable',
    'user.read', 'user.create', 'user.update', 'user.disable',
    'brand.grant', 'brand.revoke', 'brand.grant_all', 'brand.revoke_all',
    'brand.integration.connect', 'brand.integration.disconnect',
    'brand.integration.reconnect', 'brand.integration.status',
    'company.read', 'company.update',
    'conversation.read', 'conversation.handoff', 'conversation.assign',
    'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply',
    'note.read', 'note.create', 'note.delete_any', 'notification.read',
    'conversation.assign_self', 'conversation.reply_own', 'conversation.resolve_own',
    'note.delete_own',
    'knowledge.read', 'knowledge.edit', 'knowledge.publish',
    'ai.config.read', 'ai.config.write'
  ],
  Supervisor: [
    'conversation.read', 'conversation.handoff', 'conversation.assign',
    'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply',
    'note.read', 'note.create', 'note.delete_any', 'notification.read',
    'knowledge.read', 'knowledge.edit',
    'ai.config.read',
    'brand.read', 'brand.update',
    'brand.grant', 'brand.revoke',
    'brand.integration.connect',
    'brand.integration.disconnect', 'brand.integration.reconnect',
    'brand.integration.status', 'user.read', 'user.update'
  ],
  Agent: [
    'conversation.read', 'conversation.handoff', 'conversation.assign_self',
    'conversation.reply_own', 'conversation.resolve_own',
    'note.read', 'note.create', 'note.delete_own', 'notification.read',
    'knowledge.read',
    'ai.config.read',
    'brand.read', 'brand.integration.status'
  ]
};

/*
 * Custom roles.
 *
 * Declared AFTER ROLE_ABILITIES because BUILT_IN_ROLES is derived from it: these
 * must evaluate after the map exists, or the temporal dead zone throws at import.
 */

/** Roles whose abilities are defined and reviewed in ROLE_ABILITIES above. */
export const BUILT_IN_ROLES = Object.keys(ROLE_ABILITIES);

/**
 * Abilities a custom role may never obtain from its roles.permissions column.
 *
 * A custom role can widen what a person may DO, but it must never widen WHICH
 * BRANDS they may reach: brand scope is granted exclusively by the per-user
 * grant tables, never by a role, a permission string, or a role name.
 */
const CUSTOM_ROLE_FORBIDDEN_ABILITIES = new Set([
  'brand.grant_all', 'brand.revoke_all', TENANT_WIDE_BRAND_ABILITY, '*', 'platform.*'
]);

/**
 * Normalise a custom role's roles.permissions jsonb into a safe ability list.
 *
 * Fail-closed on every malformed entry: a non-array, or an entry that is not a
 * plain string, contributes nothing rather than throwing. Wildcards are dropped
 * so a custom role can never become an accidental Platform Super Admin, and
 * brand-delegation abilities are stripped (see above).
 */
export function normalizeCustomAbilities(permissions) {
  if (!Array.isArray(permissions)) return [];
  const out = new Set();
  for (const raw of permissions) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim();
    if (!a) continue;
    if (a === '*' || a.endsWith('*')) continue;              // no wildcards
    if (CUSTOM_ROLE_FORBIDDEN_ABILITIES.has(a)) continue;    // never brand-scope
    out.add(a);
  }
  return [...out];
}

/**
 * Can these roles do this? Unknown roles match nothing.
 *
 * customAbilities carries the effective permissions of CUSTOM roles (those
 * whose name is not in BUILT_IN_ROLES), taken from the roles.permissions column
 * and normalised by normalizeCustomAbilities(). It can only add abilities; it
 * can never widen brand scope, which lives exclusively in the grant tables.
 */
export function can(roles = [], ability, customAbilities = []) {
  if (!Array.isArray(roles)) return false;
  const fromBuiltIn = roles.some((r) => {
    const abilities = ROLE_ABILITIES[r];
    if (!abilities) return false;
    return abilities.includes('*')
      || abilities.includes(ability)
      || abilities.some((a) => a.endsWith('*') && ability.startsWith(a.slice(0, -1)));
  });
  if (fromBuiltIn) return true;
  return Array.isArray(customAbilities) && customAbilities.includes(ability);
}

/** The union of effective custom-role abilities for this session. */
export function effectiveCustomAbilities(roles = [], perRolePermissions = {}) {
  if (!Array.isArray(roles)) return [];
  const out = new Set();
  for (const r of roles) {
    if (BUILT_IN_ROLES.includes(r)) continue;   // built-in map is authoritative
    for (const a of normalizeCustomAbilities(perRolePermissions?.[r])) out.add(a);
  }
  return [...out];
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
export function hasTenantWideBrandScope(_roles = []) {
  return false;
}