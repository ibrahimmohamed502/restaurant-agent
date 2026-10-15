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
import { safeErrorCode } from '../services/redact.js';
import { claimStaleWebhookEvents } from '../services/webhookEvents.js';
import { redispatchStaleIntakes } from './metaEventPipeline.js';
import { enabled as pgEnabled } from '../db/pg.js';

/** How often stranded intake rows are looked for. */
export const STALE_SWEEP_INTERVAL_MS = Number(process.env.STALE_SWEEP_INTERVAL_MS || 60_000);

/**
 * Recover intake rows that were recorded but never started processing.
 *
 * Owned exclusively by the worker: it is the process that owns queue state, and
 * a second claimer (for example the webhook request path) could take a row that
 * a queued job is about to process, producing a duplicate outbound reply.
 *
 * This process NEVER processes a swept event: it only re-queues it, so the
 * worker remains the single processor. Because the job id is a
 * deterministic function of (provider, external_id), re-adding a job that is
 * already waiting/active/delayed is a no-op, and one that was lost is
 * restored. A queued-but-unclaimed job therefore cannot be processed twice.
 *
 * Safety rules:
 *   - only rows still in 'received' are claimed, via one atomic UPDATE;
 *   - rows in 'processing' are never auto-replayed;
 *   - bounded by the claim limit, single pass per tick, no retry loop.
 */
export function startStaleIntakeSweeper({ intervalMs = STALE_SWEEP_INTERVAL_MS } = {}) {
  if (!pgEnabled) {
    console.log('⏭️ stale intake sweeper disabled (no database)');
    return null;
  }
  const timer = setInterval(async () => {
    try {
      const claimed = await claimStaleWebhookEvents();
      if (!claimed.length) return;
      console.warn(`♻️  sweeping ${claimed.length} stranded intake event(s) that never started`);
      // Re-dispatch ONLY. This process never runs customer message/comment
      // logic for a swept row, so the worker stays the only processor and a
      // queued-but-unclaimed job cannot be processed twice.
      const results = await redispatchStaleIntakes(claimed);
      const restored = results.filter((r) => r?.redispatched).length;
      if (restored) console.warn(`♻️  re-dispatched ${restored} stranded intake event(s)`);
    } catch (err) {
      console.error('❌ stale intake sweep failed:', safeErrorCode(err));
    }
  }, Math.max(15_000, Number(intervalMs) || 60_000));
  timer.unref?.(); // never hold the process open
  console.log(`♻️  stale intake sweeper armed (every ${Math.max(15_000, Number(intervalMs) || 60_000)}ms)`);
  return timer;
}
import { META_EVENT_QUEUE } from '../queues/metaEvents.js';
import { processQueuedMetaEvent } from './metaEventPipeline.js';
import { createKnowledgeIndexWorker } from './knowledgeIndexWorker.js';

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

/** Move an exhausted job's intake row to 'dlq' (sanitized reason only). */
async function markEventDlq(job, err) {
  const provider = job?.data?.provider;
  const eventId = job?.data?.eventId;
  if (!provider || !eventId) return;
  const { updateWebhookEvent, WEBHOOK_ERROR } = await import('../services/webhookEvents.js');
  await updateWebhookEvent({
    provider,
    externalId: eventId,
    status: 'dlq',
    error: WEBHOOK_ERROR.JOB_EXHAUSTED
  }).catch(() => undefined);
  console.error(`❌ job ${job.id} exhausted its retries — intake marked dlq (${safeErrorCode(err)})`);
}

async function main() {
  console.log(`👷 meta event worker starting (queue=${META_EVENT_QUEUE}, concurrency=${CONCURRENCY})`);
  const worker = createMetaEventWorker();

  // Stage 6: the knowledge-index worker shares the process but uses its OWN
  // queue + concurrency — embedding/index jobs never mix with Meta events.
  startStaleIntakeSweeper();
  const indexWorker = createKnowledgeIndexWorker();
  indexWorker.on('completed', (job) => console.log(`✅ index job done: ${job.id}`));
  indexWorker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.attemptsMade ?? 0;
    const max = job.opts?.attempts ?? 3;
    console.warn(`⚠️ index job ${job.id} failed (attempt ${attempts}/${max}): ${safeErrorCode(err)}`);
  });

  worker.on('completed', (job) => console.log(`✅ job done: ${job.id}`));
  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.attemptsMade ?? 0;
    const max = job.opts?.attempts ?? 3;
    console.warn(`⚠️ job ${job.id} failed (attempt ${attempts}/${max}): ${safeErrorCode(err)}`);
    // Exhausted retries must leave a durable, visible record instead of a job
    // that silently sits in the BullMQ failed set. The intake row moves to
    // 'dlq' and is NEVER auto-replayed, so this cannot duplicate a reply.
    if (attempts >= max) {
      markEventDlq(job, err).catch(() => undefined);
    }
  });

  const shutdown = async (sig) => {
    console.log(`\n${sig} received — draining worker…`);
    await worker.close().catch(() => undefined);
    await indexWorker.close().catch(() => undefined);
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
    console.error('❌ worker fatal:', safeErrorCode(err));
    process.exit(1);
  });
}
