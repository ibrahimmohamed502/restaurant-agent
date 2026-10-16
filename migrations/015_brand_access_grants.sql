-- ============================================================================
-- R1 — Brand Access Security
--
-- Per-USER brand grants. Roles decide ABILITIES; grants decide which BRANDS a
-- user may reach. These two are independent: a role never implies a brand, and
-- a missing grant never implies tenant-wide access.
--
-- Numbering: 014 is already taken by Batch 3 (`014_meta_page_selfservice.sql`,
-- an unreleased branch). 015 is used here so the two can coexist and apply in
-- sorted order on both an existing and a freshly built database.
--
-- Additive only: creates new tables, adds composite unique keys used as
-- foreign-key targets, and backfills Company Admin scope. No existing table is
-- dropped, truncated or rewritten, and no existing row is modified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Composite unique keys so a (child, tenant) pair can be constrained.
--    These make it impossible, at the database level, to reference a user from
--    one company together with a brand from another.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_id_tenant_key') THEN
    ALTER TABLE users   ADD CONSTRAINT users_id_tenant_key   UNIQUE (id, tenant_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brands_id_tenant_key') THEN
    ALTER TABLE brands  ADD CONSTRAINT brands_id_tenant_key  UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Per-brand grants.
--
--    tenant_id is stored explicitly (not derived) so BOTH foreign keys can be
--    composite. That is what enforces company consistency: a row cannot pair a
--    user from company A with a brand from company B, even if application code
--    is bypassed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_brand_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  brand_id    uuid NOT NULL,
  granted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text,
  CONSTRAINT user_brand_grants_user_tenant_fk
    FOREIGN KEY (user_id,  tenant_id) REFERENCES users (id,  tenant_id) ON DELETE CASCADE,
  CONSTRAINT user_brand_grants_brand_tenant_fk
    FOREIGN KEY (brand_id, tenant_id) REFERENCES brands (id, tenant_id) ON DELETE CASCADE,
  -- A grant is either live or revoked, never both.
  CONSTRAINT user_brand_grants_revocation_ck
    CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR revoked_at IS NOT NULL)
);

-- One LIVE grant per (user, brand). Revoked rows are kept as history and are
-- deliberately NOT reused: because the uniqueness constraint is partial
-- (WHERE revoked_at IS NULL), re-granting after a revoke inserts a NEW live row
-- and leaves the revoked one in place. The table is therefore append-and-stamp:
-- grant history is a complete chronological trail, never overwritten.
CREATE UNIQUE INDEX IF NOT EXISTS user_brand_grants_active_uniq
  ON user_brand_grants (user_id, brand_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_brand_grants_lookup_idx
  ON user_brand_grants (tenant_id, user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Explicit "all brands within my company" delegation.
--
--    Deliberately keyed by (user_id, tenant_id), NOT tenant_id alone: the
--    earlier brand_scope_all(tenant_id) proposal would have made one row grant
--    every user in a company the same scope, which is not delegation at all.
--    This row NEVER confers platform-level or cross-company access.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_brand_scope_all (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  granted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text,
  CONSTRAINT user_brand_scope_all_user_tenant_fk
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT user_brand_scope_all_revocation_ck
    CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_brand_scope_all_active_uniq
  ON user_brand_scope_all (user_id, tenant_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. NEW BRANDS — behaviour, stated explicitly.
--
--    A brand created later is NOT auto-granted to per-brand grantees: it stays
--    invisible to them until an admin grants it (fail-closed, by omission).
--    Users holding an all-brands-within-company row DO see it automatically,
--    because that delegation is defined over the company, not a fixed list.
--    There is deliberately no trigger here: implicit grants are how scope
--    silently widens, so new brands require an explicit, audited grant.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Narrowly scoped backfill — behaviour preserving.
--
--    Only users whose EFFECTIVE roles include 'Company Admin' receive an
--    all-brands row. Today `brand.read` grants tenant-wide to Company Admin,
--    Supervisor and Agent alike; the Supervisor/Agent population is left
--    WITHOUT any row on purpose. That is the safe direction: an ungranted user
--    sees zero brands, never every brand.
--
--    The statement is idempotent and skips users who already have a live row.
-- ---------------------------------------------------------------------------
INSERT INTO user_brand_scope_all (tenant_id, user_id, granted_by, reason)
SELECT u.tenant_id, u.id, NULL,
       'backfill:preserves pre-R1 Company Admin company-wide brand access'
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r       ON r.id = ur.role_id
 WHERE r.name = 'Company Admin'
   AND u.tenant_id = r.tenant_id
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Comments documenting the invariants.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE user_brand_grants IS
  'Per-user brand grants. Absence of a row means NO access to that brand. Roles grant abilities only and never imply brand scope.';
COMMENT ON TABLE user_brand_scope_all IS
  'Explicit per-user delegation of every brand inside one company. Never platform-wide, never cross-company.';
COMMENT ON COLUMN user_brand_grants.revoked_at IS
  'Set on revoke; the row is retained as grant history and can be revived by re-granting.';