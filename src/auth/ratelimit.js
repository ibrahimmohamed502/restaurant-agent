import { pool } from '../db/pg.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

/** Returns seconds remaining if locked, else 0. */
export async function lockedSeconds(email, ip) {
  const key = `${email}|${ip}`;
  const { rows } = await pool.query(`SELECT locked_until FROM login_attempts WHERE key = $1`, [key]);
  if (!rows[0]?.locked_until) return 0;
  const remain = Math.ceil((new Date(rows[0].locked_until).getTime() - Date.now()) / 1000);
  return Math.max(0, remain);
}

export async function recordFailedLogin(email, ip) {
  const key = `${email}|${ip}`;
  await pool.query(
    `INSERT INTO login_attempts (key, failed_count, last_failed_at, locked_until)
     VALUES ($1, 1, now(), CASE WHEN 1 >= $2 THEN now() + ($3 || ' minutes')::interval END)
     ON CONFLICT (key) DO UPDATE SET
       failed_count = login_attempts.failed_count + 1,
       last_failed_at = now(),
       locked_until = CASE
         WHEN login_attempts.failed_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
         ELSE NULL END`,
    [key, MAX_FAILS, String(LOCK_MINUTES)]
  );
}

export async function resetLoginAttempts(email, ip) {
  await pool.query(`DELETE FROM login_attempts WHERE key = $1`, [`${email}|${ip}`]);
}
