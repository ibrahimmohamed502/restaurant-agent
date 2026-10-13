/**
 * Stage 8 Batch 1 — Company Admin API.
 *
 * Company Admin manages their own company settings, brands, users, and integrations.
 * All endpoints are tenant-scoped via req.v1.tenantId from the session.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility, isCompanyAdmin } from './stage7-rbac.js';
import { pool } from '../../db/pg.js';
import { hashPassword } from '../../auth/passwords.js';
import { audit } from '../../auth/audit.js';

const router = express.Router();
router.use(requireV1Auth);

/* ---------------------------- GET /company ---------------------------- */

router.get('/company', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.slug, t.status, t.created_at,
              (SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'slug', b.slug, 'status', b.status, 'createdAt', b.created_at))
                 FROM brands b WHERE b.tenant_id = t.id) AS brands
         FROM tenants t
        WHERE t.id = $1`,
      [req.v1.tenantId]
    );
    if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'company not found');
    return res.json({ data: rows[0] });
  } catch (err) {
    console.error('company get failed:', err.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }
});

/* ------------------------- PATCH /company ---------------------------- */

router.patch('/company', requireAbility('company.update'), async (req, res) => {
  const { name, slug, timezone, locale } = req.body ?? {};
  if (!name && !slug && !timezone && !locale) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'no valid fields to update');
  }
  if (slug && !/^[a-z0-9-]+$/.test(slug)) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'slug must be lowercase alphanumeric with hyphens only');
  }

  try {
    const set = ['updated_at = now()'];
    const params = [req.v1.tenantId];
    if (name) { set.push(`name = $${params.length + 1}`); params.push(name); }
    if (slug) { set.push(`slug = $${params.length + 1}`); params.push(slug.toLowerCase()); }
    if (timezone) { set.push(`timezone = $${params.length + 1}`); params.push(timezone); }
    if (locale) { set.push(`locale = $${params.length + 1}`); params.push(locale); }

    const { rows } = await pool.query(
      `UPDATE tenants SET ${set.join(', ')} WHERE id = $1 RETURNING id, name, slug, status, created_at`,
      params
    );
    if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'company not found');

    audit({
      tenantId: req.v1.tenantId,
      actorUserId: req.v1.user.id,
      action: 'company.update',
      objectType: 'tenant',
      objectId: req.v1.tenantId,
      ip: req.ip,
      metadata: { name: rows[0].name, slug: rows[0].slug }
    });

    return res.json({ data: rows[0] });
  } catch (err) {
    if (err instanceof Error && err.message.includes('unique')) {
      return apiError(res, 409, 'CONFLICT', 'slug already exists');
    }
    console.error('company update failed:', err.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }
});

/* ---------------------------- GET /brands ---------------------------- */

router.get('/brands', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, created_at
         FROM brands
        WHERE tenant_id = $1
        ORDER BY created_at ASC`,
      [req.v1.tenantId]
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error('brands list failed:', err.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }
});

/* --------------------------- POST /brands ---------------------------- */

router.post('/brands', requireAbility('brand.create'), async (req, res) => {
  const { name, slug, defaultLanguage } = req.body ?? {};
  if (!name || !slug) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'name and slug are required');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'slug must be lowercase alphanumeric with hyphens only');
  }

  try {
    const { rows: [brand] } = await pool.query(
      `INSERT INTO brands (tenant_id, name, slug, status, default_language)
       VALUES ($1,$2,'active',$3) RETURNING id, name, slug, status, created_at`,
      [req.v1.tenantId, name, slug.toLowerCase(), defaultLanguage || 'ar']
    );

    audit({
      tenantId: req.v1.tenantId,
      actorUserId: req.v1.user.id,
      action: 'brand.create',
      objectType: 'brand',
      objectId: brand.id,
      ip: req.ip,
      metadata: { name: brand.name, slug: brand.slug }
    });

    return res.status(201).json({ data: brand });
  } catch (err) {
    if (err instanceof Error && err.message.includes('unique')) {
      return apiError(res, 409, 'CONFLICT', 'slug already exists in this company');
    }
    console.error('brand create failed:', err.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }
});

/* -------------------------- PATCH /brands/:id ------------------------- */

router.patch('/brands/:id', requireAbility('brand.update'), async (req, res) => {
  const { name, slug, status, defaultLanguage } = req.body ?? {};
  if (!name && !slug && !status && !defaultLanguage) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'no valid fields to update');
  }
  if (slug && !/^[a-z0-9-]+$/.test(slug)) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'slug must be lowercase alphanumeric with hyphens only');
  }
  if (status && !['active', 'disabled'].includes(status)) {
    return apiError(res, 422, 'VALIDATION_ERROR', 'status must be active or disabled');
  }

  try {
    const set = [];
    const params = [req.params.id, req.v1.tenantId];
    if (name) { set.push(`name = $${params.length + 1}`); params.push(name); }
    if (slug) { set.push(`slug = $${params.length + 1}`); params.push(slug.toLowerCase()); }
    if (status) { set.push(`status = $${params.length + 1}`); params.push(status); }
    if (defaultLanguage) { set.push(`default_language = $${params.length + 1}`); params.push(defaultLanguage); }

    const { rows } = await pool.query(
      `UPDATE brands SET ${set.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id, name, slug, status, created_at`,
      params
    );
    if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'brand not found');

    audit({
      tenantId: req.v1.tenantId,
      actorUserId: req.v1.user.id,
      action: 'brand.update',
      objectType: 'brand',
      objectId: rows[0].id,
      ip: req.ip,
      metadata: { name: rows[0].name, slug: rows[0].slug, status: rows[0].status }
    });

    return res.json({ data: rows[0] });
  } catch (err) {
    if (err instanceof Error && err.message.includes('unique')) {
      return apiError(res, 409, 'CONFLICT', 'slug already exists in this company');
    }
    console.error('brand update failed:', err.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }
});

/* ------------------------ POST /brands/:id/disable -------------------- */

router.post('/brands/:id/disable', requireAbility('brand.disable'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE brands SET status = 'disabled' WHERE id = $1 AND tenant_id = $2 AND status = 'active'
       RETURNING id, name, slug, status`,
      [req.params.id, req.v1.tenantId]
    );
    if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'brand not found or already disabled');

    // Disable associated channels (safe archive)
    await pool.query(
      `UPDATE channels SET status = 'inactive' WHERE brand_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [req.params.id, req.v1.tenantId]
    );

    audit({
      tenantId: req.v1.tenantId,
      actorUserId: req.v1.user.id,
      action: 'brand.disable',
      objectType: 'brand',
      objectId: rows[0].id,
      ip: req.ip,
      metadata: { name: rows[0].name, slug: rows[0].slug }
    });

    return res.json({ data: rows[0] });
  } catch (err) {
    console.error('brand disable failed:', err.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }
});

export function createCompaniesRouter() {
  return router;
}