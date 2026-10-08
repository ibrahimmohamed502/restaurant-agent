/**
 * Stage 4.3B.2 — webhook routing-context wiring tests (mocked, no DB, no Meta).
 * Run: node scripts/test-webhook-routing.mjs
 *
 * Covers: once-per-entry resolution, same ctx reuse, per-entry isolation,
 * fail-closed unknown page, bad entry doesn't block good entry, self-skip via
 * ctx.pageId, ctx.metaClient for comment/DM outbound ops, no env-token
 * fallback, no credentials in logs, ACK/signature behavior unchanged.
 */
import { handlePayload, processComment, processMessage } from '../src/webhook.js';

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const SECRET = 'TEST_DB_CREDENTIAL_SECRET_NEVER_LOG';
const noop = async () => {};
const depsBase = {
  analyze: async () => ({ reply: 'hi', intent: 'menu', inScope: true, lang: 'en', escalate: false }),
  notify: noop,
  logEvt: noop,
  addEsc: noop,
  isReplied: () => false,
  mark: noop,
  overLimit: () => false,
  pgEnabled: false
};

function fakeCtx(pageId, calls) {
  return {
    pageId, channelId: `ch_${pageId}`, tenantId: `t_${pageId}`, brandId: `b_${pageId}`,
    displayName: `Page ${pageId}`,
    metaClient: {
      replyToComment: async (id, msg) => { calls.push(['replyToComment', id, msg]); return { id: 'r1' }; },
      sendMessengerReply: async (psid, text) => { calls.push(['sendMessengerReply', psid, text]); return { message_id: 'm1' }; },
      sendTypingIndicator: async (psid) => { calls.push(['sendTypingIndicator', psid]); },
      getUserFirstName: async (psid) => { calls.push(['getUserFirstName', psid]); return 'Test'; }
    }
  };
}

console.log('\n🧪 Stage 4.3B.2 — webhook routing-context tests\n');

// A. buildRouteContext called exactly once for one entry with multiple events
{
  let buildCalls = 0;
  const ctx = fakeCtx('page_A', []);
  await handlePayload({
    object: 'page',
    entry: [{
      id: 'page_A',
      changes: [
        { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'hi', from: { id: 'u1', name: 'U' } } },
        { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', message: 'yo', from: { id: 'u2', name: 'V' } } }
      ],
      messaging: [{ sender: { id: 'u3' }, message: { mid: 'm1', text: 'hello' } }]
    }]
  }, {
    buildCtx: async () => { buildCalls++; return ctx; },
    onComment: async () => {}, onMessage: async () => {}
  });
  check('A. buildRouteContext called exactly once for one multi-event entry', buildCalls === 1);
}

// B. same ctx passed to all events of that entry
{
  const ctx = fakeCtx('page_B', []);
  const seen = [];
  await handlePayload({
    object: 'page',
    entry: [{
      id: 'page_B',
      changes: [
        { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'a', from: { id: 'u1' } } },
        { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', message: 'b', from: { id: 'u2' } } }
      ],
      messaging: [{ sender: { id: 'u3' }, message: { mid: 'm1', text: 'x' } }]
    }]
  }, {
    buildCtx: async () => ctx,
    onComment: async (v, c) => seen.push(c),
    onMessage: async (e, c) => seen.push(c)
  });
  check('B. same ctx passed to every event in the entry', seen.length === 3 && seen.every(c => c === ctx));
}

// C. two entries resolve independently to two different contexts
{
  const ctx1 = fakeCtx('page_1', []), ctx2 = fakeCtx('page_2', []);
  const seen = [];
  await handlePayload({
    object: 'page',
    entry: [
      { id: 'page_1', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'a', from: { id: 'u1' } } }] },
      { id: 'page_2', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', message: 'b', from: { id: 'u2' } } }] }
    ]
  }, {
    buildCtx: async (entry) => entry.id === 'page_1' ? ctx1 : ctx2,
    onComment: async (v, c) => seen.push(c), onMessage: async () => {}
  });
  check('C. two entries → two different contexts', seen.length === 2 && seen[0] === ctx1 && seen[1] === ctx2);
}

