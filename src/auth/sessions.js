import crypto from 'node:crypto';
import { pool } from '../db/pg.js';
import { effectiveCustomAbilities } from './abilities.js';

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

/**
 * Load this user's live brand grants.
 *
 * Per USER, never per role. Returns the explicit brand list plus whether the
 * user holds an audited "every brand inside my company" delegation. Absence of
 * any row yields an empty list, which brandAccess.js treats as ZERO brands.
 */
async function loadBrandGrants(userId, tenantId) {
  const [granted, scopeAll] = await Promise.all([
    pool.query(
      `SELECT brand_id FROM user_brand_grants
        WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [userId, tenantId]
    ),
    pool.query(
      `SELECT 1 FROM user_brand_scope_all
        WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [userId, tenantId]
    )
  ]);
  return {
    brandIds: granted.rows.map((r) => r.brand_id),
    allBrandsInCompany: scopeAll.rows.length > 0
  };
}

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
    `SELECT r.name, r.permissions
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1`,
    [row.user_id]
  );

  // Check if user is a Platform Super Admin (platform-level, not tenant-scoped)
  const { rows: psa } = await pool.query(
    `SELECT 1 FROM platform_super_admins WHERE user_id = $1`,
    [row.user_id]
  );
  const roleNames = roles.map((r) => r.name);
  if (psa.length > 0) {
    roleNames.push('Platform Super Admin');
  }

  // Custom roles take their abilities from roles.permissions; built-in roles
  // keep the reviewed hardcoded map. Neither path can confer brand scope.
  const perRolePermissions = Object.fromEntries(
    roles.map((r) => [r.name, r.permissions])
  );
  const customAbilities = effectiveCustomAbilities(roleNames, perRolePermissions);

  const grants = await loadBrandGrants(row.user_id, row.tenant_id);

  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.name },
    roles: roleNames,
    // Brand scope is resolved per request from the grant tables, so a grant or a
    // revoke is effective on the next request without re-issuing the session.
    // Platform Super Admin is deliberately NOT given brand scope here: platform
    // privileges never imply access to a company's brands (see abilities.js).
    brandIds: grants.allBrandsInCompany ? null : grants.brandIds,
    allBrandsInCompany: grants.allBrandsInCompany,
    isPlatformSuperAdmin: psa.length > 0,
    customAbilities
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
