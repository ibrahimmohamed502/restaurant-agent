-- ============================================================================
-- Stage 8 Batch 3 — Facebook Page self-service OAuth (ADDITIVE ONLY)
-- ----------------------------------------------------------------------------
-- PURPOSE
--   Support tenant/brand-scoped Facebook Page self-service onboarding and the
--   truthful connection status that goes with it.
--
-- SAFETY / DATA PRESERVATION
--   * Additive only: new columns (all with defaults) + two new tables.
--   * NO existing row is deleted, re-keyed or re-owned.
--   * Existing channels/credentials keep working unchanged: inbound routing
--     depends only on channels(provider, external_id, tenant_id, brand_id,
--     status) + provider_credentials, none of which are altered here.
--   * Legacy rows keep subscription_state='unknown' so the UI never claims a
--     CLI-provisioned page is "connected" without verification.
--   * provider_credentials.expires_at is deliberately NOT populated: a Meta
--     PAGE access token has no documented expiry. Page expiry stays NULL.
--     User-token expiry lives on the short-lived OAuth flow only.
--
-- ROLLBACK (code-only rollback needs no schema change: these columns are
-- descriptive and the new tables are unused by the previous code).
--   DROP TABLE oauth_connect_pages; DROP TABLE oauth_connect_flows;
--   DROP TABLE oauth_connect_states;
--   ALTER TABLE channels DROP COLUMN subscription_state,
--                            DROP COLUMN subscription_error,
--                            DROP COLUMN verified_at,
--                            DROP COLUMN meta_scopes;
--   Any destructive schema rollback requires separate owner approval.
-- ============================================================================

-- ------------------------------- connection state ---------------------------
ALTER TABLE channels ADD COLUMN IF NOT EXISTS subscription_state text NOT NULL DEFAULT 'unknown';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS subscription_error  text;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS verified_at        timestamptz;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS meta_scopes        text[];

-- --------------------------- short-lived OAuth flow -----------------------
-- oauth_connect_states: one row per Meta consent round-trip.
--   nonce_hash = sha256(nonce); the raw nonce never touches the database.
--   Consumed with a single atomic UPDATE that is ALSO session-bound
--   (tenant_id + user_id in the WHERE clause).
CREATE TABLE IF NOT EXISTS oauth_connect_states (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash  text NOT NULL UNIQUE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  brand_id    uuid REFERENCES brands(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry   ON oauth_connect_states (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_session  ON oauth_connect_states (tenant_id, user_id);

-- oauth_connect_flows: SEPARATE, short-lived server-side authorization for the
-- page picker + final connect step (independent of the Meta OAuth state).
--   token_hash = sha256(flow token); the raw token is only ever returned once,
--   to the browser, and lives in the URL fragment so it is not sent in referrers.
CREATE TABLE IF NOT EXISTS oauth_connect_flows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id              uuid NOT NULL REFERENCES oauth_connect_states(id) ON DELETE CASCADE,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,
  brand_id              uuid REFERENCES brands(id) ON DELETE CASCADE,
  token_hash            text NOT NULL,
  user_token_expires_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  last_used_at          timestamptz,
  consumed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_token  ON oauth_connect_flows (token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_expiry ON oauth_connect_flows (expires_at);

-- oauth_connect_pages: server-held page tokens for the active flow.
--   Page access tokens are encrypted with the same AES-256-GCM helper as
--   provider_credentials and are NEVER returned to the browser.
CREATE TABLE IF NOT EXISTS oauth_connect_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id         uuid NOT NULL REFERENCES oauth_connect_flows(id) ON DELETE CASCADE,
  page_id         text NOT NULL,
  page_name       text,
  page_tasks      text[],
  page_category   text,
  token_encrypted bytea NOT NULL,
  iv              bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_pages_flow ON oauth_connect_pages (flow_id);