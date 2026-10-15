/**
 * Meta event queue (Stage 4 completion).
 *
 * JOB ID
 *   BullMQ rejects custom job ids that contain ':' unless they happen to split
 *   into exactly three colon-separated parts. The previous format
 *   `${provider}:${eventId}` produced TWO parts and therefore threw
 *   `Custom Id cannot contain :` on EVERY event, so nothing was ever enqueued
 *   and the worker never ran. The id below is colon-free, which is accepted by
 *   every BullMQ version, including future ones that drop the 3-part carve-out.
 *
 *   Identity is a SHA-256 digest of `provider \0 eventId`: deterministic (the
 *   same event always maps to the same id, which is what dedupe relies on),
 *   opaque (no provider id is echoed into Redis), and collision-resistant.
 *
 * PAYLOAD
 *   Identity and routing hints only. Customer content (message text, sender
 *   name, PSID) is deliberately NOT copied into Redis: the worker re-reads the
 *   durable record from `webhook_events.payload` and re-resolves the credential
 *   from the database.
 */
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { getRedisConnection } from './redis.js';

export const META_EVENT_QUEUE = 'meta-events';

let queue = null;

export function getMetaEventQueue() {
  if (!queue) {
    queue = new Queue(META_EVENT_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }, // 2s → 4s → 8s
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 }
      }
    });
  }
  return queue;
}

/**
 * Deterministic, colon-free, opaque BullMQ job id.
 * Fails closed when the identity is incomplete: two incomplete events would
 * otherwise collapse onto the SAME id and one of them would be silently lost.
 */
export function buildMetaEventJobId({ provider, eventId } = {}) {
  if (!provider || !eventId) {
    const err = new Error('meta event identity is incomplete');
    err.code = 'META_EVENT_ID_MISSING';
    throw err;
  }
  const digest = createHash('sha256')
    .update(`${provider}\u0000${eventId}`)
    .digest('hex')
    .slice(0, 40);
  // Never an integer and never contains ':' (BullMQ validation).
  return `metaevent-${digest}`;
}

/**
 * Enqueue a normalized event for asynchronous processing.
 * `deps.queue` is an injection point for tests; production uses the shared queue.
 */
export async function enqueueMetaEvent(event, deps = {}) {
  const target = deps.queue ?? getMetaEventQueue();
  const jobId = buildMetaEventJobId(event);
  const job = await target.add(
    'meta-event',
    {
      provider: event.provider,
      eventId: event.eventId,
      eventType: event.eventType,
      pageId: event.pageId,
      receivedAt: event.receivedAt
    },
    { jobId } // stable id => BullMQ-level dedupe for a redelivered event
  );
  return job.id;
}

export async function closeMetaEventQueue() {
  if (queue) {
    await queue.close().catch(() => undefined);
    queue = null;
  }
}