// D. unknown page fails closed — no events processed
{
  let processed = 0;
  await handlePayload({
    object: 'page',
    entry: [{ id: 'unknown', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'a', from: { id: 'u1' } } }] }]
  }, {
    buildCtx: async () => { const e = new Error('unknown'); e.code = 'UNKNOWN_META_PAGE'; throw e; },
    onComment: async () => { processed++; }, onMessage: async () => { processed++; }
  });
  check('D. unknown page fails closed, no events processed', processed === 0);
}

// E. one bad entry does NOT block a second valid entry
{
  let processed = 0;
  await handlePayload({
    object: 'page',
    entry: [
      { id: 'bad', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'a', from: { id: 'u1' } } }] },
      { id: 'good', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', message: 'b', from: { id: 'u2' } } }] }
    ]
  }, {
    buildCtx: async (entry) => { if (entry.id === 'bad') { const e = new Error('x'); e.code = 'CHANNEL_INACTIVE'; throw e; } return fakeCtx('good', []); },
    onComment: async () => { processed++; }, onMessage: async () => {}
  });
  check('E. bad entry skipped, good entry still processed', processed === 1);
}

// F. self-comment detection uses ctx.pageId (not global env FB_PAGE_ID)
{
  const calls = [];
  process.env.FB_PAGE_ID = 'DIFFERENT_GLOBAL_PAGE';
  await processComment({ comment_id: 'c1', message: 'x', from: { id: 'page_self', name: 'Page' } }, fakeCtx('page_self', calls), depsBase);
  check('F. self-comment skip via ctx.pageId (no Meta call made)', calls.length === 0);
}

// G. outbound comment reply uses ctx.metaClient
{
  const calls = [];
  await processComment({ comment_id: 'c1', message: 'hello', from: { id: 'u1', name: 'U' } }, fakeCtx('page_G', calls), depsBase);
  check('G. comment reply goes through ctx.metaClient.replyToComment', calls.length === 1 && calls[0][0] === 'replyToComment' && calls[0][1] === 'c1');
}

// H. Messenger typing/name/reply use ctx.metaClient
{
  const calls = [];
  await processMessage({ sender: { id: 'u9' }, message: { mid: 'mm1', text: 'hi' } }, fakeCtx('page_H', calls), depsBase);
  const kinds = calls.map(c => c[0]);
  check('H. DM typing/name/reply all via ctx.metaClient', JSON.stringify(kinds) === JSON.stringify(['sendTypingIndicator', 'getUserFirstName', 'sendMessengerReply']));
}

// I. no routed FB_PAGE_ACCESS_TOKEN fallback — facebook.js env fallback NOT imported in webhook path
{
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8'));
  check('I. webhook.js imports no legacy named facebook exports / no FB_PAGE_ACCESS_TOKEN use', !/FB_PAGE_ACCESS_TOKEN/.test(src) && !/from '\.\/facebook\.js'/.test(src));
}

// J. no credential appears in logs/errors — error code path is what handlePayload logs
{
  const logs = [];
  const origWarn = console.warn; console.warn = (...a) => logs.push(a.join(' '));
  await handlePayload({
    object: 'page',
    entry: [{ id: 'p', changes: [] }]
  }, {
    buildCtx: async () => { const e = new Error(`failure near credential ${SECRET}`); e.code = 'RESOLVE_FAILED'; throw e; },
    onComment: async () => {}, onMessage: async () => {}
  });
  console.warn = origWarn;
  check('J. sanitized per-entry log (code only, no credential leak)', logs.length === 1 && !logs[0].includes(SECRET) && logs[0].includes('RESOLVE_FAILED'));
}

// K. ACK/signature behavior unchanged — static check of the POST route contract
{
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8'));
  check('K. immediate 200 ACK, X-Hub-Signature-256 verification preserved',
    src.includes('res.sendStatus(200); // ACK immediately') &&
    src.includes('x-hub-signature-256') &&
    src.includes('verifySignature(req)') &&
    src.includes('crypto.timingSafeEqual'));
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
