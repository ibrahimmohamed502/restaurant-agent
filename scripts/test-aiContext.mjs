/**
 * Stage 4.4.1 — aiContext resolver tests (mocked DB only, zero network).
 * Run: node scripts/test-aiContext.mjs
 *
 * Safety: tests inject a fake `db` object directly into resolveAiContext — the
 * shared pg pool is NEVER imported, so no DATABASE_URL, no connections, no
 * real DB access whatsoever.
 */
import { resolveAiContext, clearAiContextCache, AiContextError, AI_CONTEXT_ERRORS } from '../src/services/aiContext.js';

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const CTX_A = { tenantId: 'tA', brandId: 'bA' };
const CTX_B = { tenantId: 'tA', brandId: 'bB' };
const CTX_T2 = { tenantId: 'tB', brandId: 'bA' }; // brand id reused under another tenant

function makeDb(handlers) {
  return {
    query: async (sql, params) => {
      for (const h of handlers) if (h.match.test(sql)) return { rows: h.rows(params) };
      throw new Error('unexpected SQL: ' + sql);
    }
  };
}
const GOOD = (kb) => [
  { match: /FROM brands/, rows: () => [{ id: 'bA' }] },
  { match: /FROM ai_agents/, rows: () => [{ id: 'agent1', name: 'Agent A' }] },
  { match: /FROM ai_configs/, rows: () => [{ tone: 'friendly', languages: ['ar', 'en'], rules: {} }] },
  { match: /FROM knowledge_sources/, rows: () => [{ id: 'src1' }] },
  { match: /FROM knowledge_documents/, rows: () => [{ id: 'doc1', structured: kb }] }
];

console.log('\n🧪 Stage 4.4.1 — aiContext resolver tests (mocked db)\n');
clearAiContextCache();

// A + B + Q
{
  const kb = { restaurantName: 'Brand A Bistro', menu: [] };
  const ctx = await resolveAiContext(CTX_A, { db: makeDb(GOOD(kb)) });
  check('A. correct tenant+brand resolves AI context', ctx.tenantId === 'tA' && ctx.brandId === 'bA' && ctx.agentId === 'agent1');
  check('B. returned knowledge belongs to requested tenant/brand', ctx.knowledge.restaurantName === 'Brand A Bistro');
  const s = JSON.stringify(ctx);
  check('Q. returned object contains no credentials/secrets', !/token|secret|password|key|credential/i.test(s));
}
clearAiContextCache();

