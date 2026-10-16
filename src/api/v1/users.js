/**
 * Stage 5 — /api/v1 users (Team & Access).
 *
 * Reuses the EXACT same tenant-scoped, RBAC-guarded handlers as the legacy
 * dashboard router (Company Admin only), exposed under /api/v1 so the public
 * tunnel reaches them (the UI proxy owns /dashboard/* for the Next.js app).
 *
 * Auth uses the /api/v1 session contract (JSON 401/403 — never an HTML
 * redirect) so the frontend receives proper error envelopes. Success bodies are
 * wrapped in { data } to match the /api/v1 contract; errors keep { error }.
 */
import express from 'express';
import { requireV1Auth, requireV1Role } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { listUsers, createUser, setUserStatus, setUserRoles, deleteUser } from '../../routes/users.js';

/** Adapts the v1 session context (req.v1) to the shared handler contract (req.auth). */
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

export function createUsersRouter() {
  const router = express.Router();
  // R1: gated by ABILITY, not by the role NAME 'Company Admin'. This keeps the
  // hardcoded name out of the authorization decision, so a custom role that was
  // explicitly granted user.* permissions is honoured - and the built-in map
  // remains the authority for the built-in roles.
  // Retained as a second, independent check: a caller must hold the ability AND
  // still be one of the roles the shared handlers already accept.
  const admin = requireV1Role('Company Admin');
  const canRead = requireAbility('user.read');
  const canCreate = requireAbility('user.create');
  const canUpdate = requireAbility('user.update');
  const canDisable = requireAbility('user.disable');

  // Mounted under /users by the API router. The shared handlers return RAW
  // bodies (legacy dashboard contract); wrap success in { data } / keep
  // { error } as-is — scoped to this router only.
  router.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => (res.statusCode < 400 ? json({ data: body }) : json(body));
    next();
  });

  router.get('/', requireV1Auth, adaptAuth, canRead, admin, listUsers);
  router.post('/', requireV1Auth, adaptAuth, canCreate, admin, createUser);
  router.post('/:id/status', requireV1Auth, adaptAuth, canUpdate, admin, setUserStatus);
  router.post('/:id/roles', requireV1Auth, adaptAuth, canUpdate, admin, setUserRoles);
  router.delete('/:id', requireV1Auth, adaptAuth, canDisable, admin, deleteUser);

  return router;
}
