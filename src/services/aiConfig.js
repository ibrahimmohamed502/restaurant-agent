/**
 * Stage 6 Batch 3B — AI config loader (per tenant/brand/agent).
 * Tone, languages, rules, working hours and custom instructions that the
 * ACTIVE retrieval path feeds into generation.
 */
import { pool } from '../db/pg.js';

/**
 * @returns {Promise<{agentId, agentName, tone, languages, rules, workingHours, customInstructions} | null>}
 */
export async function loadAiConfig({ tenantId, db = pool }) {
  if (!tenantId) return null;
  const { rows: [agent] } = await db.query(
    `SELECT id, name FROM ai_agents WHERE tenant_id = $1 AND is_active ORDER BY created_at ASC LIMIT 1`,
    [tenantId]
  );
  if (!agent) return null;
  const { rows: [cfg] } = await db.query(
    `SELECT tone, languages, rules, working_hours, system_prompt_extra FROM ai_configs WHERE agent_id = $1`,
    [agent.id]
  );
  if (!cfg) {
    return { agentId: agent.id, agentName: agent.name, tone: 'professional', languages: ['ar', 'en'], rules: {}, workingHours: {}, customInstructions: '' };
  }
  return {
    agentId: agent.id,
    agentName: agent.name,
    // legacy seeded value maps onto the proper preset (keeps the Kuwaiti dialect)
    tone: cfg.tone === 'kuwaiti-friendly' ? 'kuwaiti' : (cfg.tone ?? 'professional'),
    languages: Array.isArray(cfg.languages) ? cfg.languages : ['ar', 'en'],
    rules: cfg.rules ?? {},
    workingHours: cfg.working_hours ?? {},
    customInstructions: cfg.system_prompt_extra ?? ''
  };
}

/** Tone → human instruction injected into the prompt. */
export const TONE_INSTRUCTIONS = {
  professional: 'Use a clear, professional and helpful tone.',
  friendly: 'Use a warm, friendly and conversational tone.',
  kuwaiti: 'Reply in a warm KUWAITI/GULF dialect (اللهجة الكويتية) for Arabic replies: هلا والله، حياك، تسلم، يعطيك العافية، زين. English replies stay warm and natural.',
  custom: 'Follow the custom instructions below exactly.'
};
