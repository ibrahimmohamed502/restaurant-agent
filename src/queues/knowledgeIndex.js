/**
 * Stage 6 Batch 1 — Knowledge index queue (SEPARATE from meta-events).
 *
 * Long-running embedding/index jobs never mix into the Meta message queue:
 * own queue name, own bounded retry policy, own worker concurrency.
 *
 * Job payload contains ONLY internal ids/context — never secrets.
 */
import { Queue } from 'bullmq';
import { getRedisConnection } from './redis.js';

export const KNOWLEDGE_INDEX_QUEUE = 'knowledge-index';

let queue = null;

export function getKnowledgeIndexQueue() {
  if (!queue) {
    queue = new Queue(KNOWLEDGE_INDEX_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }, // 5s → 10s → 20s
        removeOnComplete: { age: 86400, count: 500 },
        removeOnFail: { age: 604800 } // keep failures a week for diagnosis
      }
    });
  }
  return queue;
}

/** Enqueue indexing for a published document version (idempotent per doc+version). */
export async function enqueueKnowledgeIndex({ tenantId, brandId, sourceId, documentId, version }) {
  const job = await getKnowledgeIndexQueue().add(
    'knowledge-index',
    { tenantId, brandId: brandId ?? null, sourceId, documentId, version },
    { jobId: `knowledge-index:${documentId}:${version}` }
  );
  return job.id;
}

export async function closeKnowledgeIndexQueue() {
  if (queue) {
    await queue.close().catch(() => undefined);
    queue = null;
  }
}
