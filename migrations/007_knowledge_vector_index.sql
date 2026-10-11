-- =============================================================================
-- Stage 6 Batch 1 — Knowledge vector indexing (ADDITIVE ONLY)
--
-- 1) knowledge_index_versions: lifecycle state for semantic indexing.
--    A candidate is NEVER active until ALL chunks are embedded + verified.
--    On failure the candidate is marked failed and its chunks are removed —
--    the previous active version stays untouched (no partial vectors served).
-- 2) HNSW index over embedded chunks (partial: NULL embeddings are skipped).
--    Existing rows/business knowledge are NOT modified.
-- =============================================================================

CREATE TABLE IF NOT EXISTS knowledge_index_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version int NOT NULL,
  status text NOT NULL DEFAULT 'indexing'
    CHECK (status IN ('indexing', 'ready', 'active', 'failed')),
  chunk_count int NOT NULL DEFAULT 0,
  embedded_count int NOT NULL DEFAULT 0,
  embedding_model text,
  embedding_dims int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  activated_at timestamptz
);

-- One candidate per document version (a failed attempt may be retried).
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_index_versions_doc
  ON knowledge_index_versions (document_id, version) WHERE status <> 'failed';
CREATE INDEX IF NOT EXISTS idx_knowledge_index_versions_tenant
  ON knowledge_index_versions (tenant_id, brand_id, status);

-- HNSW (cosine) over EMBEDDED chunks only. Partial so NULL-embedding rows
-- (legacy seed data) never break the build and are never served.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_knowledge_chunks_embedding_hnsw'
  ) THEN
    CREATE INDEX idx_knowledge_chunks_embedding_hnsw
      ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL;
  END IF;
END$$;
