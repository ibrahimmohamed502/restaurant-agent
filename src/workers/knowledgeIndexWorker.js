/**
 * Stage 6 Batch 1 — Knowledge index worker.
 *
 * Consumes the SEPARATE `knowledge-index` queue. Each job re-reads the PUBLISHED
 * document from the DB (drafts never reach the worker) and runs the version-safe
 * indexing pipeline. Tenant/brand always come from the DB rows — never the payload.
 *
 * Run: node src/workers/knowledgeIndexWorker.js
 */
import { Worker } from 'bullmq';
import { getRedisConnection, closeRedisConnection } from '../queues/redis.js';
import { KNOWLEDGE_INDEX_QUEUE } from '../queues/knowledgeIndex.js';
import { pool } from '../db/pg.js';
import { indexDocumentVersion } from '../services/knowledgeIndexing.js';

const CONCURRENCY = Number(process.env.KNOWLEDGE_INDEX_CONCURRENCY || 2);

export function createKnowledgeIndexWorker() {
  return new Worker(
    KNOWLEDGE_INDEX_QUEUE,
    async (job) => {
      const { tenantId, sourceId, documentId, version } = job.data ?? {};
      if (!tenantId || !sourceId || !documentId) {
        // malformed payload is a permanent rejection — no retry
        const err = new Error('invalid knowledge-index payload');
        err.code = 'INDEX_INPUT_INVALID';
        throw err;
      }
      // Always resolve trust-critical data from the DB (never the payload).
      const { rows } = await pool.query(
        `SELECT d.id, d.version, d.status, d.structured, s.tenant_id, s.brand_id
           FROM knowledge_documents d
           JOIN knowledge_sources s ON s.id = d.source_id
          WHERE d.id = $1 AND d.source_id = $2 AND s.tenant_id = $3`,
        [documentId, sourceId, tenantId]
      );
      const doc = rows[0];
      if (!doc) {
        const err = new Error('document not found for indexing');
        err.code = 'INDEX_DOC_NOT_FOUND';
        throw err;
      }
      if (doc.status !== 'published') {
        // drafts are never indexed — permanent rejection, no retry loop
        const err = new Error(`document status '${doc.status}' is not indexable`);
        err.code = 'INDEX_NOT_PUBLISHED';
        throw err;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // serialize activation per source (no two versions active at once)
        await client.query('SELECT id FROM knowledge_sources WHERE id = $1 FOR UPDATE', [sourceId]);
        const result = await indexDocumentVersion({
          tenantId: doc.tenant_id,
          brandId: doc.brand_id,
          sourceId,
          documentId,
          version: doc.version,
          structured: doc.structured,
          db: client
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: CONCURRENCY,
      lockDuration: 120000
    }
  );
}

async function main() {
  console.log(`👷 knowledge index worker starting (queue=${KNOWLEDGE_INDEX_QUEUE}, concurrency=${CONCURRENCY})`);
  const worker = createKnowledgeIndexWorker();

  worker.on('completed', (job) => console.log(`✅ index job done: ${job.id}`));
  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.attemptsMade ?? 0;
    const max = job.opts?.attempts ?? 3;
    console.warn(`⚠️ index job ${job.id} failed (attempt ${attempts}/${max}): ${(err?.code ?? err?.message ?? 'error').toString().slice(0, 140)}`);
  });

  const shutdown = async (sig) => {
    console.log(`\n${sig} received — draining knowledge index worker…`);
    await worker.close().catch(() => undefined);
    await closeRedisConnection().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('👷 knowledge index worker ready');
}

if (process.argv[1] && process.argv[1].endsWith('knowledgeIndexWorker.js')) {
  main().catch((err) => {
    console.error('❌ knowledge index worker fatal:', err.message);
    process.exit(1);
  });
}
