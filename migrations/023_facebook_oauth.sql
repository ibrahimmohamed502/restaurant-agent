-- B1 — Facebook Page Self-Service OAuth.
--
-- Additive and forward-only. No DROP, no DELETE, no data mutation, no rewrite of
-- existing rows. Every A1 and P0.5 object is left exactly as it is.
--
-- What this adds:
--   1. oauth_states          - single-use, expiring OAuth state rows. The raw
--                              state token is NEVER stored; only its SHA-256.
--   2. channels.oauth_provider / oauth_connected_at / oauth_scopes
--                            - records HOW a channel was connected. Nullable, so
--                              every pre-B1 channel keeps working untouched.
--   3. A partial unique index that stops the same Facebook Page being owned by
--                              two DIFFERENT tenants at the same time. The
--                              pre-existing channels_meta_external_uidx already
--                              blocks duplicates globally; this index is the
--                              tenant-aware, brand-scoped guard used by the
--                              connect path, and it deliberately allows a page to
--                              be re-pointed inside the SAME tenant (reconnect /
--                              brand re-assignment) via WHERE ... IS DISTINCT FROM.
--
-- Why the raw state is hashed:
--   The state parameter is a bearer token for "this user asked to connect".
--   If the table were readable, a leaked row would be a live CSRF token. Storing
--   only SHA-256(state) means a database read cannot be replayed. Lookup is
--   constant work in the same index.
--
-- Rollback:
--   These objects are additive. Rolling back the CODE does not require dropping
--   them. If they must be removed:
--     DROP INDEX channels_meta_tenant_owner_uidx;   -- optional
--     DROP TABLE oauth_states;                      -- optional
--     ALTER TABLE channels DROP COLUMN oauth_provider,
--                                  DROP COLUMN oauth_connected_at,
--                                  DROP COLUMN oauth_scopes;
--   No existing channel row is modified by any of the above, so rolling the
--   schema back cannot orphan, disable or reassign an integration.
--
-- Idempotency: every statement is guarded, so this migration is re-runnable.

-- ---------------------------------------------------------------------------
-- 1. oauth_states
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id       uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  session_id          uuid,
  provider            text   NOT NULL,

  -- WHICH brand the user picked BEFORE authorizing. Bound here so the callback
  -- can never be redirected to a brand the initiator did not choose.
  brand_id            uuid REFERENCES brands(id) ON DELETE SET NULL,

  -- Only the SHA-256 of the state token. The plaintext exists once, in the
  -- redirect URL, and is never persisted.
  state_hash          bytea  NOT NULL,

  -- PKCE (S256). Nullable because PKCE support depends on the chosen Meta login
  -- configuration; when unused the column is NULL rather than a fake value.
  code_verifier_hash  bytea,

  -- Redirect URI actually used, so the callback can prove it is completing the
  -- request it started and not one an attacker injected.
  redirect_uri        text   NOT NULL,

  -- Short-lived User Access Token from the code exchange, encrypted with the
  -- same AES-256-GCM key as provider_credentials.
  --
  -- WHY THIS EXISTS: after the callback exchanges the code, the browser needs
  -- to choose a page and confirm. The user token required that choice must reach
  -- the next step, but it must never travel in a URL (browser history, referrer,
  -- proxy logs) or in the frontend bundle. So it is parked here, encrypted, and
  -- released only to an authenticated same-tenant caller of the confirm step.
  --
  -- Cleared the moment the connection is confirmed; a state that is never
  -- confirmed is swept by expires_at.
  user_token_encrypted bytea,
  user_token_iv        bytea,

  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT oauth_states_provider_check CHECK (provider IN ('meta')),
  CONSTRAINT oauth_states_hash_len_check      CHECK (octet_length(state_hash) = 32)
);

-- The lookup is always "given a presented state, find the row". One index, one
-- hit. Partial on unconsumed keeps it small as old rows age out.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_hash_uidx
  ON oauth_states (state_hash)
  WHERE consumed_at IS NULL;

-- Housekeeping: a sweeper deletes expired rows. Without this the table grows
-- with every abandoned connect attempt.
CREATE INDEX IF NOT EXISTS oauth_states_expires_idx
  ON oauth_states (expires_at);

-- A user may only have one OAuth attempt in flight per provider at a time.
-- This makes a double-click idempotent instead of creating a second state, and it
-- blocks a second tab from silently racing the first.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_inflight_uidx
  ON oauth_states (tenant_id, actor_user_id, provider)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. channels: record how the channel was connected
-- ---------------------------------------------------------------------------
ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_provider     text;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_connected_at timestamptz;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_scopes        jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_oauth_provider_check'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_oauth_provider_check
      CHECK (oauth_provider IS NULL OR oauth_provider = 'meta');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Duplicate-ownership guard (tenant-aware)
-- ---------------------------------------------------------------------------
-- A Facebook Page id may exist on at most ONE channel per owning tenant.
-- Re-pointing the SAME page inside the SAME tenant (reconnect, or moving it to a
-- different brand of the same company) is allowed, which is why this is
-- distinct from the global channels_meta_external_uidx.
CREATE UNIQUE INDEX IF NOT EXISTS channels_meta_tenant_owner_uidx
  ON channels (tenant_id, provider, external_id)
  WHERE provider IN ('meta', 'meta_dm', 'meta_comment')
    AND external_id IS NOT NULL
    AND tenant_id IS NOT NULL;

-- Connection status lookup for the UI (connected / needs reconnect).
CREATE INDEX IF NOT EXISTS channels_oauth_status_idx
  ON channels (tenant_id, oauth_provider)
  WHERE oauth_provider IS NOT NULL;