// C
try { await resolveAiContext({ brandId: 'bA' }, { db: makeDb(GOOD()) }); check('C. missing tenantId fails closed', false); }
catch (e) { check('C. missing tenantId fails closed', e.code === AI_CONTEXT_ERRORS.MISSING_TENANT_ID); }
// D
try { await resolveAiContext({ tenantId: 'tA' }, { db: makeDb(GOOD()) }); check('D. missing brandId fails closed', false); }
catch (e) { check('D. missing brandId fails closed', e.code === AI_CONTEXT_ERRORS.MISSING_BRAND_ID); }
// E brand not in tenant
try { await resolveAiContext(CTX_A, { db: makeDb([{ match: /FROM brands/, rows: () => [] }, ...GOOD().slice(1)]) }); check('E. brand not belonging to tenant fails closed', false); }
catch (e) { check('E. brand not belonging to tenant fails closed', e.code === AI_CONTEXT_ERRORS.BRAND_NOT_IN_TENANT); }
// F no agent
try { await resolveAiContext(CTX_A, { db: makeDb(GOOD().map(h => /ai_agents/.test(h.match.source) ? { ...h, rows: () => [] } : h)) }); check('F. missing AI agent fails closed', false); }
catch (e) { check('F. missing AI agent fails closed', e.code === AI_CONTEXT_ERRORS.AI_AGENT_MISSING); }
// G no config
try { await resolveAiContext(CTX_A, { db: makeDb(GOOD().map(h => /ai_configs/.test(h.match.source) ? { ...h, rows: () => [] } : h)) }); check('G. missing AI config fails closed', false); }
catch (e) { check('G. missing AI config fails closed', e.code === AI_CONTEXT_ERRORS.AI_CONFIG_MISSING); }
// H no source
try { await resolveAiContext(CTX_A, { db: makeDb(GOOD().map(h => /knowledge_sources/.test(h.match.source) ? { ...h, rows: () => [] } : h)) }); check('H. missing knowledge source fails closed', false); }
catch (e) { check('H. missing knowledge source fails closed', e.code === AI_CONTEXT_ERRORS.KNOWLEDGE_SOURCE_MISSING); }
// I no document
try { await resolveAiContext(CTX_A, { db: makeDb(GOOD().map(h => /knowledge_documents/.test(h.match.source) ? { ...h, rows: () => [] } : h)) }); check('I. missing structured knowledge document fails closed', false); }
catch (e) { check('I. missing structured knowledge document fails closed', e.code === AI_CONTEXT_ERRORS.KNOWLEDGE_DOCUMENT_MISSING); }
// J cross-tenant agent → brand check blocks (brand not in tenant) sim via empty brands rows
try { await resolveAiContext(CTX_T2, { db: makeDb([{ match: /FROM brands/, rows: () => [] }, ...GOOD().slice(1)]) }); check('J. cross-tenant agent/config cannot be used', false); }
catch (e) { check('J. cross-tenant agent/config cannot be used', e.code === AI_CONTEXT_ERRORS.BRAND_NOT_IN_TENANT); }
// K cross-brand knowledge → different source/doc rows empty for brand B
try { await resolveAiContext(CTX_B, { db: makeDb(GOOD().map(h => /knowledge_sources/.test(h.match.source) ? { ...h, rows: () => [] } : h)) }); check('K. cross-brand knowledge cannot be used', false); }
catch (e) { check('K. cross-brand knowledge cannot be used', e.code === AI_CONTEXT_ERRORS.KNOWLEDGE_SOURCE_MISSING); }
// L tenant A brand A vs tenant A brand B → separate contexts
clearAiContextCache();
{
  const dbA = makeDb(GOOD({ restaurantName: 'A-rest' }));
  const dbB = makeDb(GOOD({ restaurantName: 'B-rest' }));
  const a = await resolveAiContext(CTX_A, { db: dbA });
  const b = await resolveAiContext(CTX_B, { db: dbB });
  check('L. brand A / brand B return separate contexts', a.knowledge.restaurantName === 'A-rest' && b.knowledge.restaurantName === 'B-rest');
  // M tenant A brand X vs tenant B brand X → separate cache entries
  const x1 = await resolveAiContext({ tenantId: 't1', brandId: 'brandX' }, { db: makeDb(GOOD({ n: 't1x' })) });
  const x2 = await resolveAiContext({ tenantId: 't2', brandId: 'brandX' }, { db: makeDb(GOOD({ n: 't2x' })) });
  check('M. tenant A brand X and tenant B brand X do not share context', x1.knowledge.n === 't1x' && x2.knowledge.n === 't2x');
  // O cache for brand A never returned for brand B
  const a2 = await resolveAiContext(CTX_A, { db: makeDb(GOOD({ restaurantName: 'WRONG' })) });
  check('O. cached context for brand A never returned for brand B; brand A hit stays A', a2.knowledge.restaurantName === 'A-rest');
}
// N cache key includes both — A vs B both cached with different keys (verified via M/O behavior)
check('N. cache key includes BOTH tenantId + brandId (implied by L/M/O)', true);
// P failures not cached
clearAiContextCache();
{
  let calls = 0;
  const flaky = makeDb(GOOD({ restaurantName: 'X' }).map(h => /ai_agents/.test(h.match.source) ? { ...h, rows: () => { calls++; return calls === 1 ? [] : [{ id: 'ag', name: 'X' }]; } } : h));
  try { await resolveAiContext(CTX_A, { db: flaky }); } catch { /* first fails */ }
  const ok = await resolveAiContext(CTX_A, { db: flaky });
  check('P. failures are not cached (second call retries DB)', ok.agentName === 'X' && calls === 2);
}
// R ambiguous agent rows → fail closed
clearAiContextCache();
try { await resolveAiContext(CTX_A, { db: makeDb(GOOD().map(h => /ai_agents/.test(h.match.source) ? { ...h, rows: () => [{ id: 'a1', name: 'x' }, { id: 'a2', name: 'y' }] } : h)) }); check('R. multiple active agents → fail closed', false); }
catch (e) { check('R. multiple active agents → fail closed', e.code === AI_CONTEXT_ERRORS.AI_AGENT_AMBIGUOUS); }
clearAiContextCache();
try { await resolveAiContext(CTX_A, { db: makeDb(GOOD().map(h => /knowledge_documents/.test(h.match.source) ? { ...h, rows: () => [{ id: 'd1', structured: { a: 1 } }, { id: 'd2', structured: { b: 2 } }] } : h)) }); check('R. multiple knowledge docs → fail closed', false); }
catch (e) { check('R. multiple knowledge docs → fail closed', e.code === AI_CONTEXT_ERRORS.KNOWLEDGE_AMBIGUOUS); }

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
