/**
 * Stage 8 Batch 1 — Platform Super Admin API.
 *
 * Only Platform Super Admin can create, disable, or manage companies.
 * Companies are archived (status='disabled') — never cascade deleted.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requirePlatformSuperAdmin } from './stage7-rbac.js';
import { hashPassword } from '../../auth/passwords.js';
import { audit } from '../../auth/audit.js';

/**
 * Creates the platform router with an optional audit function override for testing.
 * @param {Function} [auditFn] - Optional audit function override. Defaults to imported audit.
 * @returns {express.Router}
 */
export function createPlatformRouter(auditFn = audit) {
  console.log('[DEBUG createPlatformRouter] auditFn.toString().includes("mock"):', auditFn.toString().includes('mock'), 'auditFn.name:', auditFn.name);
  const router = express.Router();
  router.use(requireV1Auth, requirePlatformSuperAdmin);

  /* ------------------------------- helpers ------------------------------- */

  function fail(res, err) {
    if (err instanceof Error && err.message.includes('unique')) {
      return apiError(res, 409, 'CONFLICT', 'email already exists in this tenant');
    }
    console.error('platform companies error:', err?.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }

  const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;

  /* ---------------------------- GET /companies ---------------------------- */

  router.get('/companies', async (req, res) => {
    try {
      const { rows } = await req.db.query(
        `SELECT t.id, t.name, t.slug, t.status, t.created_at,
                (SELECT count(*) FROM brands b WHERE b.tenant_id = t.id)::int AS brands_count,
                (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int AS users_count
           FROM tenants t
          ORDER BY t.created_at DESC`
      );
      return res.json({ data: rows });
    } catch (err) {
      console.error('platform companies list failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* --------------------------- POST /companies --------------------------- */

  router.post('/companies', async (req, res) => {
    const { name, slug, adminEmail, adminName, adminPassword } = req.body ?? {};

    if (!name || !slug || !adminEmail || !adminName || !adminPassword) {
      return apiError(res, 422, 'VALIDATION_ERROR', 'name, slug, adminEmail, adminName, adminPassword are required');
    }
    if (!isEmail(adminEmail)) {
      return apiError(res, 422, 'VALIDATION_ERROR', 'invalid email format');
    }
    if (String(adminPassword).length < 8) {
      return apiError(res, 422, 'VALIDATION_ERROR', 'adminPassword must be at least 8 characters');
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return apiError(res, 422, 'VALIDATION_ERROR', 'slug must be lowercase alphanumeric with hyphens only');
    }

    const client = await req.db.connect();
    try {
      await client.query('BEGIN');

      // Create tenant
      const { rows: [tenant] } = await client.query(
        `INSERT INTO tenants (name, slug, status) VALUES ($1,$2,'active') RETURNING id, name, slug, status, created_at`,
        [name, slug.toLowerCase()]
      );

      // Create first brand
      const { rows: [brand] } = await client.query(
        `INSERT INTO brands (tenant_id, name, slug, status) VALUES ($1,$2,$3,'active') RETURNING id, name, slug`,
        [tenant.id, name, 'main']
      );

      // Create default teams
      for (const t of ['Customer Service', 'Marketing', 'Management']) {
        await client.query(`INSERT INTO teams (tenant_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenant.id, t]);
      }

      // Create roles (seeded by migration, but ensure they exist for this tenant)
      const { rows: [adminRole] } = await client.query(
        `INSERT INTO roles (tenant_id, name, permissions) VALUES ($1,'Company Admin','["*"]'::jsonb)
         ON CONFLICT (tenant_id, name) DO UPDATE SET permissions = EXCLUDED.permissions
         RETURNING id`,
        [tenant.id]
      );

      // Create admin user
      const { rows: [admin] } = await client.query(
        `INSERT INTO users (tenant_id, email, name, password_hash, status)
         VALUES ($1,$2,$3,$4,'active') RETURNING id, email, name, status, created_at`,
        [tenant.id, String(adminEmail).toLowerCase().trim(), adminName, await hashPassword(adminPassword)]
      );

      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [admin.id, adminRole.id]
      );

      await client.query('COMMIT');

      auditFn({
        tenantId: tenant.id,
        actorUserId: req.v1.user.id,
        action: 'platform.company.create',
        objectType: 'tenant',
        objectId: tenant.id,
        ip: req.ip,
        metadata: { name: tenant.name, slug: tenant.slug, adminEmail: admin.email }
      });
      console.log('[DEBUG PLATFORM] auditFn called for create, caller: PLATFORM, auditFn.name:', auditFn.name);

      return res.status(201).json({
        data: {
          company: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, createdAt: tenant.created_at },
          brand: { id: brand.id, name: brand.name, slug: brand.slug, status: brand.status },
          admin: { id: admin.id, email: admin.email, name: admin.name, status: admin.status, createdAt: admin.created_at }
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      return fail(res, err);
    } finally {
      client.release();
    }
  });

  /* -------------------------- GET /companies/:id -------------------------- */

  router.get('/companies/:id', async (req, res) => {
    try {
      const { rows } = await req.db.query(
        `SELECT t.id, t.name, t.slug, t.status, t.created_at,
                (SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'status', b.status, 'createdAt', b.created_at))
                   FROM brands b WHERE b.tenant_id = t.id) AS brands,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users_count
           FROM tenants t
          WHERE t.id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'company not found');
      return res.json({ data: rows[0] });
    } catch (err) {
      console.error('platform company get failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ------------------------- PATCH /companies/:id ------------------------- */

  router.patch('/companies/:id', async (req, res) => {
  console.log('[DEBUG PLATFORM] PATCH /companies/:id reached, id:', req.params.id);
    const { name, slug } = req.body ?? {};
    if (!name && !slug) return apiError(res, 422, 'VALIDATION_ERROR', 'name or slug is required');
    if (slug && !/^[a-z0-9-]+$/.test(slug)) {
      return apiError(res, 422, 'VALIDATION_ERROR', 'slug must be lowercase alphanumeric with hyphens only');
    }

    try {
      const set = [];
      const params = [req.params.id];
      if (name) { set.push(`name = $${params.length + 1}`); params.push(name); }
      if (slug) { set.push(`slug = $${params.length + 1}`); params.push(slug.toLowerCase()); }
      if (!set.length) return apiError(res, 422, 'VALIDATION_ERROR', 'no valid fields to update');

      const { rows } = await req.db.query(
        `UPDATE tenants SET ${set.join(', ')} WHERE id = $1 RETURNING id, name, slug, status, created_at`,
        params
      );
      if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'company not found');

      auditFn({
        tenantId: rows[0].id,
        actorUserId: req.v1.user.id,
        action: 'platform.company.update',
        objectType: 'tenant',
        objectId: rows[0].id,
        ip: req.ip,
        metadata: { name: rows[0].name, slug: rows[0].slug }
      });
      console.log('[DEBUG PLATFORM] auditFn called for update');

      return res.json({ data: rows[0] });
    } catch (err) {
      if (err instanceof Error && err.message.includes('unique')) {
        return apiError(res, 409, 'CONFLICT', 'slug already exists');
      }
      console.error('platform company update failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ----------------------- POST /companies/:id/disable ---------------------- */

  router.post('/companies/:id/disable', async (req, res) => {
    try {
      const { rows } = await req.db.query(
        `UPDATE tenants SET status = 'disabled' WHERE id = $1 AND status = 'active' RETURNING id, name, slug, status`,
        [req.params.id]
      );
      if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'company not found or already disabled');

      // Revoke all sessions for users in this tenant
      await req.db.query(
        `UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`,
        [req.params.id]
      );

      auditFn({
        tenantId: rows[0].id,
        actorUserId: req.v1.user.id,
        action: 'platform.company.disable',
        objectType: 'tenant',
        objectId: rows[0].id,
        ip: req.ip,
        metadata: { name: rows[0].name, slug: rows[0].slug }
      });
      console.log('[DEBUG PLATFORM] auditFn called for disable');

      return res.json({ data: rows[0] });
    } catch (err) {
      console.error('platform company disable failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ------------------------ GET /platform/metrics ------------------------ */

  router.get('/metrics', async (req, res) => {
    try {
      const [companies, users, conversations, channels] = await Promise.all([
        req.db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM tenants`),
        req.db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM users`),
        req.db.query(`SELECT count(*)::int AS total FROM conversations`),
        req.db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM channels`)
      ]);

      return res.json({
        data: {
          companies: companies.rows[0],
          users: users.rows[0],
          conversations: conversations.rows[0],
          channels: channels.rows[0]
        }
      });
    } catch (err) {
      console.error('platform metrics failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  return router;
}