/**
 * Shared Redis connection for BullMQ (queue + worker).
 * REDIS_URL comes from the stack environment. Never logs credentials.
 */
import IORedis from 'ioredis';

let connection = null;

export function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) {
    const err = new Error('REDIS_URL not configured — queue/worker disabled');
    err.code = 'REDIS_NOT_CONFIGURED';
    throw err;
  }
  if (!connection) {
    connection = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
    connection.on('error', (e) => console.warn('⚠️ redis error:', e.message));
  }
  return connection;
}

export async function closeRedisConnection() {
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = null;
  }
}
