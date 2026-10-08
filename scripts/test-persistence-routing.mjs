/**
 * Stage 4.3B.3 — persistence routing tests (fully mocked DB, NO network).
 * Run: node scripts/test-persistence-routing.mjs
 *
 * Safety: DATABASE_URL is set to a dummy localhost address BEFORE importing
 * pg.js, and pool.query is REPLACED with an in-memory stub. The pg Pool is
 * lazy (connects on first query), and since query is stubbed, no socket or
 * network connection to PostgreSQL can ever be established. No real DB is
 * touched, no production credentials are used.
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub'; // dummy, never connected

const { pool } = await import('../src/db/pg.js');
if (!pool) { console.error('❌ stub pool not created'); process.exit(1); }

// ---- In-memory DB stub ----
let queries = [];
let channelRows = []; // {id, brand_id}
let insertedChannels = [];
let updatedChannels = [];
pool.query = async (sql, params = []) => {
  queries.push({ sql, params });
  if (/SELECT id, brand_id FROM channels/.test(sql)) return { rows: channelRows };
  if (/INSERT INTO channels/.test(sql)) { const id = `ch_${insertedChannels.length + 1}`; insertedChannels.push({ id, params }); return { rows: [{ id }] }; }
  if (/UPDATE channels SET brand_id/.test(sql)) { updatedChannels.push(params); channelRows = channelRows.map(r => ({ ...r, brand_id: params[0] })); return { rows: [] }; }
  if (/SELECT customer_id FROM customer_identities/.test(sql)) return { rows: [] };
  if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: 'cust_1' }] };
  if (/INSERT INTO customer_identities/.test(sql)) return { rows: [] };
  if (/UPDATE customers SET last_interaction/.test(sql)) return { rows: [] };
  if (/SELECT id FROM conversations/.test(sql)) return { rows: [] };
  if (/INSERT INTO conversations/.test(sql)) return { rows: [{ id: 'conv_1' }] };
  if (/INSERT INTO messages/.test(sql)) return { rows: [] };
  if (/UPDATE conversations SET last_message_at/.test(sql)) return { rows: [] };
  if (/INSERT INTO escalations/.test(sql)) return { rows: [] };
  return { rows: [] };
};

const { findOrCreateChannel, findOrCreateCustomer, findOrCreateConversation } = await import('../src/services/conversations.js');
const { processComment, processMessage } = await import('../src/webhook.js');

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const noop = async () => {};
function deps() {
  return {
    analyze: async () => ({ reply: 'hi', intent: 'menu', inScope: true, lang: 'en', escalate: true }),
    notify: noop, logEvt: noop, addEsc: noop,
    isReplied: () => false, mark: noop, overLimit: () => false, pgEnabled: true
  };
}
function ctx(over = {}) {
  return {
    pageId: 'page_1', channelId: 'routing_ch_1', tenantId: 'tenant_1', brandId: 'brand_1',
    displayName: 'Page 1',
    metaClient: {
      replyToComment: async () => ({ id: 'r1' }),
      sendMessengerReply: async () => ({ message_id: 'm1' }),
      sendTypingIndicator: async () => {},
      getUserFirstName: async () => 'T'
    },
    ...over
  };
}

console.log('\n🧪 Stage 4.3B.3 — persistence routing tests (mocked DB)\n');

// A + C + E + J + K + L + M (comment, escalate=true)
queries = []; channelRows = []; insertedChannels = []; updatedChannels = [];
await processComment({ comment_id: 'c1', message: 'x', from: { id: 'u1', name: 'U' }, created_time: 1700000000 }, ctx(), deps());
const chSel = queries.find(q => /SELECT id, brand_id FROM channels/.test(q.sql));
const chIns = queries.find(q => /INSERT INTO channels/.test(q.sql));
const custIns = queries.find(q => /INSERT INTO customers/.test(q.sql));
const convSel = queries.find(q => /SELECT id FROM conversations/.test(q.sql));
const convIns = queries.find(q => /INSERT INTO conversations/.test(q.sql));
const msgIns = queries.filter(q => /INSERT INTO messages/.test(q.sql));
const escIns = queries.find(q => /INSERT INTO escalations/.test(q.sql));
check('A. comment persistence uses ctx.tenantId (channel insert $1=tenant_1)', chIns.params[0] === 'tenant_1');
check('C. meta_comment channel uses ctx.pageId + ctx.tenantId', chSel.params[0] === 'tenant_1' && chSel.params[1] === 'meta_comment' && chSel.params[2] === 'page_1');
check('E. new conversation channel receives ctx.brandId', chIns.params[1] === 'brand_1' && chIns.params[2] === 'meta_comment');
check('J. customer creation uses ctx.tenantId', custIns.params[0] === 'tenant_1');
check('K. conversation creation uses ctx.tenantId', convIns.params[0] === 'tenant_1' && convSel.params[0] === 'tenant_1');
check('L. escalation DB record uses ctx.tenantId', escIns && escIns.params[0] === 'tenant_1');
check('M. inbound+outbound messages attached to resolved conversation conv_1', msgIns.length === 2 && msgIns.every(q => q.params[1] === 'conv_1') && msgIns.every(q => q.params[0] === 'tenant_1'));

// B + D (DM)
queries = []; channelRows = []; insertedChannels = []; updatedChannels = [];
await processMessage({ sender: { id: 'u9' }, message: { mid: 'mm1', text: 'hi' }, timestamp: 1700000000 }, ctx(), deps());
const dmChSel = queries.find(q => /SELECT id, brand_id FROM channels/.test(q.sql));
const dmMsgIns = queries.filter(q => /INSERT INTO messages/.test(q.sql));
check('B. DM persistence uses ctx.tenantId (messages $1=tenant_1)', dmMsgIns.length === 2 && dmMsgIns.every(q => q.params[0] === 'tenant_1'));
check('D. meta_dm channel uses ctx.pageId + ctx.tenantId', dmChSel.params[0] === 'tenant_1' && dmChSel.params[1] === 'meta_dm' && dmChSel.params[2] === 'page_1');

// F. existing channel with matching brandId succeeds, no write
queries = []; channelRows = [{ id: 'ch_keep', brand_id: 'brand_1' }]; updatedChannels = [];
const keptId = await findOrCreateChannel({ tenantId: 'tenant_9', provider: 'meta_dm', externalId: 'pg_F', displayName: 'x', brandId: 'brand_1' });
check('F. existing channel with matching brandId returned, no brand write', keptId === 'ch_keep' && updatedChannels.length === 0);

// G. existing NULL brandId safely backfilled
queries = []; channelRows = [{ id: 'ch_null', brand_id: null }]; updatedChannels = [];
const backfilled = await findOrCreateChannel({ tenantId: 'tenant_9', provider: 'meta_dm', externalId: 'pg_G', displayName: 'x', brandId: 'brand_1' });
check('G. NULL brand_id backfilled once, channel kept', backfilled === 'ch_null' && updatedChannels.length === 1 && updatedChannels[0][0] === 'brand_1' && updatedChannels[0][1] === 'ch_null');

// H. different non-null brandId fails closed, NOT reassigned
channelRows = [{ id: 'ch_other', brand_id: 'brand_X' }]; updatedChannels = [];
let hErr = null;
try { await findOrCreateChannel({ tenantId: 'tenant_9', provider: 'meta_dm', externalId: 'pg_H', displayName: 'x', brandId: 'brand_1' }); } catch (e) { hErr = e; }
check('H. different non-null brandId → CHANNEL_BRAND_MISMATCH, no reassignment', hErr?.code === 'CHANNEL_BRAND_MISMATCH' && updatedChannels.length === 0);

// I. channel from another tenant never reused (lookup is tenant-scoped)
queries = []; channelRows = []; insertedChannels = [];
const t2 = await findOrCreateChannel({ tenantId: 'tenant_OTHER', provider: 'meta_dm', externalId: 'pg_I', displayName: 'x', brandId: 'brand_1' });
const iSel = queries.find(q => /SELECT id, brand_id FROM channels/.test(q.sql));
check('I. lookup tenant-scoped (tenant_OTHER) → new channel created, none reused', iSel.params[0] === 'tenant_OTHER' && insertedChannels.length === 1 && insertedChannels[0].params[0] === 'tenant_OTHER');

// findOrCreateConversation missing-tenant guard
let gErr = null;
try { const c = await import('../src/services/conversations.js'); await c.findOrCreateConversation({ tenantId: undefined, channelId: 'c', externalKey: 'k', customerId: 'cu' }); } catch (e) { gErr = e; }
check('findOrCreateConversation missing tenantId → controlled MISSING_TENANT_ID', gErr?.code === 'MISSING_TENANT_ID');

// N. no getDefaultTenantId reachable in routed path (static)
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8');
  const calls = src.split('\n').filter(l => /getDefaultTenantId\s*\(/.test(l) && !/^\s*\/\//.test(l.trim()) && !/No getDefaultTenantId/.test(l));
  check('N. zero executable getDefaultTenantId() calls in webhook.js', calls.length === 0);
}

// O. 4.3B.2 compatibility — ctx.metaClient still used, ctx.pageId self-skip, buildRouteContext import
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8');
  check('O. ctx.metaClient outbound + buildRouteContext import preserved', src.includes('ctx.metaClient.replyToComment') && src.includes('buildRouteContext') && src.includes('ctx.pageId'));
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
