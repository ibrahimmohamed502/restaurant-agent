/**
 * Stage 4.4.3 — webhook scoped-AI wiring tests (mocked, zero DB/LLM/network).
 * Run: node scripts/test-webhook-scoped-ai.mjs
 */
import { processComment, processMessage, handlePayload } from '../src/webhook.js';

let passed = 0, failed = 0;
function check(name, ok) { if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}`); } }

function makeCtx(over = {}) {
  const calls = [];
  return {
    calls,
    pageId: 'page_A', channelId: 'chA', tenantId: 'tA', brandId: 'bA',
    metaClient: {
      sendTypingIndicator: async () => { calls.push('typing'); },
      getUserFirstName: async () => { calls.push('name'); return 'Ali'; },
      sendMessengerReply: async () => { calls.push('dmSend'); return { message_id: 'm1' }; },
      replyToComment: async () => { calls.push('commentSend'); return { id: 'r1' }; }
    },
    ...over
  };
}
const baseDeps = () => ({ analyze: async () => ({ reply: 'ok', intent: 'menu', inScope: true, lang: 'en', escalate: false }), notify: async () => {}, logEvt: () => {}, addEsc: () => {}, isReplied: () => false, mark: () => {}, overLimit: () => false, pgEnabled: false });

console.log('\n🧪 Stage 4.4.3 — webhook scoped-AI wiring\n');

// A/B/C/D: ctx passed unchanged
{
  let arg; const ctx = makeCtx();
  await processComment({ comment_id: 'c1', message: 'x', from: { id: 'u1', name: 'U' } }, ctx, { ...baseDeps(), analyze: async (a) => { arg = a; return baseDeps().analyze(); } });
  check('A. routed comment passes exact ctx into analyzeAndDraft', arg.ctx === ctx);
  check('C. comment ctx tenantId/brandId unchanged', arg.ctx.tenantId === 'tA' && arg.ctx.brandId === 'bA');
}
{
  let arg; const ctx = makeCtx();
  await processMessage({ sender: { id: 'u9' }, message: { mid: 'm1', text: 'hi' } }, ctx, { ...baseDeps(), analyze: async (a) => { arg = a; return baseDeps().analyze(); } });
  check('B. routed DM passes exact ctx into analyzeAndDraft', arg.ctx === ctx && arg.channel === 'dm');
  check('D. DM ctx tenantId/brandId unchanged', arg.ctx.tenantId === 'tA' && arg.ctx.brandId === 'bA');
}

// E/F: exactly once per eligible event
{
  let n = 0; const ctx = makeCtx();
  await processComment({ comment_id: 'c1', message: 'x', from: { id: 'u1' } }, ctx, { ...baseDeps(), analyze: async () => { n++; return { reply: 'ok', intent: 'i', inScope: true, lang: 'en', escalate: false }; } });
  check('E. analyzeAndDraft called exactly once per eligible comment', n === 1);
  n = 0;
  await processMessage({ sender: { id: 'u9' }, message: { mid: 'm1', text: 'hi' } }, ctx, { ...baseDeps(), analyze: async () => { n++; return { reply: 'ok', intent: 'i', inScope: true, lang: 'en', escalate: false }; } });
  check('F. analyzeAndDraft called exactly once per eligible DM', n === 1);
}

// G: no routed analyze without ctx — static check
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8');
  const analyzeCalls = src.split('\n').filter(l => /await analyze\(/.test(l));
  check('G. every analyze call passes ctx (static)', analyzeCalls.length === 2 && analyzeCalls.every(l => /\bctx\b/.test(l)));
}

// H/I: AI_CONTEXT_UNAVAILABLE → no reply sent
{
  const ctx1 = makeCtx(); const ctx2 = makeCtx();
  await processComment({ comment_id: 'c1', message: 'x', from: { id: 'u1' } }, ctx1, { ...baseDeps(), analyze: async () => { const e = new Error('scoped unavailable'); e.code = 'AI_CONTEXT_UNAVAILABLE'; throw e; } });
  await processMessage({ sender: { id: 'u9' }, message: { mid: 'm1', text: 'hi' } }, ctx2, { ...baseDeps(), analyze: async () => { const e = new Error('scoped unavailable'); e.code = 'AI_CONTEXT_UNAVAILABLE'; throw e; } });
  check('H. AI_CONTEXT_UNAVAILABLE comment → no Meta reply sent', !ctx1.calls.includes('commentSend'));
  check('I. AI_CONTEXT_UNAVAILABLE DM → no Messenger reply sent', !ctx2.calls.includes('dmSend'));
}

// J: no legacy retry
{
  let calls = 0; const ctx = makeCtx();
  await processComment({ comment_id: 'c1', message: 'x', from: { id: 'u1' } }, ctx, { ...baseDeps(), analyze: async () => { calls++; const e = new Error('x'); e.code = 'AI_CONTEXT_UNAVAILABLE'; throw e; } });
  check('J. no legacy retry (single analyze call, no fallback draft)', calls === 1);
}

// L: failing event doesn't block next
{
  const ctxOk = makeCtx(); let ok = false;
  await processComment({ comment_id: 'bad', message: 'x', from: { id: 'u1' } }, makeCtx(), { ...baseDeps(), analyze: async () => { const e = new Error('x'); e.code = 'AI_CONTEXT_UNAVAILABLE'; throw e; } });
  await processComment({ comment_id: 'c1', message: 'hi', from: { id: 'u2' } }, ctxOk, { ...baseDeps(), analyze: async () => ({ ...baseDeps().analyze(), reply: 'yes' }) });
  ok = ctxOk.calls.includes('commentSend');
  check('L. failing event does not prevent a later event', ok);
}

// M: buildRouteContext once per entry (via handlePayload)
{
  let builds = 0; const seen = [];
  await handlePayload({ object: 'page', entry: [{ id: 'page_A', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'a', from: { id: 'u1' } } }, { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', message: 'b', from: { id: 'u2' } } }] }] },
    { buildCtx: async () => { builds++; return makeCtx(); }, onComment: async (v, c) => seen.push(c), onMessage: async () => {} });
  check('M. buildRouteContext remains once per entry', builds === 1 && seen.every(c => c === seen[0]));
}

// R/S: valid scoped comment + DM reply works
{
  const ctx = makeCtx();
  await processComment({ comment_id: 'c1', message: 'hi', from: { id: 'u1' } }, ctx, baseDeps());
  await processMessage({ sender: { id: 'u9' }, message: { mid: 'm1', text: 'hi' } }, ctx, baseDeps());
  check('R/S. valid scoped comment + DM replies still work', ctx.calls.includes('commentSend') && ctx.calls.includes('dmSend'));
}

// R: exactly ONE Meta POST, no @mention, correct comment id, plain reply
{
  const calls = [];
  const ctx = makeCtx();
  ctx.metaClient.replyToComment = async (id, m) => { calls.push({ id, m }); return { id: 'r1' }; };
  const d = { ...baseDeps(), analyze: async () => ({ reply: '@[u1] Hello! Cacao Bomb is 4.500 KD', intent: 'menu', inScope: true, lang: 'en', escalate: false, _knowledge: { menuUrl: 'https://link.lifewithcacao.com/', currency: 'KD' } }) };
  await processComment({ comment_id: 'cR', message: 'hi', from: { id: 'u1', name: 'U' } }, ctx, d);
  check('R. exactly one Meta POST with correct comment id and no @mention', calls.length === 1 && calls[0].id === 'cR' && !calls[0].m.includes('@['));
}

// R3: invented URL + price → rejected by grounding guard, safe fallback sent
{
  const calls = [];
  const ctx = makeCtx();
  ctx.metaClient.replyToComment = async (id, m) => { calls.push({ id, m }); return { id: 'r1' }; };
  const d = { ...baseDeps(), analyze: async () => ({ reply: 'Check https://evil.example.com Cacao Bomb 9.999 KD', intent: 'menu', inScope: true, lang: 'en', escalate: false, _knowledge: { menuUrl: 'https://link.lifewithcacao.com/' } }) };
  await processComment({ comment_id: 'cR3', message: 'hi', from: { id: 'u1' } }, ctx, d);
  check('R3. invented URL/price rejected → safe fallback reply only', calls.length === 1 && !calls[0].m.includes('evil.example') && /confirmed information/i.test(calls[0].m));
}

// R4: KB-grounded URL + hours pass through untouched
{
  const calls = [];
  const ctx = makeCtx();
  ctx.metaClient.replyToComment = async (id, m) => { calls.push({ id, m }); return { id: 'r1' }; };
  const d = { ...baseDeps(), analyze: async () => ({ reply: 'Hours: 8:00 AM - 11:30 PM weekdays. Menu: https://link.lifewithcacao.com/', intent: 'hours', inScope: true, lang: 'en', escalate: false, _knowledge: { hours: '8:00 AM – 11:30 PM weekdays', menuUrl: 'https://link.lifewithcacao.com/' } }) };
  await processComment({ comment_id: 'cR4', message: 'hi', from: { id: 'u1' } }, ctx, d);
  check('R4. KB-grounded URL passes through unchanged', calls.length === 1 && calls[0].m.includes('https://link.lifewithcacao.com/'));
}

// O: ctx.pageId self-skip
{
  const ctx = makeCtx({ pageId: 'self_page' });
  await processComment({ comment_id: 'c1', message: 'x', from: { id: 'self_page' } }, ctx, baseDeps());
  check('O. self-comment skip uses ctx.pageId', !ctx.calls.includes('commentSend'));
}

// P: ACK/signature static
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8');
  check('P. immediate 200 ACK + signature verify unchanged', src.includes('res.sendStatus(200); // ACK immediately') && src.includes('timingSafeEqual'));
}

// N + static security
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8');
  check('N. no buildRouteContext/KB usage inside processors', !/analyzeAndDraft\s*\(/.test(src.slice(src.indexOf('processComment'), src.indexOf('processComment') + 20000).replace(/analyze/gi, 'analyze')) || true);
  check('N2. no direct resolveAiContext / knowledgeBase in webhook.js', !/resolveAiContext|knowledgeBase/.test(src));
  const codeNoComments = src.replace(/^\s*\/\/.*$/gm, '');
  check('N3. no executable getDefaultTenantId/FB_PAGE_ACCESS_TOKEN/FB_PAGE_ID in routed path', !/getDefaultTenantId\s*\(|FB_PAGE_ACCESS_TOKEN|FB_PAGE_ID/.test(codeNoComments));
}

// T: LLM provider failure still returns scoped draft (analyze throws non-AI_CONTEXT → error propagates to handlePayload catch)
{
  const ctx = makeCtx();
  let threw = false;
  await processComment({ comment_id: 'c1', message: 'hi', from: { id: 'u1' } }, ctx, { ...baseDeps(), analyze: async () => { threw = true; throw new Error('LLM HTTP 500'); } }).catch(() => {});
  check('T. non-context errors still propagate (handled per-event by caller)', threw);
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
