/**
 * Stage 7 — in-app notifications API.
 *
 * A user may ONLY ever see their own notifications (tenant + user scoping).
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead
} from '../../services/notifications.js';

export function createNotificationsRouter() {
  const router = express.Router();
  router.use(requireV1Auth, requireAbility('notification.read'));

  /** GET /notifications?unreadOnly=1&limit=50 */
  router.get('/', async (req, res, next) => {
    try {
      const [rows, unread] = await Promise.all([
        listNotifications({
          tenantId: req.v1.tenantId,
          userId: req.v1.user.id,
          unreadOnly: req.query.unreadOnly === '1' || req.query.unreadOnly === 'true',
          limit: Number(req.query.limit) || 50
        }),
        countUnreadNotifications({ tenantId: req.v1.tenantId, userId: req.v1.user.id })
      ]);
      return res.json({
        data: {
          unread,
          items: rows.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            data: n.data ?? {},
            readAt: n.read_at,
            createdAt: n.created_at
          }))
        }
      });
    } catch (err) { return next(err); }
  });

  /** POST /notifications/:id/read */
  router.post('/:id/read', async (req, res, next) => {
    try {
      const updated = await markNotificationRead({
        tenantId: req.v1.tenantId, userId: req.v1.user.id, notificationId: req.params.id
      });
      if (!updated) return apiError(res, 404, 'NOT_FOUND', 'notification not found');
      return res.json({ data: { id: updated.id, readAt: updated.read_at } });
    } catch (err) { return next(err); }
  });

  /** POST /notifications/read-all */
  router.post('/read-all', async (req, res, next) => {
    try {
      const marked = await markAllNotificationsRead({ tenantId: req.v1.tenantId, userId: req.v1.user.id });
      return res.json({ data: { marked } });
    } catch (err) { return next(err); }
  });

  return router;
}
