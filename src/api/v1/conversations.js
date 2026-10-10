/**
 * Stage 5 — Unified Inbox read API (tenant-scoped, read-only).
 * Mirrors the existing Stage 3 dashboard conversation/detail queries so the SaaS
 * frontend can consume persisted conversations without a second data path.
 */
import express from 'express';
import { requireV1Auth } from './index.js';

export function createConversationsRouter({ pool }) {
  const router = express.Router();
  router.use(requireV1Auth);

  router.get('/', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.state, c.language, c.last_message_at,
                cu.display_name AS customer_name,
                ch.provider,
                (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
                (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at_ts
           FROM conversations c
           LEFT JOIN customers cu ON cu.id = c.customer_id
           LEFT JOIN channels ch ON ch.id = c.channel_id
          WHERE c.tenant_id = $1
          ORDER BY c.last_message_at DESC NULLS LAST
          LIMIT $2`,
        [req.v1.tenantId, limit]
      );
      return res.json({
        data: rows.map((r) => ({
          id: r.id,
          customerName: r.customer_name,
          provider: r.provider,
          state: r.state,
          language: r.language,
          messageCount: Number(r.message_count ?? 0),
          lastText: r.last_text,
          lastMessageAt: r.last_message_at_ts ?? r.last_message_at
        }))
      });
    } catch {
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'unexpected error' } });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { rows: [conv] } = await pool.query(
        `SELECT c.id, c.state, c.language, c.created_at,
                cu.display_name AS customer_name,
                ch.provider, ch.display_name AS channel_name
           FROM conversations c
           LEFT JOIN customers cu ON cu.id = c.customer_id
           LEFT JOIN channels ch ON ch.id = c.channel_id
          WHERE c.id = $1 AND c.tenant_id = $2`,
        [req.params.id, req.v1.tenantId]
      );
      if (!conv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'conversation not found' } });
      const { rows: messages } = await pool.query(
        `SELECT direction, sender_type, text, created_at, provider_ts
           FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 200`,
        [conv.id]
      );
      return res.json({
        data: {
          conversation: {
            id: conv.id,
            customerName: conv.customer_name,
            provider: conv.provider,
            channelName: conv.channel_name,
            state: conv.state,
            language: conv.language,
            createdAt: conv.created_at
          },
          messages: messages.map((m) => ({
            direction: m.direction,
            senderType: m.sender_type,
            text: m.text,
            createdAt: m.created_at ?? m.provider_ts
          }))
        }
      });
    } catch {
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'unexpected error' } });
    }
  });

  return router;
}
