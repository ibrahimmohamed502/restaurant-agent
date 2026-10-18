/**
 * A1 - Custom Roles & Permissions routes.
 *
 * Every handler is gated by an ability, then re-checked against the caller's
 * COMPANY. Two independent gates, because the ability map decides "may this
 * KIND of person do this" and the tenant check decides "over WHOSE data".
 *
 * Nothing here grants a role, a brand or a privilege. Role assignment stays
 * behind user.update, which is a separate ability on the same role.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { can } from '../../auth/abilities.js';
import {
  listRoles, createRole, updateRole, setRoleStatus, deleteRole, getRoleUsers,
  RoleError, ROLE_ERRORS
} from '../../services/roles.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function adaptAuth(req, _res, next) {
  if (req.v1) {
    req.auth = {
      tenantId: req.v1.tenantId,
      user: { id: req.v1.user?.id, email: req.v1.user?.email, name: req.v1.user?.name },
      roles: req.v1.roles || [],
      sessionId: null
    };
  }
  next();
}

export function createRolesRouter() {
  const router = express.Router();
  const fail = (res, err) => {
    if (err instanceof RoleError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return res.status(500).json({ error: { code: 'ROLE_INTERNAL', message: 'role operation failed' } });
  };
  const uuidOr404 = (value) => {
    if (!UUID.test(String(value ?? ''))) throw new RoleError(ROLE_ERRORS.NOT_FOUND, 404, 'not found');
    return value;
  };
  const scope = (req, res) => {
    const tenantId = req.auth?.tenantId;
    const actorUserId = req.auth?.user?.id;
    if (!tenantId || !actorUserId) {
      res.status(403).json({ error: { code: ROLE_ERRORS.FORBIDDEN, message: 'company scope is required' } });
      return null;
    }
    return { tenantId, actorUserId };
  };

  router.use(requireV1Auth, adaptAuth);

  // ---- read ---------------------------------------------------------------
  router.get('/', requireAbility('role.read'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    try {
      const roles = await listRoles({ tenantId: ctx.tenantId, db: req.db });
      return res.json({ data: { roles } });
    } catch (e) { return fail(res, e); }
  });

  router.get('/:roleId/users', requireAbility('role.read'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    try {
      uuidOr404(req.params.roleId);
      const users = await getRoleUsers({ tenantId: ctx.tenantId, roleId: req.params.roleId, db: req.db });
      return res.json({ data: { users } });
    } catch (e) { return fail(res, e); }
  });

  // ---- write --------------------------------------------------------------
  router.post('/', requireAbility('role.create'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    try {
      const role = await createRole({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorRoles: req.v1?.roles ?? [],
        actorCustomAbilities: req.v1?.customAbilities ?? [],
        name: req.body?.name,
        permissions: req.body?.permissions,
        db: req.db
      });
      return res.status(201).json({ data: { role } });
    } catch (e) { return fail(res, e); }
  });

  router.patch('/:roleId', requireAbility('role.update'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    try {
      uuidOr404(req.params.roleId);
      const role = await updateRole({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorRoles: req.v1?.roles ?? [],
        actorCustomAbilities: req.v1?.customAbilities ?? [],
        roleId: req.params.roleId,
        name: req.body?.name,
        permissions: req.body?.permissions,
        db: req.db
      });
      return res.json({ data: { role } });
    } catch (e) { return fail(res, e); }
  });

  router.post('/:roleId/status', requireAbility('role.disable'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    try {
      uuidOr404(req.params.roleId);
      const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
      const role = await setRoleStatus({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        roleId: req.params.roleId,
        status,
        db: req.db
      });
      return res.json({ data: { role } });
    } catch (e) { return fail(res, e); }
  });

  router.delete('/:roleId', requireAbility('role.delete'), async (req, res) => {
    const ctx = scope(req, res);
    if (!ctx) return;
    try {
      uuidOr404(req.params.roleId);
      const role = await deleteRole({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        roleId: req.params.roleId,
        db: req.db
      });
      return res.json({ data: { role } });
    } catch (e) { return fail(res, e); }
  });

  return router;
}
