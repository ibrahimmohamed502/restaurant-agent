/**
 * R1 — brand grant administration API.
 *
 * Every route requires an explicit ability AND the caller must already hold the
 * scope they are delegating, so a Company Admin can only hand out brands they
 * can already reach. Company Admin can delegate specific brands or every brand
 * inside their own company, never across companies and never platform-wide.
 *
 * All mutations are audited by the service layer.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import {
  grantBrand, revokeBrand,
  grantAllBrandsInCompany, revokeAllBrandsInCompany,
  grantHistory, callerBrandScope, GrantError
} from '../../services/brandGrants.js';

export function createBrandGrantsRouter() {
  const router = express.Router();
  router.use(requireV1Auth);

  const fail = (res, err) => {
    if (err instanceof GrantError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  };

  // Who am I, and what can I see?
  router.get('/me', async (req, res) => {
    try {
      const scope = await callerBrandScope({
        tenantId: req.v1.tenantId,
        userId: req.v1.user.id
      });
      res.json({
        data: {
          tenantId: req.v1.tenantId,
          roles: req.v1.roles ?? [],
          isPlatformSuperAdmin: req.v1.isPlatformSuperAdmin === true,
          allBrandsInCompany: scope.allBrands,
          brandIds: scope.allBrands ? null : scope.brandIds
        }
      });
    } catch (err) { return fail(res, err); }
  });

  // Grant / revoke ONE brand.
  router.post('/users/:userId/brands/:brandId', requireAbility('brand.grant'), async (req, res) => {
    try {
      const out = await grantBrand({
        tenantId: req.v1.tenantId,
        actorUserId: req.v1.user.id,
        targetUserId: req.params.userId,
        brandId: req.params.brandId,
        reason: req.body?.reason ?? null
      });
      res.status(201).json({ data: out });
    } catch (err) { return fail(res, err); }
  });

  router.delete('/users/:userId/brands/:brandId', requireAbility('brand.revoke'), async (req, res) => {
    try {
      const out = await revokeBrand({
        tenantId: req.v1.tenantId,
        actorUserId: req.v1.user.id,
        targetUserId: req.params.userId,
        brandId: req.params.brandId
      });
      res.json({ data: out });
    } catch (err) { return fail(res, err); }
  });

  // Delegate / revoke EVERY brand inside this company (never cross-company).
  router.post('/users/:userId/brands/all', requireAbility('brand.grant_all'), async (req, res) => {
    try {
      const out = await grantAllBrandsInCompany({
        tenantId: req.v1.tenantId,
        actorUserId: req.v1.user.id,
        targetUserId: req.params.userId,
        reason: req.body?.reason ?? null
      });
      res.status(201).json({ data: out });
    } catch (err) { return fail(res, err); }
  });

  router.delete('/users/:userId/brands/all', requireAbility('brand.revoke_all'), async (req, res) => {
    try {
      const out = await revokeAllBrandsInCompany({
        tenantId: req.v1.tenantId,
        actorUserId: req.v1.user.id,
        targetUserId: req.params.userId
      });
      res.json({ data: out });
    } catch (err) { return fail(res, err); }
  });

  // Grant history, including revoked rows.
  router.get('/users/:userId/brands', requireAbility('brand.read'), async (req, res) => {
    try {
      const rows = await grantHistory({
        tenantId: req.v1.tenantId,
        targetUserId: req.params.userId
      });
      res.json({ data: rows });
    } catch (err) { return fail(res, err); }
  });

  return router;
}