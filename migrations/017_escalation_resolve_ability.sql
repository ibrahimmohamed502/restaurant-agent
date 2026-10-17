-- ============================================================================
-- P0.3 — separate escalation resolution into its own ability.
--
-- `conversation.resolve` authorises closing a CONVERSATION. Discharging a
-- recorded CUSTOMER COMPLAINT is a different act with different consequences, so
-- it gets its own ability: `escalation.resolve`.
--
-- WHAT THIS MIGRATION DOES, EXACTLY
-- -------------------------------
-- Creates one CUSTOM role per existing tenant, named 'Escalation Manager',
-- carrying ONLY the ability `["escalation.resolve"]`, and grants it to NOBODY.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- -------------------------------
--   * It does NOT add the ability to Supervisor or Company Admin. Doing so would
--     hand it to every one of them retroactively and silently.
--   * It does NOT create any `user_roles` row. Nobody holds this role until the
--     Platform Owner assigns it, deliberately and by name.
--   * It does NOT touch, modify or delete any existing role, user, grant or
--     escalation. It is purely additive.
--   * It does NOT grant brand scope to anybody. `user_brand_grants` /
--     `user_brand_scope_all` are untouched, so a holder still cannot reach a
--     conversation outside its delegated brands.
--
-- WHY A CUSTOM ROLE, AND NOT A BUILT-IN ONE
-- -----------------------------------------
-- `src/auth/abilities.js:effectiveCustomAbilities()` SKIPS every name listed in
-- BUILT_IN_ROLES. For those names the `permissions` column is IGNORED and the
-- hardcoded map is the only source of truth. Writing `escalation.resolve` into the
-- 'Supervisor' role row would therefore do NOTHING at all, while appearing to
-- have worked — the most dangerous kind of silent failure. A role whose name is
-- not a built-in one honours its stored permissions, so 'Escalation Manager'
-- must never collide with a built-in name.
--
-- HOW THE PLATFORM OWNER GRANTS IT
-- ---------------------------------
-- Deliberately out of band, because the delegation ceiling is doing real work
-- here: `canDelegateRole()` requires an actor to hold EVERY ability of the role
-- they grant. Since no built-in role holds `escalation.resolve`, no tenant
-- administrator can hand this out — only the Platform Owner, who administers
-- roles at platform level. That is the intended property: complaint discharge is
-- not something a company can grant itself.
--
-- Example, for the owner to run deliberately and knowingly:
--
--   INSERT INTO user_roles (user_id, role_id)
--   SELECT u.id, r.id
--     FROM users u
--     JOIN roles r ON r.name = 'Escalation Manager' AND r.tenant_id = u.tenant_id
--    WHERE u.id = '<user-id>';
--
-- No migration in this repository performs that INSERT, and this file does not.
--
-- TENANTS CREATED AFTER THIS MIGRATION
-- -------------------------------------
-- The loop above can only seed tenants that EXIST at migration time. A company
-- created afterwards would never receive the role and could never be given
-- complaint-discharge authority at all. `POST /api/v1/platform/companies`
-- (src/api/v1/platform.js) therefore seeds the same role, with zero holders, for
-- every tenant it creates. Do not rely on this migration alone.
--
-- Note `normalizeCustomAbilities()` strips wildcards, `platform.*`,
-- `brand.grant_all` and every other brand-scope ability from custom roles, so this
-- role cannot become an accidental Platform Super Admin or a company-wide grant
-- even if someone edits its JSONB later.
-- ============================================================================

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO roles (tenant_id, name, permissions)
    VALUES (t.id, 'Escalation Manager', '["escalation.resolve"]'::jsonb)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;
END $$;

COMMENT ON TABLE roles IS
  'Tenant-scoped roles. For a name listed in BUILT_IN_ROLES (src/auth/abilities.js) the permissions column is IGNORED and the hardcoded map is authoritative; for any other name the stored permissions apply, normalised by normalizeCustomAbilities(). The ''Escalation Manager'' role is deliberately custom so that its stored escalation.resolve ability is actually honoured, and it is seeded with zero holders.';

COMMENT ON COLUMN roles.permissions IS
  'Effective only for CUSTOM roles. Never confers brand scope: brand access comes exclusively from user_brand_grants / user_brand_scope_all.';