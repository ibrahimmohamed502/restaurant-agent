/**
 * Stage 6 Batch 2 — retrieval (hybrid: structured + pgvector) for SHADOW mode.
 *
 * NEVER sends anything to the customer. Produces a compact context + source
 * references so we can evaluate retrieval quality before any cutover (Batch 3).
 *
 * Isolation (hard): tenant_id + brand_id + ACTIVE index version only.
 */
import { classifyIntent } from './intentRouter.js';
import { lookupStructured } from './structuredLookup.js';
import { embedText } from './embeddings.js';
import { getActiveIndexVersion } from './knowledgeIndexing.js';
import { getPublishedKnowledge } from './knowledge.js';

const TOP_K = Number(process.env.KNOWLEDGE_RETRIEVAL_TOPK || 3);
// 0.6 separates valid LWC questions (0.62–0.84 observed) from off-topic
// questions (0.57 observed) without dropping valid cases.
const MIN_SCORE = Number(process.env.KNOWLEDGE_RETRIEVAL_MIN_SCORE || 0.6);

export const RETRIEVAL_MODES = ['off', 'shadow', 'active'];
export const RETRIEVAL_MODE = RETRIEVAL_MODES.includes(process.env.KNOWLEDGE_RETRIEVAL_MODE)
  ? process.env.KNOWLEDGE_RETRIEVAL_MODE
  : 'shadow';

/** PostgreSQL-safe vector literal: toFixed avoids exponent notation (1e-7). */
export function vecLiteral(values) {
  return `[${values.map((v) => (Number.isFinite(v) ? Number(v).toFixed(10).replace(/\.?0+$/, '') : 0)).join(',')}]`;
}

/**
 * Retrieve context for a customer message (no generation).
 * @returns {Promise<{intent, confidence, retrieval, facts, chunks, activeVersion, fallback}>}
 */
export async function retrieveContext({ text, tenantId, brandId = null, db }) {
  const { intent, confidence } = classifyIntent(text);
  const ctx = {
    intent,
    confidence,
    retrieval: 'none',
    facts: [],
    chunks: [],
    activeVersion: null,
    fallback: null
  };

  const published = await getPublishedKnowledge({
    tenantId,
    sourceId: (await db.query(
      `SELECT id FROM knowledge_sources WHERE tenant_id = $1 AND ($2::uuid IS NULL OR brand_id = $2) ORDER BY created_at ASC LIMIT 1`,
      [tenantId, brandId]
    )).rows[0]?.id
  });
  if (!published) {
    ctx.fallback = 'no_published_knowledge';
    return ctx;
  }

  // 1) structured lookup for exact facts (high confidence only)
  if (['price', 'hours', 'phone', 'branch_location', 'menu'].includes(intent) && confidence >= 0.6) {
    const hit = lookupStructured(intent, text, published.structured);
    if (hit) {
      ctx.retrieval = 'structured';
      ctx.facts = [{ ...hit.fact, _source: hit.source }];
    }
  }

  // 2) pgvector semantic retrieval on the ACTIVE version only
  const active = await getActiveIndexVersion({ tenantId, sourceId: published.source_id, brandId, db });
  if (active) {
    ctx.activeVersion = active.id;
    try {
      const vec = await embedText(text);
      const { rows } = await db.query(
        `SELECT k.id, k.content, k.metadata,
                1 - (k.embedding <=> $1::vector) AS score
           FROM knowledge_chunks k
          WHERE k.metadata->>'indexVersionId' = $2
            AND k.tenant_id = $3
            AND ($4::uuid IS NULL OR (k.metadata->>'brandId')::uuid = $4)
            AND k.embedding IS NOT NULL
            AND k.embedding <=> $1::vector <= (1 - ($5)::float)
          ORDER BY k.embedding <=> $1::vector
          LIMIT $6`,
        [vecLiteral(vec), active.id, tenantId, brandId, MIN_SCORE, TOP_K]
      );
      ctx.chunks = rows.map((r) => ({
        id: r.id,
        section: r.metadata?.section ?? null,
        entityKey: r.metadata?.entityKey ?? null,
        kind: r.metadata?.kind ?? null,
        score: Number(r.score.toFixed(4)),
        content: String(r.content).slice(0, 400) // bounded copy for diagnostics
      }));
      ctx.retrieval = ctx.retrieval === 'structured' ? 'hybrid' : 'vector';
    } catch (e) {
      ctx.fallback = `vector_error:${e.code ?? 'unknown'}`;
    }
  } else {
    ctx.fallback = ctx.fallback ?? 'no_active_index';
  }

  if (!ctx.facts.length && !ctx.chunks.length) {
    ctx.fallback = ctx.fallback ?? 'no_relevant_context';
  }
  return ctx;
}

/** Compact, reference-only shadow record (no duplicated business facts). */
export function toSourceRefs(ctx) {
  return {
    intent: ctx.intent,
    confidence: ctx.confidence,
    retrieval: ctx.retrieval,
    facts: ctx.facts.map((f) => ({ type: f.type, source: f._source })),
    chunks: ctx.chunks.map((c) => ({ id: c.id, section: c.section, entityKey: c.entityKey, score: c.score })),
    fallback: ctx.fallback
  };
}
