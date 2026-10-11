/**
 * Stage 6 Batch 2 — migration 008: shadow reply-source references (ADDITIVE).
 *
 * Stores REFERENCES only (intent, index version, chunk ids + scores) — never a
 * copy of the business facts, so a later knowledge change never leaves stale
 * duplicated content behind. Batch 3 surfaces these to the admin in the Inbox.
 */

CREATE TABLE IF NOT EXISTS knowledge_reply_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  source_id uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  intent text NOT NULL,
  retrieval text NOT NULL,                    -- structured | vector | hybrid | none
  index_version_id uuid REFERENCES knowledge_index_versions(id) ON DELETE SET NULL,
  confidence numeric,
  chunk_refs jsonb NOT NULL DEFAULT '[]',     -- [{id, section, entityKey, score}]
  fact_refs jsonb NOT NULL DEFAULT '[]',      -- [{type, source}]
  fallback_used boolean NOT NULL DEFAULT false,
  fallback_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reply_sources_message ON knowledge_reply_sources(message_id);
CREATE INDEX IF NOT EXISTS idx_reply_sources_tenant ON knowledge_reply_sources(tenant_id, created_at DESC);
