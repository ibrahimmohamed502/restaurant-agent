/**
 * Stage 5 — dashboard summary API (tenant-scoped, read-only, real data only).
 *
 * Tenant identity ALWAYS comes from the authenticated session (req.v1.tenantId).
 * Every query is scoped to that tenant AND to the caller's brand grants; no
 * browser-supplied tenant_id is trusted. Only operational counts/lists that
 * already exist in the schema are exposed.
 */
import express from 'express';
// requireAbilityInline is re-exported by index.js precisely so routers mounted
// from it do not have to import stage7-rbac.js (which imports index.js back).
import { requireV1Auth, requireAbilityInline, apiError } from './index.js';
import { brandScopeFromSession, brandScopeSql } from './brandAccess.js';

export function createDashboardRouter({ pool, getQueue = () => null }) {
  const router = express.Router();
  router.use(requireV1Auth);

  /** GET /api/v1/dashboard — executive summary for the session tenant. */
  router.get('/', requireAbilityInline('conversation.read'), async (req, res) => {
    const tenantId = req.v1.tenantId;
    try {
      // R1: every count and every preview row is brand-scoped inside the same
      // statement that reads it. Previously the whole tenant was summarised, so
      // a caller granted one brand saw every other brand's KPIs AND the last
      // customer message text in the preview list.
      const scope = brandScopeFromSession(req.v1);
      const bsCh = brandScopeSql('ch', { tenantWideParam: 1, brandIdsParam: 2 });
      const bsKs = brandScopeSql('ks', { tenantWideParam: 1, brandIdsParam: 2 });
      const bsA = brandScopeSql('a', { tenantWideParam: 1, brandIdsParam: 2 });

      const [kpi, conversations, knowledge, queueState] = await Promise.all([
        pool.query(
          `SELECT
             (SELECT count(*) FROM conversations c
                LEFT JOIN channels ch ON ch.id = c.channel_id
               WHERE c.tenant_id = $3 AND ${bsCh.sql})::int AS conversations,
             (SELECT count(*) FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                LEFT JOIN channels ch ON ch.id = c.channel_id
               WHERE m.tenant_id = $3 AND ${bsCh.sql})::int AS messages,
             (SELECT count(*) FROM channels ch
               WHERE ch.tenant_id = $3 AND ch.status = 'active' AND ${bsCh.sql})::int AS active_channels,
             (SELECT count(*) FROM escalations e
                JOIN conversations c ON c.id = e.conversation_id
                LEFT JOIN channels ch ON ch.id = c.channel_id
               WHERE e.tenant_id = $3 AND ${bsCh.sql})::int AS escalations`,
          [...bsCh.params(scope), tenantId]
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
            WHERE c.tenant_id = $3 AND ${bsCh.sql}
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT 6`,
          [...bsCh.params(scope), tenantId]
        ),
        pool.query(
          `SELECT ks.brand_id, d.version, d.updated_at
             FROM knowledge_documents d
             JOIN knowledge_sources ks ON ks.id = d.source_id
            WHERE d.tenant_id = $3 AND d.status = 'published' AND ${bsKs.sql}
            ORDER BY d.updated_at DESC
            LIMIT 1`,
          [...bsKs.params(scope), tenantId]
        ),
        readQueueState(getQueue)
      ]);

      const activeAgent = await pool.query(
        `SELECT a.id, a.name, a.is_active
           FROM ai_agents a
          WHERE a.tenant_id = $3 AND ${bsA.sql}
          ORDER BY a.created_at ASC
          LIMIT 2`,
        [...bsA.params(scope), tenantId]
      );

      return res.json({
        data: {
          kpis: kpi.rows[0],
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
