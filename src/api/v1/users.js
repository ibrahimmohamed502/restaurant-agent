/**
 * Stage 5 — /api/v1 users (Team & Access).
 *
 * Reuses the EXACT same tenant-scoped, RBAC-guarded handlers as the legacy
 * dashboard router (Company Admin only), exposed under /api/v1 so the public
 * tunnel reaches them (the UI proxy owns /dashboard/* for the Next.js app).
 *
 * Auth uses the /api/v1 session contract (JSON 401/403 — never an HTML
 * redirect) so the frontend receives proper error envelopes.
 */
import express from 'express';
import { requireV1Auth, requireV1Role } from './index.js';
import { listUsers, createUser, setUserStatus, setUserRoles } from '../../routes/users.js';

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
  const admin = requireV1Role('Company Admin');

  router.get('/users', requireV1Auth, adaptAuth, admin, listUsers);
  router.post('/users', requireV1Auth, adaptAuth, admin, createUser);
  router.post('/users/:id/status', requireV1Auth, adaptAuth, admin, setUserStatus);
  router.post('/users/:id/roles', requireV1Auth, adaptAuth, admin, setUserRoles);

  return router;
}
