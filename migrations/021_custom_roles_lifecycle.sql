-- A1: Custom Roles lifecycle.
--
-- Additive only. No DROP, no DELETE, no TRUNCATE, no ALTER COLUMN, no
-- destruction of existing rows. Every existing role and every existing
-- assignment survives with its permissions untouched.
--
-- What this adds:
--   roles.status          - active/disabled, so a role can be turned off without
--                           losing its definition or its audit history.
--   roles.created_by      - who created it (nullable; seed rows have none).
--   roles.updated_at      - last edit timestamp.
--   user_roles PRIMARY KEY (user_id, role_id) - prevents duplicate assignment.
--   user_roles FK -> roles(id) ON DELETE RESTRICT - a role with holders cannot
--                           be hard-deleted; it must be disabled first.
--   user_roles FK -> users(id) ON DELETE CASCADE - a deleted user's rows go with
--                           them, which is the only safe direction.
--
-- What this does NOT add, deliberately:
--   - No tenant_id on user_roles. Scope is enforced by the role lookup in the
--     service layer (role.tenant_id = session.tenantId), matching the pattern
--     already used by teamAccess.js. Adding it would be cleaner but is a larger
--     change and is not required for correctness.
--   - No hard delete. Roles are soft-disabled so audit history survives.
--
-- Idempotency: every statement uses IF NOT EXISTS or a DO block, so this
-- migration can be applied twice without error. Verified by
-- scripts/test-migration-021-safety.mjs.
--
-- Rollback: all changes are additive. Rolling back the CODE does not undo them,
-- but old code ignores the new columns (status defaults to 'active', created_by
-- and updated_at are nullable). The PK/FK constraints are the only part that
-- could bite: if old code inserts duplicate user_roles rows, the PK rejects
-- them. That is the correct behaviour and is not a regression.

-- 1. roles.status
ALTER TABLE roles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_status_check') THEN
    ALTER TABLE roles
      ADD CONSTRAINT roles_status_check CHECK (status IN ('active', 'disabled'));
  END IF;
END $$;

-- 2. roles.created_by
ALTER TABLE roles ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- 3. roles.updated_at
ALTER TABLE roles ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 4. user_roles PRIMARY KEY (user_id, role_id)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_pkey') THEN
    ALTER TABLE user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);
  END IF;
END $$;

-- 5. user_roles FK to roles (ON DELETE RESTRICT: a role with holders cannot be
--    hard-deleted; it must be disabled first, preserving audit history)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_role_id_fkey') THEN
    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_role_id_fkey
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 6. user_roles FK to users (ON DELETE CASCADE: a deleted user's role rows go
--    with them, which is the only safe direction)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_user_id_fkey') THEN
    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 7. index on role_id for the FK (PostgreSQL does not auto-index FK columns)
CREATE INDEX IF NOT EXISTS user_roles_role_id_idx ON user_roles (role_id);

-- 8. index on roles (tenant_id, status) for the list query
CREATE INDEX IF NOT EXISTS roles_tenant_status_idx ON roles (tenant_id, status);
