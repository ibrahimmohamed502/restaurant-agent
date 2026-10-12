/**
 * Stage 6 Batch 1 — Version-safe knowledge indexing pipeline.
 *
 * Lifecycle (per document version):
 *
 *   Published doc ──▶ candidate(indexing) ──▶ chunks + embeddings ──▶ verify
 *                        │                                            │
 *                        │ any failure                                ▼
 *                        ▼                                       candidate(ready)
 *                   candidate(failed) ◀── on failure ── the PREVIOUS active
 *                   + its chunks deleted                        version is untouched
 *
 * Activation rules (hard):
 *  - a candidate becomes `active` ONLY after ALL its chunks have embeddings
 *  - activating a new version atomically demotes the previous active version
 *  - a failed candidate NEVER serves vectors (its chunks are removed)
 *
 * Tenant + brand + document + version are derived from the DB rows passed in —
 * never from a caller-supplied tenant/brand override.
 */
import { chunkKnowledge } from './knowledgeChunking.js';
import { embedBatch, EMBEDDING_CONFIG } from './embeddings.js';

const CANDIDATE_STATUSES = new Set(['indexing', 'ready', 'active', 'failed']);

/** PostgreSQL-safe vector literal JS never emits exponent notation (1e-7). */
function toVectorLiteral(values) {
  return `[${values.map((v) => (Number.isFinite(v) ? Number(v).toFixed(10).replace(/\.?0+$/, '') : 0)).join(',')}]`;
}

/**
 * Index ONE published document version end-to-end.
 * @param {object} args
 * @param {string} args.tenantId       owner tenant (from the document's source row)
 * @param {string|null} args.brandId   brand scope (from the document's source row)
 * @param {string} args.sourceId       knowledge_sources.id
 * @param {string} args.documentId     knowledge_documents.id
 * @param {number} args.version        knowledge_documents.version
 * @param {Record<string, unknown>} args.structured published structured content
 * @param {object} [args.db]           query executor (pool or client) — for tests
 */
