-- ============================================================================
-- 019 — AI-driven intelligent routing rules
--
-- Lets an owner declare, per company and optionally per brand, WHICH team should
-- pick up an automatically-detected situation (supplier inquiry, photography
-- request, complaint, explicit human request, ...).
--
-- THIS MIGRATION CREATES DATA ONLY. It does not route anything, does not change
-- any conversation state, and does not grant anybody access to anything.
-- Assignment behaviour lives behind the AI_ROUTING_MODE feature flag, which
-- defaults to OFF, so applying this migration alone changes no behaviour.
--
-- Additive only: one new table plus its indexes. No existing table is dropped,
-- altered, truncated or rewritten, and no existing row is modified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The rules table.
--
-- brand_id NULL  = the rule applies to every brand in the company.
-- brand_id SET   = the rule applies to that one brand and wins over a
--                   company-wide rule of the same priority (see the resolver).
--
-- detection_kind / detection_value form the rule's MATCH KEY. They are plain
-- text rather than an enum so a new situation needs no schema change and so the
-- engine stays provider-neutral: nothing here mentions Meta, Messenger or
-- comments.
--
-- target_team_id is the ONLY thing this table authorises. It never names a
-- person; choosing the individual is resolved at evaluation time against the
-- team's live membership and effective brand access, so revoking somebody's
-- grant immediately removes them from routing without editing any rule.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_routing_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id        uuid REFERENCES brands(id) ON DELETE CASCADE,
  rule_key        text NOT NULL,
  priority        integer NOT NULL DEFAULT 100,
  enabled         boolean NOT NULL DEFAULT true,
  detection_kind  text NOT NULL,
  detection_value text,
  target_team_id  uuid REFERENCES teams(id) ON DELETE CASCADE,
  conditions      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- A rule must name a team, otherwise it can only ever produce the
  -- human-queue fallback and storing it would be misleading.
  CONSTRAINT ai_routing_rules_target_team_required
    CHECK (target_team_id IS NOT NULL),
  -- Empty keys would make two rules indistinguishable at evaluation time.
  CONSTRAINT ai_routing_rules_rule_key_not_blank
    CHECK (length(btrim(rule_key)) > 0),
  CONSTRAINT ai_routing_rules_detection_kind_not_blank
    CHECK (length(btrim(detection_kind)) > 0)
);

-- ---------------------------------------------------------------------------
-- 2. Uniqueness.
--
-- A plain UNIQUE (tenant_id, brand_id, rule_key) does NOT work here: in
-- PostgreSQL NULLs are distinct, so any number of company-wide rules could
-- share one rule_key. Two partial unique indexes give exact semantics instead
-- — one per brand, one for company-wide.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ai_routing_rules_brand_uniq
  ON ai_routing_rules (tenant_id, brand_id, rule_key)
  WHERE brand_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_routing_rules_tenant_wide_uniq
  ON ai_routing_rules (tenant_id, rule_key)
  WHERE brand_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Evaluation order.
--
-- The resolver reads only this index: enabled rules for one company and brand,
-- ordered by priority then key. Keeping the shape here means the read is an
-- index-only scan and the ordering is reproducible by the database itself.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ai_routing_rules_eval_idx
  ON ai_routing_rules (tenant_id, enabled, priority DESC, rule_key);

-- ---------------------------------------------------------------------------
-- 4. Tenant/brand consistency.
--
-- The same composite keys 015 added to users and brands let the database, not
-- application code, forbid pairing a company with a brand from another
-- company. A rule can only ever point at a team inside its own company.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_routing_rules_team_tenant_fk') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_id_tenant_key') THEN
      ALTER TABLE teams ADD CONSTRAINT teams_id_tenant_key UNIQUE (id, tenant_id);
    END IF;

    ALTER TABLE ai_routing_rules
      ADD CONSTRAINT ai_routing_rules_team_tenant_fk
      FOREIGN KEY (target_team_id, tenant_id) REFERENCES teams (id, tenant_id) ON DELETE CASCADE;
  END IF;
END $$;