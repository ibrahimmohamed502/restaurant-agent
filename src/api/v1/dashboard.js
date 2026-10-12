/**
 * Stage 5 — dashboard summary API (tenant-scoped, read-only, real data only).
 *
 * Tenant identity ALWAYS comes from the authenticated session (req.v1.tenantId).
 * Every query is scoped to that tenant; no browser-supplied tenant_id is trusted.
 * Only operational counts/lists that already exist in the schema are exposed.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';

export function createDashboardRouter({ pool, getQueue = () => null }) {
  const router = express.Router();
  router.use(requireV1Auth);

  /** GET /api/v1/dashboard — executive summary for the session tenant. */
  router.get('/', async (req, res) => {
    const tenantId = req.v1.tenantId;
    try {
      const [kpi, conversations, knowledge, queueState] = await Promise.all([
        pool.query(
          `SELECT
             (SELECT count(*) FROM conversations WHERE tenant_id = $1)::int AS conversations,
             (SELECT count(*) FROM messages WHERE tenant_id = $1)::int AS messages,
             (SELECT count(*) FROM channels WHERE tenant_id = $1 AND status = 'active')::int AS active_channels,
             (SELECT count(*) FROM escalations WHERE tenant_id = $1)::int AS escalations,
             (SELECT count(*) FROM conversations WHERE tenant_id = $1
                AND state IN ('HUMAN_REQUIRED','QUEUED'))::int AS needs_human,
             (SELECT count(*) FROM conversations WHERE tenant_id = $1
                AND state IN ('ASSIGNED','HUMAN_ACTIVE'))::int AS human_active,
             (SELECT count(*) FROM conversations WHERE tenant_id = $1
                AND assigned_user_id = $2 AND state IN ('ASSIGNED','HUMAN_ACTIVE'))::int AS assigned_to_me`,
          [tenantId, req.v1.user.id]
        ),
        pool.query(
          `SELECT c.id, c.state, c.language, c.last_message_at,
                  cu.display_name AS customer_name,
                  ch.provider,
                  (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
                  (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at_ts
             FROM conversations c
             LEFT JOIN customers cu ON cu.id = c.customer_id
             LEFT JOIN channels ch ON ch.id = c.channel_id
            WHERE c.tenant_id = $1
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT 6`,
          [tenantId]
        ),
        pool.query(
          `SELECT s.brand_id, d.version, d.updated_at
             FROM knowledge_documents d
             JOIN knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND d.status = 'published'
            ORDER BY d.updated_at DESC
            LIMIT 1`,
          [tenantId]
        ),
        readQueueState(getQueue)
      ]);

      const activeAgent = await pool.query(
        `SELECT a.id, a.name, a.is_active
           FROM ai_agents a
          WHERE a.tenant_id = $1
          ORDER BY a.created_at ASC
          LIMIT 2`,
        [tenantId]
      );

        // Stage 7 counters (unread notifications for the signed-in user).
        const unread = await pool.query(
          `SELECT count(*)::int AS unread
             FROM notifications
            WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
          [tenantId, req.v1.user.id]
        );

      return res.json({
        data: {
          kpis: { ...kpi.rows[0], unread_notifications: unread.rows[0]?.unread ?? 0 },
          conversations: conversations.rows.map((r) => ({
            id: r.id,
            customerName: r.customer_name,
            provider: r.provider,
            state: r.state,
            language: r.language,
            lastText: r.last_text,
            lastMessageAt: r.last_message_at_ts ?? r.last_message_at
          })),
          knowledge: knowledge.rows[0]
            ? { brandId: knowledge.rows[0].brand_id, version: knowledge.rows[0].version, publishedAt: knowledge.rows[0].updated_at }
            : { brandId: null, version: null, publishedAt: null },
          aiAgent: activeAgent.rows[0] ?? null,
          queue: queueState
        }
      });
    } catch (err) {
      console.error('api/v1 dashboard failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  return router;
}

/** Queue state is reported only when a queue instance is actually available. */
async function readQueueState(getQueue) {
  const queue = typeof getQueue === 'function' ? getQueue() : null;
  if (!queue) return { available: false };
  try {
    const counts = await queue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
    return { available: true, ...counts };
  } catch {
    return { available: false };
  }
}
