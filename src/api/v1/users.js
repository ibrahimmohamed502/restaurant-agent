/**
 * Stage 5 — /api/v1 users (Team & Access).
 *
 * Reuses the EXACT same tenant-scoped, RBAC-guarded handlers as the legacy
 * dashboard router (Company Admin only), exposed under /api/v1 so the public
 * tunnel reaches them (the UI proxy owns /dashboard/* for the Next.js app).
 *
 * Tenant identity always comes from the authenticated session (req.auth).
 */
import express from 'express';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { listUsers, createUser, setUserStatus, setUserRoles } from '../../routes/users.js';

export function createUsersRouter() {
  const router = express.Router();
  const admin = requireRole('Company Admin');

  router.get('/users', requireAuth, admin, listUsers);
  router.post('/users', requireAuth, admin, createUser);
  router.post('/users/:id/status', requireAuth, admin, setUserStatus);
  router.post('/users/:id/roles', requireAuth, admin, setUserRoles);

  return router;
}
