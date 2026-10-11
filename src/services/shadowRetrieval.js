/**
 * Stage 6 Batch 2 — SHADOW retrieval runner.
 *
 * Runs AFTER a production reply has been sent (post-processing) and is
 * completely fail-safe: any error is swallowed — the customer reply, its
 * delivery status and the queue are NEVER affected.
 *
 * Modes (KNOWLEDGE_RETRIEVAL_MODE):
 *   off    — do nothing
 *   shadow — retrieve + record references, send nothing (default)
 *   active — reserved for Batch 3 cutover (NOT enabled here)
 */
import { pool } from '../db/pg.js';
import { retrieveContext, toSourceRefs, RETRIEVAL_MODE } from './retrieval.js';

export { RETRIEVAL_MODE };

/**
 * Fire-and-forget shadow retrieval for one delivered reply.
 * @param {object} args
 * @param {string} args.text        customer message (bounded use in diagnostics)
 * @param {string} args.tenantId
 * @param {string|null} args.brandId
 * @param {string|null} args.messageId   outbound message id (nullable)
 * @param {string|null} args.conversationId
 */
export async function runShadowRetrieval({ text, tenantId, brandId = null, messageId = null, conversationId = null }) {
  if (RETRIEVAL_MODE === 'off') return { skipped: true };

  const client = await pool.connect();
  try {
    const ctx = await retrieveContext({ text, tenantId, brandId, db: client });
    const refs = toSourceRefs(ctx);

    const { rows: [source] } = await client.query(
      `SELECT id FROM knowledge_sources WHERE tenant_id = $1 AND ($2::uuid IS NULL OR brand_id = $2) ORDER BY created_at ASC LIMIT 1`,
      [tenantId, brandId]
    );

    await client.query(
      `INSERT INTO knowledge_reply_sources
         (tenant_id, brand_id, source_id, message_id, conversation_id, intent, retrieval,
          index_version_id, confidence, chunk_refs, fact_refs, fallback_used, fallback_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        tenantId, brandId, source?.id ?? null, messageId, conversationId,
        refs.intent, refs.retrieval, ctx.activeVersion, refs.confidence,
        JSON.stringify(refs.chunks), JSON.stringify(refs.facts),
        Boolean(ctx.fallback), ctx.fallback ?? null
      ]
    );
    return { ok: true, intent: refs.intent, retrieval: refs.retrieval };
  } catch (err) {
    // shadow must never break the reply path
    console.warn('⚠️ shadow retrieval skipped:', (err?.code ?? err?.message ?? 'error').toString().slice(0, 120));
    return { ok: false };
  } finally {
    client.release();
  }
}