export async function indexDocumentVersion({ tenantId, brandId, sourceId, documentId, version, structured, db }) {
  if (!tenantId || !sourceId || !documentId) {
    const err = new Error('tenantId, sourceId and documentId are required');
    err.code = 'INDEX_INPUT_INVALID';
    throw err;
  }
  const executor = db;
  if (!executor) {
    const err = new Error('db executor is required');
    err.code = 'INDEX_DB_REQUIRED';
    throw err;
  }

  // 1) candidate row (idempotent per document+version; failed attempts are replaced)
  const { rows: existing } = await executor.query(
    `SELECT id, status FROM knowledge_index_versions WHERE document_id = $1 AND version = $2 AND status <> 'failed'`,
    [documentId, version]
  );
  if (existing[0]?.status === 'active') {
    return { status: 'already-active', indexVersionId: existing[0].id, chunkCount: 0, embeddedCount: 0 };
  }

  let indexVersionId;
  if (existing[0]) {
    indexVersionId = existing[0].id;
  } else {
    const { rows: [created] } = await executor.query(
      `INSERT INTO knowledge_index_versions (tenant_id, brand_id, source_id, document_id, version, status, embedding_model, embedding_dims)
       VALUES ($1,$2,$3,$4,$5,'indexing',$6,$7) RETURNING id`,
      [tenantId, brandId, sourceId, documentId, version, EMBEDDING_CONFIG.model, EMBEDDING_CONFIG.dims]
    );
    indexVersionId = created.id;
  }

  try {
    // 2) idempotent: remove any chunks from a previous partial attempt
    await executor.query(
      `DELETE FROM knowledge_chunks WHERE metadata->>'indexVersionId' = $1`,
      [indexVersionId]
    );

    // 3) chunk the PUBLISHED content (business content preserved verbatim)
    const chunks = chunkKnowledge(structured);
    if (!chunks.length) {
      const err = new Error('knowledge produced no chunks');
      err.code = 'INDEX_NO_CHUNKS';
      throw err;
    }
    for (const c of chunks) {
      await executor.query(
        `INSERT INTO knowledge_chunks (tenant_id, document_id, content, embedding, metadata)
         VALUES ($1,$2,$3,NULL,$4)`,
        [
          tenantId,
          documentId,
          c.content,
          JSON.stringify({
            indexVersionId,
            brandId: brandId ?? null,
            section: c.section,
            entityKey: c.entityKey,
            kind: c.kind,
            docVersion: version,
            key: c.key
          })
        ]
      );
    }

    // 4) embeddings (batch, sequential fallback inside embedBatch)
    const vectors = await embedBatch(chunks.map((c) => c.content));
    if (vectors.length !== chunks.length) {
      const err = new Error('embedding count mismatch');
      err.code = 'INDEX_EMBED_COUNT_MISMATCH';
      throw err;
    }

    // 5) write embeddings back per chunk key
    const { rows: chunkRows } = await executor.query(
      `SELECT id, metadata->>'key' AS key FROM knowledge_chunks WHERE metadata->>'indexVersionId' = $1`,
      [indexVersionId]
    );
    const byKey = new Map(chunkRows.map((r) => [r.key, r.id]));
    for (let i = 0; i < chunks.length; i++) {
      const id = byKey.get(chunks[i].key);
      if (!id) {
        const err = new Error('chunk key missing after insert');
        err.code = 'INDEX_CHUNK_MISSING';
        throw err;
      }
      await executor.query(
        `UPDATE knowledge_chunks SET embedding = $1::vector WHERE id = $2`,
        [toVectorLiteral(vectors[i]), id]
      );
    }

    // 6) verify: EVERY chunk of this index version must have a 768-d embedding
    const { rows: [{ embedded_count }] } = await executor.query(
      `SELECT count(*)::int AS embedded_count FROM knowledge_chunks
        WHERE metadata->>'indexVersionId' = $1 AND embedding IS NOT NULL AND vector_dims(embedding) = $2`,
      [indexVersionId, EMBEDDING_CONFIG.dims]
    );
    if (embedded_count !== chunks.length) {
      const err = new Error(`indexing incomplete (${embedded_count}/${chunks.length} embedded)`);
      err.code = 'INDEX_INCOMPLETE';
      throw err;
    }

    // 7) ready
    await executor.query(
      `UPDATE knowledge_index_versions
         SET status = 'ready', chunk_count = $2, embedded_count = $3, ready_at = now(), error = NULL
       WHERE id = $1`,
      [indexVersionId, chunks.length, embedded_count]
    );

    // 8) activate — demote the previous active version atomically
    await executor.query(
      `UPDATE knowledge_index_versions SET status = 'ready', activated_at = NULL
        WHERE tenant_id = $1 AND source_id = $2 AND status = 'active' AND id <> $3`,
      [tenantId, sourceId, indexVersionId]
    );
    await executor.query(
      `UPDATE knowledge_index_versions SET status = 'active', activated_at = now() WHERE id = $1`,
      [indexVersionId]
    );

    return { status: 'activated', indexVersionId, chunkCount: chunks.length, embeddedCount: embedded_count };
  } catch (err) {
    // FAIL SAFE: candidate is marked failed and its chunks are removed —
    // partial vectors are NEVER served and the previous active version is untouched.
    await executor.query(
      `UPDATE knowledge_index_versions SET status = 'failed', error = $2 WHERE id = $1`,
      [indexVersionId, String(err?.code ?? err?.message ?? 'unknown_error').slice(0, 300)]
    ).catch(() => {});
    await executor.query(
      `DELETE FROM knowledge_chunks WHERE metadata->>'indexVersionId' = $1`,
      [indexVersionId]
    ).catch(() => {});
    throw err;
  }
}

/** The active index version for a tenant/source — the ONLY one retrieval may use. */
export async function getActiveIndexVersion({ tenantId, sourceId, brandId = null, db }) {
  if (!db) {
    const err = new Error('db executor is required');
    err.code = 'INDEX_DB_REQUIRED';
    throw err;
  }
  const params = [tenantId, sourceId];
  let sql = `SELECT id, version, status, chunk_count, embedded_count, embedding_model, embedding_dims, activated_at
               FROM knowledge_index_versions
              WHERE tenant_id = $1 AND source_id = $2 AND status = 'active'`;
  if (brandId) {
    sql += ` AND (brand_id = $3 OR brand_id IS NULL)`;
    params.push(brandId);
  }
  sql += ` ORDER BY activated_at DESC LIMIT 1`;
  const { rows } = await db.query(sql, params);
  return rows[0] ?? null;
}

export { CANDIDATE_STATUSES };
