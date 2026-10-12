-- Stage 5 — Knowledge Base drafts, versions and publication history (additive).
--
-- Existing knowledge_documents rows keep working: the new `status` column
-- defaults to 'published' for them, and `version` already exists.
-- Publish never mutates a published row: it archives the current one and
-- inserts a new published version, so the previous version stays recoverable.

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'archived'));

CREATE INDEX IF NOT EXISTS idx_documents_status
  ON knowledge_documents (source_id, status, version DESC);

-- One working draft per (tenant, source). content is the full structured JSON.
CREATE TABLE IF NOT EXISTS knowledge_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  base_version int NOT NULL DEFAULT 1,
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'published', 'discarded')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_drafts_tenant ON knowledge_drafts(tenant_id);

-- Immutable publication history (who published what, when, from which draft).
CREATE TABLE IF NOT EXISTS knowledge_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  document_id uuid REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  version int NOT NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_publications_source ON knowledge_publications(source_id, created_at DESC);
