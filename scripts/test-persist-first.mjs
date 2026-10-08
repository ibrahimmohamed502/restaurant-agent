/**
 * Stage 4.4.6 — Persist-first + delivery status tests (mocked DB, zero network).
 * Run: node scripts/test-persist-first.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const { pool } = await import('../src/db/pg.js');
if (!pool) { console.error('stub pool missing'); process.exit(1); }

// in-memory message store honoring the (conversation_id, provider_message_id) unique rule
const store = new Map(); // `${convId}|${pmid}` -> row
pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ');
  if (/INSERT INTO messages/.test(s)) {
    const isInbound = /'inbound'/.test(s);
    // inbound: [tenant, conv, senderType, text, providerMessageId, providerTs]
    // outbound: [tenant, conv, text, providerMessageId, providerTs, deliveryStatus, deliveryError]
    const [tenantId, conversationId] = params;
    let text, pmid, providerTs, deliveryStatus, deliveryError;
    if (isInbound) {
      text = params[3]; pmid = params[4]; providerTs = params[5]; deliveryStatus = null; deliveryError = null;
    } else {
      text = params[2]; pmid = params[3]; providerTs = params[4]; deliveryStatus = params[5]; deliveryError = params[6];
    }
    const key = `${conversationId}|${pmid}`;
    if (store.has(key)) return { rows: [] };
    const row = { id: `msg_${store.size + 1}`, tenant_id: tenantId, conversation_id: conversationId, direction: isInbound ? 'inbound' : 'outbound', text: text ?? null, provider_message_id: pmid, delivery_status: deliveryStatus ?? 'sent', delivery_error: deliveryError ?? null };
    store.set(key, row);
    return { rows: [{ id: row.id }] };
  }
  if (/UPDATE messages/.test(s)) {
    const [deliveryStatus, deliveryError, pmid, messageId, tenantId] = params;
    for (const [k, row] of store) if (row.id === messageId && row.tenant_id === tenantId && row.direction === 'outbound') {
      row.delivery_status = deliveryStatus; row.delivery_error = deliveryError; if (pmid) row.provider_message_id = pmid;
      return { rows: [{ id: row.id, delivery_status: row.delivery_status, provider_message_id: row.provider_message_id }] };
    }
    return { rows: [] };
  }  if (/UPDATE conversations SET last_message_at/.test(s)) return { rows: [] };
  if (/INSERT INTO (channels|customers|customer_identities|conversations)/.test(s)) return { rows: [{ id: 'x' }] };
  if (/UPDATE customers SET last_interaction/.test(s)) return { rows: [] };
  if (/SELECT/.test(s)) return { rows: [] };
  return { rows: [] };
};

const { persistInboundMessage, persistOutboundMessage, updateMessageDelivery, deliveryErrorCategory } = await import('../src/services/conversations.js');
const { processComment } = await import('../src/webhook.js');

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };
const CONV = 'conv1', TEN = 'ten1';

const makeCtx = (over = {}) => {
  const calls = [];
  return {
    calls, pageId: 'p1', tenantId: TEN, brandId: 'b1', channelId: 'ch1',
    metaClient: {
      replyToComment: async (id, m) => { calls.push(['replyToComment', id, m]); return { id: 'reply1' }; },
      sendMessengerReply: async () => ({ message_id: 'dm1' })
    }, ...over
  };
};
const base = (over = {}) => ({ analyze: async () => ({ reply: 'ok', intent: 'i', inScope: true, lang: 'en', escalate: false }), notify: async () => {}, logEvt: () => {}, addEsc: () => {}, isReplied: () => false, mark: () => {}, overLimit: () => false, pgEnabled: true, ...over });

console.log('\n🧪 Stage 4.4.6 — persist-first + delivery status\n');

// A: inbound persists BEFORE LLM call
{
  store.clear();
  let analyzeCalls = 0, inboundAtAnalyze = 0;
  await processComment({ comment_id: 'cA', message: 'hi', from: { id: 'u1', name: 'U' } }, makeCtx(),
    base({ analyze: async (...a) => { analyzeCalls++; inboundAtAnalyze = store.size; return base().analyze(...a); } }));
  check('A. inbound persisted before LLM call', inboundAtAnalyze === 1 && analyzeCalls === 1);
  check('E. successful delivery → outbound status sent + provider id stored', [...store.values()].some(r => r.direction === 'outbound' && r.delivery_status === 'sent' && r.provider_message_id === 'reply1'));
}

// B: LLM failure — inbound remains
{
  store.clear();
  await processComment({ comment_id: 'cB', message: 'hi', from: { id: 'u1' } }, makeCtx(), base({ analyze: async () => { throw new Error('LLM HTTP 500'); } }));
  const rows = [...store.values()];
  check('B. LLM failure → inbound persisted; outbound marked failed(llm_error)', rows.filter(r => r.direction === 'inbound').length === 1 && rows.some(r => r.provider_message_id === 'cB' && r.direction === 'inbound') && rows.some(r => r.direction === 'outbound' && r.delivery_status === 'failed' && r.delivery_error === 'llm_error'));
}

// C: Meta 401 expired
{
  store.clear();
  const ctx = makeCtx();
  ctx.metaClient.replyToComment = async () => { throw new Error('Graph API 401 (code 190): Error validating access token: Session has expired'); };
  const marked = [];
  await processComment({ comment_id: 'cC', message: 'hi', from: { id: 'u1' } }, ctx, base({ mark: (id) => marked.push(id) }));
  const out = [...store.values()].find(r => r.direction === 'outbound');
  check('C. Meta 401 → inbound persists; outbound failed(meta_auth_expired); marked to prevent retry spam',
    [...store.values()].some(r => r.direction === 'inbound' && r.provider_message_id === 'cC') && out?.delivery_status === 'failed' && out?.delivery_error === 'meta_auth_expired' && marked.includes('cC'));
}

// D: Meta 500
{
  store.clear();
  const ctx = makeCtx();
  ctx.metaClient.replyToComment = async () => { throw new Error('Graph API 500 (code 1): An unknown error has occurred.'); };
  await processComment({ comment_id: 'cD', message: 'hi', from: { id: 'u1' } }, ctx, base());
  const out = [...store.values()].find(r => r.direction === 'outbound');
  check('D. Meta 500 → inbound persists; outbound failed(meta_api_error)', [...store.values()].some(r => r.direction === 'inbound' && r.provider_message_id === 'cD') && out?.delivery_status === 'failed' && out?.delivery_error === 'meta_api_error');
}

// F: duplicate webhook → no duplicates, second run skips processing
{
  store.clear();
  let analyzeCalls = 0;
  const d = base({ analyze: async () => { analyzeCalls++; return base().analyze(); } });
  await processComment({ comment_id: 'cF', message: 'hi', from: { id: 'u1' } }, makeCtx(), d);
  await processComment({ comment_id: 'cF', message: 'hi', from: { id: 'u1' } }, makeCtx(), d);
  check('F. duplicate webhook → single inbound, no second AI/reply', analyzeCalls === 1 && [...store.values()].filter(r => r.direction === 'inbound').length === 1 && [...store.values()].filter(r => r.direction === 'outbound').length === 1);
}

// G: grounding rejection — persistence consistent (safe fallback still delivered)
{
  store.clear();
  const ctx = makeCtx();
  await processComment({ comment_id: 'cG', message: 'hi', from: { id: 'u1' } }, ctx,
    base({ analyze: async () => ({ reply: 'see https://evil.example.com 99 KD', intent: 'i', inScope: true, lang: 'en', escalate: false, _knowledge: {} }) }));
  const sent = ctx.calls.find(c => c[0] === 'replyToComment');
  check('G. grounding rejection → safe fallback delivered; outbound marked sent', sent && /confirmed information/i.test(sent[2]) && [...store.values()].some(r => r.direction === 'outbound' && r.delivery_status === 'sent'));
}

// H: tenant isolation — outbound uses ctx.tenantId only
{
  store.clear();
  await processComment({ comment_id: 'cH', message: 'hi', from: { id: 'u1' } }, makeCtx({ tenantId: 'OTHER_TENANT' }), base());
  check('H. messages stored under ctx.tenantId', [...store.values()].every(r => r.tenant_id === 'OTHER_TENANT'));
}

// I: dashboard inbox API shape includes delivery_status
{
  store.clear();
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8'));
  check('I. inbox detail API exposes delivery_status/error', /delivery_status, delivery_error/.test(src));
}

// helper behavior
{
  store.clear();
  const inbound = await persistInboundMessage({ tenantId: TEN, conversationId: CONV, providerMessageId: 'dup1', text: 'a' });
  const dup = await persistInboundMessage({ tenantId: TEN, conversationId: CONV, providerMessageId: 'dup1', text: 'a' });
  check('persistInboundMessage idempotency', !inbound.duplicate && dup.duplicate === true);
  const row = await persistOutboundMessage({ tenantId: TEN, conversationId: CONV, text: 't', deliveryStatus: 'pending' });
  const bad = await persistOutboundMessage({ tenantId: TEN, conversationId: CONV, text: 't2', deliveryStatus: 'sent', errorCategory: 'x' }).catch(e => e.code);
  check('persistOutboundMessage rejects sent+error', bad === 'INVALID_DELIVERY_STATUS');
  const upd = await updateMessageDelivery({ tenantId: TEN, messageId: row.id, deliveryStatus: 'failed', errorCategory: 'meta_auth_expired' });
  check('updateMessageDelivery works', upd?.delivery_status === 'failed');
  check('deliveryErrorCategory mapping', deliveryErrorCategory(new Error('Graph API 401 x session expired')) === 'meta_auth_expired' && deliveryErrorCategory(new Error('Graph API 403')) === 'meta_permission' && deliveryErrorCategory(new Error('fetch failed')) === 'network_error' && deliveryErrorCategory(new Error('whatever')) === 'meta_api_error');
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
