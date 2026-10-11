/**
 * Stage 6 Batch 3A — per-tenant AI config (tone/languages/rules/hours/custom).
 *
 * RBAC is server-authoritative: Company Admin writes, every other authenticated
 * role reads. No escalation/handoff fields — those belong to Stage 7.
 * The retrieval threshold stays backend-managed and is exposed read-only.
 */
import express from 'express';
import { requireV1Auth, requireV1Role } from './index.js';

export const AI_TONES = ['professional', 'friendly', 'kuwaiti', 'custom'];
export const AI_LANGUAGES = ['ar', 'en'];
/** Backend-managed safety limits — never editable from the UI. */
export const AI_FALLBACK_POLICY = {
  minSimilarity: Number(process.env.KNOWLEDGE_RETRIEVAL_MIN_SCORE || 0.3),
  note: 'backend-managed — retrieval below this similarity falls back to a safe reply'
};

export function createAiRouter() {
  const router = express.Router();
  const admin = requireV1Role('Company Admin');

  /** Resolve (never create) the tenant's active agent + its config row. */
  async function loadConfig(db, tenantId) {
    const { rows: [agent] } = await db.query(
      `SELECT id, name, brand_id FROM ai_agents WHERE tenant_id = $1 AND is_active ORDER BY created_at ASC LIMIT 1`,
      [tenantId]
    );
    if (!agent) return null;
    const { rows: [cfg] } = await db.query(
      `SELECT tone, languages, rules, working_hours, channel_behavior, system_prompt_extra, updated_at
         FROM ai_configs WHERE agent_id = $1`,
      [agent.id]
    );
    return { agent, cfg: cfg ?? null };
  }

  function shape(tenant, cfg) {
    return {
      agentName: tenant.agent.name,
      brandId: tenant.agent.brand_id,
      tone: cfg?.tone ?? 'professional',
      languages: cfg?.languages ?? ['ar', 'en'],
      rules: cfg?.rules ?? {},
      workingHours: cfg?.working_hours ?? {},
      customInstructions: cfg?.system_prompt_extra ?? '',
      updatedAt: cfg?.updated_at ?? null,
      fallbackPolicy: AI_FALLBACK_POLICY
    };
  }

  router.get('/config', requireV1Auth, async (req, res, next) => {
    try {
      const loaded = await loadConfig(req.db ?? req.v1.db, req.v1.tenantId);
      if (!loaded) return res.json({ data: null });
      return res.json({ data: shape(loaded, loaded.cfg) });
    } catch (err) { next(err); }
  });

  router.put('/config', requireV1Auth, admin, async (req, res, next) => {
    try {
      const { tone, languages, rules, workingHours, customInstructions } = req.body ?? {};
      if (!AI_TONES.includes(tone)) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: `tone must be one of ${AI_TONES.join(', ')}` } });
      if (!Array.isArray(languages) || !languages.every((l) => AI_LANGUAGES.includes(l)) || !languages.length) {
        return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'languages must be a non-empty subset of ar, en' } });
      }
      const loaded = await loadConfig(req.db ?? req.v1.db, req.v1.tenantId);
      if (!loaded) return res.status(404).json({ error: { code: 'NO_AGENT', message: 'no active AI agent for this tenant' } });

      // auto-provision the config row on first save
      const updated = loaded.cfg
        ? await req.db.query(
            `UPDATE ai_configs SET tone=$1, languages=$2, rules=$3, working_hours=$4, system_prompt_extra=$5, updated_by=$6, updated_at=now()
              WHERE agent_id=$7 RETURNING tone, languages, rules, working_hours, channel_behavior, system_prompt_extra, updated_at`,
            [tone, JSON.stringify(languages), JSON.stringify(rules ?? {}), JSON.stringify(workingHours ?? {}), String(customInstructions ?? '').slice(0, 4000), req.v1.user.id, loaded.agent.id]
          )
        : await req.db.query(
            `INSERT INTO ai_configs (tenant_id, agent_id, tone, languages, rules, working_hours, system_prompt_extra, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING tone, languages, rules, working_hours, channel_behavior, system_prompt_extra, updated_at`,
            [req.v1.tenantId, loaded.agent.id, tone, JSON.stringify(languages), JSON.stringify(rules ?? {}), JSON.stringify(workingHours ?? {}), String(customInstructions ?? '').slice(0, 4000), req.v1.user.id]
          );
      return res.json({ data: shape({ agent: loaded.agent }, updated.rows[0]) });
    } catch (err) { next(err); }
  });

  /**
   * Reply sources for admin debugging (Batch 3A): resolves the stored
   * references against the CURRENT published knowledge — never duplicates it.
   */
  router.get('/reply-sources', requireV1Auth, async (req, res, next) => {
    try {
      const { messageId } = req.query;
      if (!messageId) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'messageId is required' } });
      const { rows } = await req.db.query(
        `SELECT s.id, s.intent, s.retrieval, s.confidence, s.chunk_refs, s.fact_refs,
                s.fallback_used, s.created_at, iv.version AS knowledge_version, iv.status AS index_status
           FROM knowledge_reply_sources s
           LEFT JOIN knowledge_index_versions iv ON iv.id = s.index_version_id
          WHERE s.message_id = $1 AND s.tenant_id = $2`,
        [messageId, req.v1.tenantId]
      );
      // resolve each referenced chunk against the live chunk row (no stored copy)
      const ids = rows.flatMap((r) => (r.chunk_refs ?? []).map((c) => c.id));
      let chunkMap = new Map();
      if (ids.length) {
        const { rows: chunks } = await req.db.query(
          `SELECT id, content, metadata FROM knowledge_chunks WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
          [ids, req.v1.tenantId]
        );
        chunkMap = new Map(chunks.map((c) => [c.id, c]));
      }
      const data = rows.map((r) => ({
        id: r.id,
        intent: r.intent,
        retrieval: r.retrieval,
        confidence: Number(r.confidence),
        fallbackUsed: r.fallback_used,
        knowledgeVersion: r.knowledge_version,
        indexStatus: r.index_status,
        createdAt: r.created_at,
        sources: [
          ...(r.chunk_refs ?? []).map((c) => {
            const live = chunkMap.get(c.id);
            return {
              type: 'chunk',
              id: c.id,
              section: live?.metadata?.section ?? c.section ?? null,
              entityKey: live?.metadata?.entityKey ?? c.entityKey ?? null,
              score: c.score,
              content: live ? String(live.content).slice(0, 160) : null, // bounded preview
              resolved: Boolean(live)
            };
          }),
          ...(r.fact_refs ?? []).map((f) => ({ type: 'fact', ...f, content: null, resolved: true }))
        ]
      }));
      return res.json({ data });
    } catch (err) { next(err); }
  });

  return router;
}
