-- ============================================================================
-- Stage 4.3A — Meta routing channel uniqueness (partial unique index)
-- ----------------------------------------------------------------------------
-- INVARIANT:
--   A Meta Page ID may have only one provider='meta' routing record across
--   all tenants at a time. Ownership transfer must be performed through a
--   controlled future workflow.
--
-- This partial unique index enforces that invariant at the database layer
-- (defense in depth for multi-tenant isolation):
--   - Scope: rows WHERE provider = 'meta' only (regardless of status).
--   - Guarantee: one Meta routing record per Meta Page ID, across ALL tenants.
--   - Prevents the same Meta Page from being routed to two tenants/brands.
--
-- Does NOT affect conversation channels (meta_comment / meta_dm) or any other
-- provider. Idempotent (IF NOT EXISTS). No data modification.
--
-- Rollback:  DROP INDEX IF EXISTS channels_meta_external_uidx;
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS channels_meta_external_uidx
  ON channels(external_id)
  WHERE provider = 'meta';
