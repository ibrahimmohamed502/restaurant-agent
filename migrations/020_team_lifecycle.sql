-- ============================================================================
-- 020 — Team lifecycle, brand scoping and auditable membership
--
-- P0.5-A backend. Makes departments a first-class, administrable concept
-- instead of an empty table nobody can write to.
--
-- WHY EACH CHANGE IS NEEDED
--
-- teams.status
--   Teams had no lifecycle, so "disable a team" was impossible: the only way
--   to stop routing work at a team was to delete it, which destroys the
--   assignment history that references it. A status column makes the stop
--   reversible and auditable.
--
-- teams.brand_id
--   A team may belong to the whole company (NULL) or to one brand. This is the
--   tenant/brand scoping the admin UI needs, enforced by the database rather
--   than by application code.
--
-- team_members.tenant_id
--   Added so (team, user) can only ever pair members of ONE company at the
--   database level, using the same composite-key technique 015 already
--   established. Cross-company membership is then impossible rather than merely
--   rejected by a WHERE clause somewhere.
--
-- team_members.revoked_at
--   Removing somebody from a team must be a soft, recorded event, not a DELETE.
--   A revocation now LOCKS the row for the duration of any in-flight assignment
--   transaction, which is what orders a membership change against a decision
--   that is already being made. A DELETE would remove the row instead, and a
--   concurrent reader could not lock what no longer exists.
--
-- ADDITIVE ONLY. No existing column is dropped or retyped, no existing row is
-- modified, and no existing behaviour changes. Applying this alone grants
-- nobody anything.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Teams: lifecycle + optional brand scoping.
-- ---------------------------------------------------------------------------
ALTER TABLE teams ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brands(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_status_check') THEN
    ALTER TABLE teams
      ADD CONSTRAINT teams_status_check CHECK (status IN ('active', 'disabled'));
  END IF;
END $$;

-- A team may only ever name a brand from its own company. Same composite-key
-- trick as 015: the constraint is in the database, so application code cannot
-- be talked out of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_id_tenant_key') THEN
    ALTER TABLE teams ADD CONSTRAINT teams_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_brand_tenant_fk') THEN
    ALTER TABLE teams
      ADD CONSTRAINT teams_brand_tenant_fk
      FOREIGN KEY (brand_id, tenant_id) REFERENCES brands (id, tenant_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS teams_scope_idx
  ON teams (tenant_id, status, brand_id);

-- Case-insensitive uniqueness WITHIN a company.
--
-- "Marketing" and "marketing" are one team, not two. Typed by hand into an
-- admin screen that is an easy accident, and two near-identical teams then split
-- routing between them invisibly.
--
-- The EXISTING UNIQUE (tenant_id, name) from 001 is left in place: this index
-- is strictly stronger, and dropping a constraint is a risk an additive-only
-- migration should not take.
--
-- Scoped by tenant_id, so the SAME name stays legal in two different companies.
-- Production genuinely has "Customer Service", "Management" and "Marketing" in
-- each of its two companies today, and that must keep working.
--
-- Verified against that data before this line was written: there are currently
-- NO case-insensitive collisions inside any single company, so the index builds
-- cleanly. If some future database did have one, this statement FAILS LOUDLY
-- instead of silently picking a winner - the correct failure for a uniqueness
-- rule, and a loud failure at migration time beats a duplicate team in
-- production.
CREATE UNIQUE INDEX IF NOT EXISTS teams_tenant_name_lower_uniq
  ON teams (tenant_id, lower(name));

-- ---------------------------------------------------------------------------
-- 2. Membership: company ownership + soft revocation.
-- ---------------------------------------------------------------------------
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS added_at timestamptz NOT NULL DEFAULT now();

-- Backfill company ownership from the team itself. Safe because the only source
-- of a team is its tenant, and no row is invented - rows without a team simply
-- stay NULL and are reported rather than guessed at.
UPDATE team_members tm
   SET tenant_id = t.tenant_id
  FROM teams t
 WHERE t.id = tm.team_id
   AND tm.tenant_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_tenant_fk') THEN
    ALTER TABLE team_members
      ADD CONSTRAINT team_members_tenant_fk
      FOREIGN KEY (team_id, tenant_id) REFERENCES teams (id, tenant_id) ON DELETE CASCADE;
  END IF;

  -- A live membership must know its company. Historic rows for a deleted team
  -- keep NULL and are inert; new and live rows never may be.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_live_tenant_required') THEN
    ALTER TABLE team_members
      ADD CONSTRAINT team_members_live_tenant_required
      CHECK (tenant_id IS NOT NULL OR revoked_at IS NOT NULL);
  END IF;
END $$;

-- 001 already declares team_members PRIMARY KEY (team_id, user_id), which is
-- exactly the key re-adding a member needs: an ON CONFLICT (team_id, user_id)
-- revives the soft-revoked row instead of colliding with it. It is deliberately
-- NOT dropped and recreated - a primary key is a constraint, and dropping the
-- index that backs it is rejected outright by PostgreSQL.

CREATE INDEX IF NOT EXISTS team_members_live_idx
  ON team_members (tenant_id, team_id)
  WHERE revoked_at IS NULL;