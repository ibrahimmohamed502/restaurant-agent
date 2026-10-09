/**
 * Meta event worker (Stage 4 completion).
 *
 * Separate process/service: consumes the BullMQ queue and runs the same core
 * pipeline as the inline path. Uses the existing PostgreSQL, Redis and encrypted
 * provider credentials. No secrets are read from job payloads.
 *
 * Run: node src/workers/metaEventWorker.js
 */
import { Worker } from 'bullmq';
import { getRedisConnection } from '../queues/redis.js';
import { closeRedisConnection } from '../queues/redis.js';
import { META_EVENT_QUEUE } from '../queues/metaEvents.js';
import { processQueuedMetaEvent } from './metaEventPipeline.js';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);

export function createMetaEventWorker() {
  return new Worker(
    META_EVENT_QUEUE,
    async (job) => {
      const started = Date.now();
      const result = await processQueuedMetaEvent(job.data ?? {});
      const ms = Date.now() - started;
      if (!result?.skipped) console.log(`✅ worker processed ${job.id} in ${ms}ms`);
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: CONCURRENCY,
      // bounded, duplicate-safe
      lockDuration: 60000
    }
  );
}

async function main() {
  console.log(`👷 meta event worker starting (queue=${META_EVENT_QUEUE}, concurrency=${CONCURRENCY})`);
  const worker = createMetaEventWorker();

  worker.on('completed', (job) => console.log(`✅ job done: ${job.id}`));
  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.attemptsMade ?? 0;
    const max = job.opts?.attempts ?? 3;
    console.warn(`⚠️ job ${job.id} failed (attempt ${attempts}/${max}): ${(err?.message ?? 'error').slice(0, 120)}`);
  });

  const shutdown = async (sig) => {
    console.log(`\n${sig} received — draining worker…`);
    await worker.close().catch(() => undefined);
    await closeRedisConnection().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('👷 worker ready');
}

// only auto-start when executed directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('metaEventWorker.js')) {
  main().catch((err) => {
    console.error('❌ worker fatal:', err.message);
    process.exit(1);
  });
}
