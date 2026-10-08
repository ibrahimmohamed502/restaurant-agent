/**
 * Stage 4.4.2 — agent scoped-context tests (mocked resolver + mocked LLM, zero network).
 * Run: node scripts/test-agent-scoped.mjs
 */
import { analyzeAndDraft, buildSystemPrompt, AiContextUnavailableError } from '../src/agent.js';

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) passed++, console.log(`  ✅ ${name}`);
  else failed++, console.log(`  ❌ ${name}`);
}

const LWC_MARK = 'Cacao Bomb';

function scopedCtx(kb, config) {
  return { tenantId: 't', brandId: 'b', agentId: 'ag', agentName: 'A', config: config ?? { tone: 'friendly', languages: ['ar'], rules: {} }, knowledge: kb };
}

function llmOk(messages, _pc) {
  return JSON.stringify({ intent: 'menu', inScope: true, escalate: false, reply: 'ok' });
}

const KB_A = { restaurantName: 'Brand A', menuUrl: 'a.example/menu' };
const KB_B = { restaurantName: 'Brand B', menuUrl: 'b.example/menu' };
const CONFIG_A = { tone: 'warm', languages: ['ar', 'en'], system_prompt_extra: 'extra A', rules: { x: 1 }, working_hours: { d: '9-5' }, channel_behavior: { dm: 'short' } };

console.log('\n🧪 Stage 4.4.2 — agent scoped tests (mocked)\n');

let lastSent;
async function run(params, deps) {
  lastSent = null;
  const inner = deps.llmFn ?? llmOk;
  const wrapped = { ...deps, llmFn: (messages, pc) => { lastSent = messages[0].content; return inner(messages, pc); } };
  return analyzeAndDraft(params, wrapped);
}

// A + B: resolver called with tenantId/brandId unchanged
let calledWith = null;
await run({ text: 'hello', channel: 'comment', ctx: { tenantId: 'T1', brandId: 'BR1' } },
  { resolveFn: async (ctx) => { calledWith = ctx; return scopedCtx(KB_A, CONFIG_A); } });
check('A. ctx present → scoped resolver called', calledWith !== null);
check('B. ctx passed unchanged (tenantId/brandId)', calledWith.tenantId === 'T1' && calledWith.brandId === 'BR1');

// C scoped knowledge in prompt; D global LWC not in prompt
check('C. scoped Brand A knowledge appears in prompt', lastSent.includes('Brand A'));
check('D. global LWC knowledge absent from scoped prompt', !lastSent.includes(LWC_MARK) && !lastSent.includes('knowledgeBase'));
// F config fields present
check('F. scoped config fields present in prompt', lastSent.includes('warm') && lastSent.includes('extra A') && lastSent.includes('working_hours'));

// E separate prompts for A and B
await run({ text: 'hello', ctx: { tenantId: 'T1', brandId: 'BR1' } }, { resolveFn: async () => scopedCtx(KB_B) });
const promptB = lastSent;
check('E. Brand A and Brand B produce different scoped prompts', promptB.includes('Brand B') && !promptB.includes('Brand A'));

// G + H: resolver failure fails closed, no legacy fallback
let hErr = null;
try { await analyzeAndDraft({ text: 'hi', ctx: { tenantId: 'T', brandId: 'B' } }, { resolveFn: async () => { const e = new Error('brand not in tenant'); e.code = 'BRAND_NOT_IN_TENANT'; throw e; } }); }
catch (e) { hErr = e; }
check('G. scoped resolver failure fails closed', hErr instanceof AiContextUnavailableError && hErr.code === 'AI_CONTEXT_UNAVAILABLE');
check('H. resolver failure message has no internal leak', !/tenant/.test(hErr.message.replace(/\(.*?\)/, '')));

// H2: failure never produces any LLM call at all
let llmCalled = 0;
hErr = null;
try { await analyzeAndDraft({ text: 'hi', ctx: {} }, { resolveFn: async () => { throw new Error('x'); }, llmFn: () => { llmCalled++; return '{}'; } }); } catch (e) { hErr = e; }
check('H2. on scoped failure the LLM is never invoked (no legacy fallback)', llmCalled === 0 && hErr?.code === 'AI_CONTEXT_UNAVAILABLE');

// I legacy behavior without ctx
const legacyPrompt = buildSystemPrompt('en', 'comment', { scoped: false });
check('I. legacy prompt still includes global knowledge', legacyPrompt.includes(LWC_MARK) || legacyPrompt.includes('restaurantName'));
const draftLegacy = await run({ text: 'hi' }, {});
check('I2. analyzeAndDraft without ctx works (legacy)', draftLegacy.intent === 'menu');

// J comment, K dm
await run({ text: 'hi', channel: 'comment', ctx: { tenantId: 'T', brandId: 'B1' } }, { resolveFn: async () => scopedCtx(KB_A) });
const cPrompt = lastSent;
await run({ text: 'hi', channel: 'dm', ctx: { tenantId: 'T', brandId: 'B2' } }, { resolveFn: async () => scopedCtx(KB_A) });
const dPrompt = lastSent;
check('J. comment channel prompt valid (closing-line rule present)', cPrompt.includes('never add links that are not in the KNOWLEDGE BASE'));
check('K. dm channel prompt valid (dm menu-link rule present)', dPrompt.includes('ONLY when the conversation involves it'));

// L JSON extraction/normalization — malformed JSON handled by existing fallback
const junk = await run({ text: 'hi' }, { llmFn: () => 'not json at all' });
check('L. malformed LLM output → safe fallback draft', junk.intent === 'fallback' && typeof junk.reply === 'string');

// M LLM failure still uses localized fallback
const boom = await run({ text: 'hi', channel: 'comment' }, { llmFn: () => { throw new Error('LLM HTTP 500'); } });
const expectedFallback = (await import('../src/templates.js')).pickLocalized((await import('../src/templates.js')).FALLBACK_REPLY, 'ar');
// deterministic language is Arabic here; simply require the existing generic fallback object was used
check('M. LLM failure uses existing localized fallback behavior', boom.intent === 'fallback' && boom.reply === expectedFallback);

// N no secrets/credentials in scoped prompt
await run({ text: 'hi', ctx: { tenantId: 'T', brandId: 'B' } }, { resolveFn: async () => scopedCtx(KB_A, CONFIG_A) });
check('N. no secrets/credentials in generated system prompt', !/Bearer |token|secret|password/i.test(lastSent));

// O scoped path performs no direct DB lookup outside resolveFn
const sentCalls = [];
const draftO = await run({ text: 'hi', ctx: { tenantId: 'T', brandId: 'B' } }, { resolveFn: async () => { sentCalls.push('resolveFn'); return scopedCtx(KB_A); } });
check('O. only the injected resolver performed the lookup', sentCalls.length === 1 && draftO.intent === 'menu');

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
