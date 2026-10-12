/**
 * Stage 7 — in-app notifications (reuses the existing `notifications` table).
 *
 * Deliberately SEPARATE from src/notify.js (staff email/webhook alerts), which
 * stays exactly as it was and is never replaced.
 *
 * Rules:
 *  - Recipients are ALWAYS resolved server-side and ALWAYS same-tenant.
 *  - `data` may carry ids/metadata for navigation, but NEVER customer message
 *    bodies or internal note content.
 *  - Writes are fire-and-forget and can never break a conversation transition.
 */
import { pool } from '../db/pg.js';
import { HANDLING_ROLES } from './handoff.js';

export const NOTIFICATION_TYPES = Object.freeze({
  HANDOFF_REQUESTED: 'handoff.requested',
  ASSIGNED: 'conversation.assigned',
  REASSIGNED: 'conversation.reassigned',
  UNASSIGNED: 'conversation.unassigned',
  RESOLVED: 'conversation.resolved',
  AI_RESUMED: 'conversation.ai_resumed',
  NOTE_ADDED: 'conversation.note_added',
  HUMAN_REPLY_FAILED: 'conversation.human_reply_failed'
});

/** Deduped list of notifications for the signed-in user (tenant-scoped). */
export async function listNotifications({ tenantId, userId, unreadOnly = false, limit = 50, db = pool }) {
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await db.query(
    `SELECT id, type, title, body, data, read_at, created_at
       FROM notifications
      WHERE tenant_id = $1 AND user_id = $2
        AND ($3::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC
      LIMIT $4`,
    [tenantId, userId, Boolean(unreadOnly), bounded]
  );
  return rows;
}

/** Unread counter for the topbar badge. */
export async function countUnreadNotifications({ tenantId, userId, db = pool }) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS unread
       FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [tenantId, userId]
  );
  return rows[0]?.unread ?? 0;
}

/** Mark one notification read. Only the OWNER can do this. */
export async function markNotificationRead({ tenantId, userId, notificationId, db = pool }) {
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = now()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND read_at IS NULL
      RETURNING id, read_at`,
    [notificationId, tenantId, userId]
  );
  return rows[0] ?? null;
}

/** Mark every unread notification read for the signed-in user. */
export async function markAllNotificationsRead({ tenantId, userId, db = pool }) {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [tenantId, userId]
  );
  return rowCount ?? 0;
}

/**
 * Active, eligible recipients for a handoff/assignment within one tenant.
 * When `teamId` is set, membership narrows the list; otherwise it is every
 * active user holding a handling role. NEVER crosses a tenant boundary.
 */
export async function resolveNotificationRecipients({ tenantId, teamId = null, db = pool }) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = $1
        AND u.status = 'active'
        AND r.name = ANY($2::text[])
        AND ($3::uuid IS NULL OR u.id IN (
              SELECT tm.user_id FROM team_members tm WHERE tm.team_id = $3::uuid
            ))
      ORDER BY u.id`,
    [tenantId, HANDLING_ROLES, teamId]
  );
  return rows.map((r) => r.id);
}

/**
 * Create one notification row per recipient (deduped, same-tenant only).
 * Fire-and-forget: callers never await failure.
 */
export async function createNotifications({ tenantId, userIds, type, title, body = null, data = {}, db = pool }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return 0;
  // One multi-row INSERT: VALUES ($1, $n, $2, $3, $n, $m), ...
  // tenant_id/type/title/body are shared; user_id and data are per row.
  const placeholders = ids
    .map((_, i) => `($1, $${i + 4}, $2, $3, $${i + 4 + ids.length}, $${i + 4 + ids.length * 2})`)
    .join(', ');
  const rowParams = [tenantId, type, String(title).slice(0, 200), body ? String(body).slice(0, 500) : null];
  ids.forEach((id) => {
    rowParams.push(id, JSON.stringify(data ?? {}));
  });
  try {
    await db.query(
      `INSERT INTO notifications (tenant_id, user_id, type, title, body, data)
       VALUES ${placeholders}`,
      rowParams
    );
    return ids.length;
  } catch (e) {
    console.error('stage7 notification write failed:', e?.message ?? 'error');
    return 0;
  }
}
