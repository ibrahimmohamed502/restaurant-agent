-- ============================================================================
-- Stage 8 Batch 1 — Backfill Knowledge Base source for companies created
-- before the company-creation transaction initialized one.
--
-- TARGETED + IDEMPOTENT: only inserts a knowledge_sources row for tenants that
-- have NONE. Tenants that already have a source (e.g. United Food Company)
-- are completely untouched — no documents, chunks, or published content are
-- modified or duplicated.
--
-- Safe to re-run: the NOT EXISTS guard makes it a no-op after the first run.
-- ============================================================================

INSERT INTO knowledge_sources (tenant_id, brand_id, kind, title)
SELECT b.tenant_id,
       b.id,
       'menu',
       t.name || ' — main menu & info'
  FROM brands b
  JOIN tenants t ON t.id = b.tenant_id
 WHERE NOT EXISTS (
         SELECT 1 FROM knowledge_sources ks WHERE ks.tenant_id = b.tenant_id
       )
 ORDER BY b.created_at ASC
 ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Verification (informational): every tenant should now have >= 1 source,
-- and tenants that already had a source keep exactly the same count.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  missing int;
  total   int;
BEGIN
  SELECT count(*) INTO total FROM tenants;
  SELECT count(*) INTO missing
    FROM tenants t
   WHERE NOT EXISTS (SELECT 1 FROM knowledge_sources ks WHERE ks.tenant_id = t.id);

  IF missing = 0 THEN
    RAISE NOTICE 'SUCCESS: all % tenant(s) now have a Knowledge Base source', total;
  ELSE
    RAISE WARNING '% of % tenant(s) still missing a Knowledge Base source', missing, total;
  END IF;
END $$;
