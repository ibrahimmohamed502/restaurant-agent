/**
 * Meta event queue (Stage 4 completion).
 *
 * Job payload contains ONLY internal ids/context — never tokens, credentials,
 * or raw secrets. The worker re-resolves tenant/channel/credential from the DB.
 *
 * Retry policy: bounded attempts with exponential backoff. A job that exhausts
 * its attempts lands in the 'failed' set and the webhook_events row is marked
 * failed with a SANITIZED category (see deliveryErrorCategory).
 */
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

/** Enqueue a normalized event for asynchronous processing. */
export async function enqueueMetaEvent(event) {
  const job = await getMetaEventQueue().add(
    'meta-event',
    {
      provider: event.provider,
      eventId: event.eventId,
      eventType: event.eventType,
      pageId: event.pageId,
      conversationKey: event.conversationKey,
      actor: event.actor,
      text: event.text,
      receivedAt: event.receivedAt
    },
    { jobId: `${event.provider}:${event.eventId}` } // BullMQ-level dedupe for the same event id
  );
  return job.id;
}

export async function closeMetaEventQueue() {
  if (queue) {
    await queue.close().catch(() => undefined);
    queue = null;
  }
}
