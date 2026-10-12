/**
 * Stage 7 — internal staff notes API (tenant-scoped, staff-only).
 *
 * Notes live in the existing `internal_notes` table. They are NEVER stored in
 * customer messages, so they can never reach the customer timeline, a provider
 * outbound payload, the AI context, or a notification body.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility, can } from './stage7-rbac.js';
import { audit } from '../../auth/audit.js';
import { pool } from '../../db/pg.js';

const BODY_MAX = 4000;

export function createNotesRouter() {
  // mergeParams so /:conversationId from the parent router is visible here.
  const router = express.Router({ mergeParams: true });
  router.use(requireV1Auth);

  /** The conversation must exist AND belong to the session tenant. */
  async function loadConversation(req, res) {
    const { rows } = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2`,
      [req.params.conversationId, req.v1.tenantId]
    );
    if (!rows[0]) {
      apiError(res, 404, 'NOT_FOUND', 'conversation not found');
      return null;
    }
    return rows[0];
  }

  /** GET /conversations/:conversationId/notes */
  router.get('/', requireAbility('note.read'), async (req, res, next) => {
    try {
      const conv = await loadConversation(req, res);
      if (!conv) return undefined;
      const { rows } = await pool.query(
        `SELECT n.id, n.body, n.created_at, n.user_id,
                u.name AS author_name, u.email AS author_email
           FROM internal_notes n
           LEFT JOIN users u ON u.id = n.user_id
          WHERE n.conversation_id = $1 AND n.tenant_id = $2
          ORDER BY n.created_at DESC
          LIMIT 200`,
        [req.params.conversationId, req.v1.tenantId]
      );
      return res.json({
        data: rows.map((r) => ({
          id: r.id,
          body: r.body,
          createdAt: r.created_at,
          author: { id: r.user_id, name: r.author_name, email: r.author_email },
          canDelete: r.user_id === req.v1.user.id || can(req.v1.roles, 'note.delete_any')
        }))
      });
    } catch (err) { return next(err); }
  });

  /** POST /conversations/:conversationId/notes */
  router.post('/', requireAbility('note.create'), async (req, res, next) => {
    try {
      const conv = await loadConversation(req, res);
      if (!conv) return undefined;
      const body = String(req.body?.body ?? '').trim();
      if (body.length < 1 || body.length > BODY_MAX) {
        return apiError(res, 422, 'VALIDATION_ERROR', `note body must be 1–${BODY_MAX} characters`);
      }
      const { rows: [note] } = await pool.query(
        `INSERT INTO internal_notes (tenant_id, conversation_id, user_id, body)
         VALUES ($1,$2,$3,$4) RETURNING id, body, created_at, user_id`,
        [req.v1.tenantId, req.params.conversationId, req.v1.user.id, body]
      );
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id, action: 'note.create',
        objectType: 'conversation', objectId: req.params.conversationId, ip: req.ip
        // NOTE: the note body is deliberately NOT written to the audit log.
      });
      return res.status(201).json({
        data: { id: note.id, body: note.body, createdAt: note.created_at, author: { id: note.user_id }, canDelete: true }
      });
    } catch (err) { return next(err); }
  });

  /** DELETE /conversations/:conversationId/notes/:noteId */
  router.delete('/:noteId', requireAbility('note.create'), async (req, res, next) => {
    try {
      const conv = await loadConversation(req, res);
      if (!conv) return undefined;
      const { rows } = await pool.query(
        `SELECT id, user_id FROM internal_notes WHERE id = $1 AND conversation_id = $2 AND tenant_id = $3`,
        [req.params.noteId, req.params.conversationId, req.v1.tenantId]
      );
      const note = rows[0];
      if (!note) return apiError(res, 404, 'NOT_FOUND', 'note not found');
      const own = note.user_id === req.v1.user.id;
      if (!own && !can(req.v1.roles, 'note.delete_any')) {
        return apiError(res, 403, 'FORBIDDEN', 'you can only delete your own notes');
      }
      await pool.query(`DELETE FROM internal_notes WHERE id = $1 AND tenant_id = $2`, [note.id, req.v1.tenantId]);
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id, action: 'note.delete',
        objectType: 'conversation', objectId: req.params.conversationId, ip: req.ip
      });
      return res.json({ data: { id: note.id, deleted: true } });
    } catch (err) { return next(err); }
  });

  return router;
}
