-- ============================================================================
-- Stage 8 Batch 1 — Backfill Knowledge Base source for the Batch 1 Test Company
-- only (tenant slug 'batch1-test').
--
-- This migration adds a knowledge_sources row ONLY for the tenant with slug
-- 'batch1-test' and its initial brand (slug 'main'), if one does not already
-- exist. All other tenants are completely untouched.
--
-- Idempotent: the NOT EXISTS guard makes it a no-op if the source already exists.
-- ============================================================================

INSERT INTO knowledge_sources (tenant_id, brand_id, kind, title)
SELECT b.tenant_id,
       b.id,
       'menu',
       t.name || ' — main menu & info'
  FROM brands b
  JOIN tenants t ON t.id = b.tenant_id
 WHERE t.slug = 'batch1-test'
   AND b.slug = 'main'
   AND NOT EXISTS (
         SELECT 1 FROM knowledge_sources ks WHERE ks.tenant_id = b.tenant_id
       )
 ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Verification (informational): the Batch 1 Test Company should now have a source.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  missing boolean;
BEGIN
  SELECT NOT EXISTS (
         SELECT 1 FROM knowledge_sources ks
         JOIN brands b ON b.id = ks.brand_id
         JOIN tenants t ON t.id = b.tenant_id
        WHERE t.slug = 'batch1-test' AND b.slug = 'main'
       ) INTO missing;

  IF missing THEN
    RAISE WARNING 'Batch 1 Test Company (batch1-test) still missing a Knowledge Base source';
  ELSE
    RAISE NOTICE 'SUCCESS: Batch 1 Test Company (batch1-test) now has a Knowledge Base source';
  END IF;
END $$;
