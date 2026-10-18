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



/**
 * P0.3 — `escalation.resolve`, deliberately held by NO built-in role.
 *
 * Closing a conversation and DISCHARGING A CUSTOMER COMPLAINT are different acts
 * with different consequences, so they are separated into two abilities:
 *
 *   conversation.resolve -> may close a conversation
 *   escalation.resolve   -> may close one escalation (a recorded complaint)
 *
 * `conversation.resolve` is NOT sufficient to close an escalation, and
 * `escalation.resolve` is NOT sufficient to close a conversation. Splitting them
 * means discharging a complaint can be restricted independently of resolving a
 * thread, without changing who may resolve conversations.
 *
 * WHY IT IS IN NO BUILT-IN ROLE. Adding it to Supervisor or Company Admin here
 * would hand it to every one of them retroactively and silently — exactly the
 * automatic widening this split exists to prevent. Instead the ability is carried
 * by a CUSTOM role named in ESCALATION_MANAGER_ROLE, seeded per tenant by
 * migration 017 with ZERO holders, and assigned by the Platform Owner deliberately.
 *
 * THE TRAP THAT MAKES THE CUSTOM ROLE MANDATORY. `effectiveCustomAbilities()`
 * SKIPS every name in BUILT_IN_ROLES, so a role row called 'Supervisor' has its
 * `permissions` column ignored entirely — the hardcoded map above is the only
 * source of truth. Writing `escalation.resolve` into the Supervisor role's JSONB
 * would therefore do NOTHING at all while appearing to have worked. A role whose
 * name is NOT in BUILT_IN_ROLES honours its stored permissions, which is why
 * ESCALATION_MANAGER_ROLE must never collide with a built-in name.
 *
 * A holder still needs brand scope: the ability decides WHAT may be done, the R1
 * grant tables decide WHICH CONVERSATIONS they may see. Neither confers the other.
 */
export const ESCALATION_RESOLVE_ABILITY = 'escalation.resolve';

/**
 * The custom role that carries ESCALATION_RESOLVE_ABILITY.
 *
 * Must NOT be added to BUILT_IN_ROLES: a built-in name has its stored permissions
 * ignored and the ability would silently never apply.
 */
export const ESCALATION_MANAGER_ROLE = 'Escalation Manager';

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
    // P0.5-A: team administration. None of these confers any user or brand
    // ability, so holding them can never widen what somebody ELSE may be
    // granted: a team manager can organise people, not promote them. Granting
    // roles and brand access stay behind user.update / brand.grant, which are
    // separate abilities on this same role.
    'team.read', 'team.create', 'team.update', 'team.disable', 'team.assign',
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
    'brand.integration.status', 'user.read', 'user.update',
    // P0.5-A: Supervisors may SEE the org chart, but not reshape it. Read-only
    // is the useful half (routing visibility) without granting anyone the
    // ability to restructure who reports where.
    'team.read'
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

/**
 * DISPLAY / ROLE-CHECK ONLY - NOT AN AUTHORISATION SOURCE.
 *
 * This helper answers "does the session's role LIST name Platform Super Admin".
 * It must never decide whether a caller may act at platform level, because the
 * role list is assembled from the tenant-local `roles` + `user_roles` tables and
 * can therefore be influenced by a tenant administrator.
 *
 * Authoritative platform membership lives in the `platform_super_admins` table and
 * is surfaced on the session as `req.v1.isPlatformSuperAdmin` by
 * src/auth/sessions.js. Use that, via requirePlatformSuperAdmin().
 */
export function isPlatformSuperAdmin(roles = []) {
  return roles.includes('Platform Super Admin');
}

/**
 * Roles a tenant administrator may never hand out.
 *
 * Platform Super Admin is administered at platform level, not through a tenant's
 * user management, so it is never delegable by Company Admin, Supervisor, Agent
 * or a custom role. The role row itself is left in place: existing rows and
 * existing sessions are untouched by this rule.
 */
export const NON_DELEGABLE_ROLE_NAMES = Object.freeze(['Platform Super Admin']);

/** The abilities a built-in role confers (empty for an unknown/custom name). */
export function abilitiesForRole(roleName) {
  return ROLE_ABILITIES[roleName] ?? [];
}

/**
 * Delegation ceiling: may `actorRoles` grant `targetRoleName` to a tenant user?
 *
 * Two independent conditions, both mandatory:
 *
 *   1. The role name is not platform-administrative (NON_DELEGABLE_ROLE_NAMES).
 *   2. EVERY ability the target role confers is one the actor already holds.
 *      This covers built-in roles (map) and custom roles (their stored
 *      `permissions`), and it blocks a custom role that smuggles in `platform.*`.
 *
 * Fail-closed: an unknown role name with no stored permissions resolves to zero
 * abilities, which is NOT a subset of anything, so it cannot be granted.
 */
export function canDelegateRole({
  actorRoles = [],
  actorCustomAbilities = [],
  targetRoleName,
  targetPermissions = null
} = {}) {
  if (!targetRoleName || typeof targetRoleName !== 'string') return false;
  if (NON_DELEGABLE_ROLE_NAMES.includes(targetRoleName)) return false;

  const stored = Array.isArray(targetPermissions) ? targetPermissions : null;
  const targetAbilities = stored && stored.length > 0
    ? stored
    : abilitiesForRole(targetRoleName);

  // Unknown role and no usable permissions -> fail closed.
  if (!Array.isArray(targetAbilities) || targetAbilities.length === 0) return false;

  return targetAbilities.every((a) => can(actorRoles, a, actorCustomAbilities));
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