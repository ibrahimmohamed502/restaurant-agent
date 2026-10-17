import express from 'express';
import { pool } from '../db/pg.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/passwords.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { audit } from '../auth/audit.js';
import { canDelegateRole } from '../auth/abilities.js';

const ADMIN = requireRole('Company Admin');

/**
 * DELEGATION CEILING.
 *
 * A tenant administrator may only hand out roles whose every ability they
 * already hold, and may never hand out a platform-administrative role.
 *
 * Without this, POST /api/v1/users/:id/roles let any Company Admin attach the
 * tenant-local "Platform Super Admin" role row to their own account, because the
 * only gate on that route was "is a Company Admin".
 *
 * Runs BEFORE any write, and resolves the role list from the ACTOR's own tenant,
 * so it cannot be steered at another company. Fails closed on an unknown role.
 */
async function assertRolesDelegable(req, roles) {
  if (!Array.isArray(roles) || roles.length === 0) return;
  const actorRoles = req.auth?.roles ?? [];
  const actorCustomAbilities = req.v1?.customAbilities ?? req.auth?.customAbilities ?? [];
  const { rows } = await pool.query(
    `SELECT name, permissions FROM roles WHERE tenant_id = $1 AND name = ANY($2)`,
    [req.auth.tenantId, roles.map(String)]
  );
  const byName = new Map(rows.map((r) => [r.name, r.permissions]));
  for (const roleName of roles) {
    if (!canDelegateRole({
      actorRoles,
      actorCustomAbilities,
      targetRoleName: String(roleName),
      targetPermissions: byName.get(String(roleName)) ?? null
    })) {
      const err = new Error(`you cannot grant the role "${roleName}"`);
      err.status = 403;
      err.code = 'ROLE_NOT_DELEGABLE';
      throw err;
    }
  }
}

/** Emit the ceiling rejection without leaking a stack trace. */
function respondDelegationError(res, e) {
  if (e?.code === 'ROLE_NOT_DELEGABLE') {
    return res.status(e.status ?? 403).json({ error: e.message, code: e.code });
  }
  throw e;
}

/* ------------------------------- handlers ------------------------------- */
/* Exported so both the legacy dashboard router and the /api/v1 router can
   reuse the exact same tenant-scoped, RBAC-guarded implementation. */

export async function listUsers(req, res) {
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
}

export async function createUser(req, res) {
  const { email, name, password, roles = [] } = req.body ?? {};
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  // Reject a non-delegable role BEFORE creating anything.
  try {
    await assertRolesDelegable(req, roles);
  } catch (e) {
    return respondDelegationError(res, e);
  }

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
}

export async function setUserStatus(req, res) {
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
}

export async function setUserRoles(req, res) {
  const { roles = [] } = req.body ?? {};
  if (!Array.isArray(roles)) return res.status(400).json({ error: 'roles must be an array' });

  // Reject a non-delegable role BEFORE any role row is deleted or inserted.
  try {
    await assertRolesDelegable(req, roles);
  } catch (e) {
    return respondDelegationError(res, e);
  }

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
}

/* --------------------- DELETE /dashboard/api/users/:id --------------------- */
// Hard-delete. Dependent rows are handled by FK actions: sessions/user_roles/
// team_members/notifications CASCADE; messages/notes/assignments/audit SET NULL.
export async function deleteUser(req, res) {
  if (req.params.id === req.auth.user.id) {
    return res.status(400).json({ error: 'you cannot delete your own account' });
  }
  const { rows } = await pool.query(
    `DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id, email`,
    [req.params.id, req.auth.tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });

  audit({ tenantId: req.auth.tenantId, actorUserId: req.auth.user.id, action: 'users.delete', objectType: 'user', objectId: rows[0].id, ip: req.ip, metadata: { email: rows[0].email } });
  res.json({ ok: true, id: rows[0].id });
}

/* ------------------------- legacy dashboard router ------------------------- */

export const usersRouter = express.Router();

usersRouter.get('/dashboard/api/users', requireAuth, ADMIN, listUsers);
usersRouter.post('/dashboard/api/users', requireAuth, ADMIN, createUser);
usersRouter.post('/dashboard/api/users/:id/status', requireAuth, ADMIN, setUserStatus);
usersRouter.post('/dashboard/api/users/:id/roles', requireAuth, ADMIN, setUserRoles);
usersRouter.delete('/dashboard/api/users/:id', requireAuth, ADMIN, deleteUser);
