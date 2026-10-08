import { pool } from '../db/pg.js';

/**
 * Stage 4.4.1 — Tenant/Brand-scoped AI Context Resolver (READ ONLY).
 *
 * Resolves, for a trusted routing context { tenantId, brandId }:
 *   - brand ownership validation (brand must belong to tenant)
 *   - the tenant+brand AI agent (ai_agents)
 *   - its AI configuration (ai_configs)
 *   - the tenant+brand structured knowledge (knowledge_sources → knowledge_documents.structured)
 *
 * Fail closed on every ambiguity/miss. NEVER falls back to knowledge.json,
 * LWC, another tenant, or another brand. No vector/pgvector use (4.4.1).
 *
 * Cache key ALWAYS contains BOTH tenantId and brandId. Failures are NOT cached.
 */

export class AiContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiContextError';
    this.code = code;
  }
}

export const AI_CONTEXT_ERRORS = {
  MISSING_TENANT_ID: 'MISSING_TENANT_ID',
  MISSING_BRAND_ID: 'MISSING_BRAND_ID',
  BRAND_NOT_IN_TENANT: 'BRAND_NOT_IN_TENANT',
  AI_AGENT_MISSING: 'AI_AGENT_MISSING',
  AI_AGENT_AMBIGUOUS: 'AI_AGENT_AMBIGUOUS',
  AI_CONFIG_MISSING: 'AI_CONFIG_MISSING',
  AI_CONFIG_AMBIGUOUS: 'AI_CONFIG_AMBIGUOUS',
  KNOWLEDGE_SOURCE_MISSING: 'KNOWLEDGE_SOURCE_MISSING',
  KNOWLEDGE_DOCUMENT_MISSING: 'KNOWLEDGE_DOCUMENT_MISSING',
  KNOWLEDGE_AMBIGUOUS: 'KNOWLEDGE_AMBIGUOUS',
  KNOWLEDGE_INVALID: 'KNOWLEDGE_INVALID'
};

const contextCache = new Map(); // `${tenantId}|${brandId}` -> resolved context (successes only)

export function clearAiContextCache() {
  contextCache.clear();
}

/**
 * @param {{tenantId?: string, brandId?: string}} ctx trusted routing context
 * @param {{db?: object}} [opts] injectable db for tests (defaults to shared pool)
 */
export async function resolveAiContext(ctx, { db = pool } = {}) {
  const tenantId = ctx?.tenantId;
  const brandId = ctx?.brandId;
  if (!tenantId) throw new AiContextError(AI_CONTEXT_ERRORS.MISSING_TENANT_ID, 'ctx.tenantId is required');
  if (!brandId) throw new AiContextError(AI_CONTEXT_ERRORS.MISSING_BRAND_ID, 'ctx.brandId is required');

  const key = `${tenantId}|${brandId}`;
  if (contextCache.has(key)) return contextCache.get(key);

  const resolved = await loadScoped(ctx, db); // throws on any problem — failures NOT cached
  contextCache.set(key, resolved);
  return resolved;
}

async function loadScoped({ tenantId, brandId }, db) {
  // 1) Brand ownership: brand must belong to this tenant. Do not reveal cross-tenant existence.
  const brand = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2 LIMIT 2`,
    [brandId, tenantId]
  );
  if (!brand.rows[0]) {
    throw new AiContextError(AI_CONTEXT_ERRORS.BRAND_NOT_IN_TENANT, 'brand not found for tenant');
  }

  // 2) AI agent: exactly one active agent for (tenant, brand)
  const agents = await db.query(
    `SELECT id, name FROM ai_agents WHERE tenant_id = $1 AND brand_id = $2 AND is_active = true`,
    [tenantId, brandId]
  );
  if (agents.rows.length === 0) throw new AiContextError(AI_CONTEXT_ERRORS.AI_AGENT_MISSING, 'no active AI agent for tenant/brand');
  if (agents.rows.length > 1) throw new AiContextError(AI_CONTEXT_ERRORS.AI_AGENT_AMBIGUOUS, 'multiple active AI agents for tenant/brand');
  const agent = agents.rows[0];

  // 3) AI config: exactly one config for (tenant, agent)
  const configs = await db.query(
    `SELECT tone, languages, system_prompt_extra, rules, working_hours, channel_behavior
     FROM ai_configs WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, agent.id]
  );
  if (configs.rows.length === 0) throw new AiContextError(AI_CONTEXT_ERRORS.AI_CONFIG_MISSING, 'no AI config for agent');
  if (configs.rows.length > 1) throw new AiContextError(AI_CONTEXT_ERRORS.AI_CONFIG_AMBIGUOUS, 'multiple AI configs for agent');

  // 4) Knowledge: sources for (tenant, brand) → documents (tenant-scoped, source-scoped)
  const sources = await db.query(
    `SELECT id FROM knowledge_sources WHERE tenant_id = $1 AND brand_id = $2`,
    [tenantId, brandId]
  );
  if (sources.rows.length === 0) throw new AiContextError(AI_CONTEXT_ERRORS.KNOWLEDGE_SOURCE_MISSING, 'no knowledge source for tenant/brand');

  const docs = await db.query(
    `SELECT d.id, d.structured
     FROM knowledge_documents d
     JOIN knowledge_sources s ON s.id = d.source_id
     WHERE d.tenant_id = $1 AND s.tenant_id = $1 AND s.brand_id = $2`,
    [tenantId, brandId]
  );
  if (docs.rows.length === 0) throw new AiContextError(AI_CONTEXT_ERRORS.KNOWLEDGE_DOCUMENT_MISSING, 'no knowledge document for tenant/brand');
  if (docs.rows.length > 1) throw new AiContextError(AI_CONTEXT_ERRORS.KNOWLEDGE_AMBIGUOUS, 'multiple knowledge documents for tenant/brand — refusing arbitrary choice');

  const knowledge = docs.rows[0].structured;
  if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge) || Object.keys(knowledge).length === 0) {
    throw new AiContextError(AI_CONTEXT_ERRORS.KNOWLEDGE_INVALID, 'knowledge.structured missing or invalid');
  }

  return {
    tenantId,
    brandId,
    agentId: agent.id,
    agentName: agent.name,
    config: configs.rows[0],
    knowledge
  };
}
