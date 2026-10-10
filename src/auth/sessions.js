import crypto from 'node:crypto';
import { pool } from '../db/pg.js';

const COOKIE = 'lwc_session';
const TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 7);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Create a DB session and return { token, expiresAt }. */
export async function createSession({ tenantId, userId, ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, userId, hashToken(token), ip || null, userAgent || null, expiresAt]
  );
  return { token, expiresAt };
}

/** Validate a cookie token → { user, roles, tenantId } or null. */
export async function validateSession(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.tenant_id, s.id AS session_id, u.id AS user_id, u.email, u.name, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row || row.status !== 'active') return null;

  const { rows: roles } = await pool.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [row.user_id]
  );
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.name },
    roles: roles.map((r) => r.name)
  };
}

export async function revokeSession(token) {
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [hashToken(token)]);
}

export async function revokeUserSessions(userId) {
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

/** Revokes every session for a user EXCEPT the given one (used after a password change). */
export async function revokeOtherSessions(userId, keepSessionId) {
  await pool.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, keepSessionId]
  );
}

export const sessionCookie = COOKIE;

export function parseCookie(req, name) {  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
