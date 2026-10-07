import pg from 'pg';

/**
 * Shared Postgres pool (lazy — connects on first query).
 * If DATABASE_URL is unset, `enabled` is false and the app runs in legacy JSON mode.
 */
const { Pool } = pg;

export const enabled = Boolean(process.env.DATABASE_URL);

export const pool = enabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000
    })
  : null;

if (enabled) {
  pool.on('error', (err) => console.error('⚠️ pg pool error:', err.message));
}
