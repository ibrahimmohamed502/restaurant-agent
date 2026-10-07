import express from 'express';
import { pool } from '../db/pg.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/passwords.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { audit } from '../auth/audit.js';

export const usersRouter = express.Router();
const ADMIN = requireRole('Company Admin');

/* ------------------------- GET /dashboard/api/users ------------------------- */
usersRouter.get('/dashboard/api/users', requireAuth, ADMIN, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.status, u.created_at, u.last_login_at,
            COALESCE(json_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '[]') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.tenant_id = $1
     GROUP BY u.id
     ORDER BY u.created_at`,
    [req.auth.tenantId]
  );
  res.json(rows);
});

/* ------------------------ POST /dashboard/api/users ------------------------- */
usersRouter.post('/dashboard/api/users', requireAuth, ADMIN, async (req, res) => {
  const { email, name, password, roles = [] } = req.body ?? {};
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query(
      `INSERT INTO users (tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, status, created_at`,
      [req.auth.tenantId, String(email).toLowerCase().trim(), name, await hashPassword(password)]
    );

    for (const roleName of roles) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE tenant_id = $2 AND name = $3
         ON CONFLICT DO NOTHING`,
        [user.id, req.auth.tenantId, roleName]
      );
    }
    await client.query('COMMIT');

    audit({ tenantId: req.auth.tenantId, actorUserId: req.auth.user.id, action: 'users.create', objectType: 'user', objectId: user.id, ip: req.ip, metadata: { email: user.email, roles } });
    res.json(user);
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.message).includes('unique')) return res.status(409).json({ error: 'email already exists in this tenant' });
    throw e;
  } finally {
    client.release();
  }
});

/* --------------------- POST /dashboard/api/users/:id/status --------------------- */
usersRouter.post('/dashboard/api/users/:id/status', requireAuth, ADMIN, async (req, res) => {
  const { status } = req.body ?? {};
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'status must be active|disabled' });
  if (req.params.id === req.auth.user.id && status === 'disabled') {
    return res.status(400).json({ error: 'you cannot disable your own account' });
  }

  const { rows } = await pool.query(
    `UPDATE users SET status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, email, status`,
    [status, req.params.id, req.auth.tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });

  if (status === 'disabled') await revokeUserSessions(rows[0].id);
  audit({ tenantId: req.auth.tenantId, actorUserId: req.auth.user.id, action: `users.${status === 'active' ? 'activate' : 'disable'}`, objectType: 'user', objectId: rows[0].id, ip: req.ip, metadata: { email: rows[0].email } });
  res.json(rows[0]);
});

/* --------------------- POST /dashboard/api/users/:id/roles --------------------- */
usersRouter.post('/dashboard/api/users/:id/roles', requireAuth, ADMIN, async (req, res) => {
  const { roles = [] } = req.body ?? {};
  if (!Array.isArray(roles)) return res.status(400).json({ error: 'roles must be an array' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.auth.tenantId]
    );
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [user.id]);
    for (const roleName of roles) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE tenant_id = $2 AND name = $3
         ON CONFLICT DO NOTHING`,
        [user.id, req.auth.tenantId, roleName]
      );
    }
    await client.query('COMMIT');
    audit({ tenantId: req.auth.tenantId, actorUserId: req.auth.user.id, action: 'users.roles_change', objectType: 'user', objectId: user.id, ip: req.ip, metadata: { roles } });
    res.json({ ok: true, roles });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});
