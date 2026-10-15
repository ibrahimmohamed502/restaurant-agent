/**
 * Stage 4.4.7 — manual delivery retry tests (mocked DB, zero network, zero Meta).
 * Run: node scripts/test-retry.mjs
 *
 * Safety: installs a stub pool (dummy DATABASE_URL) whose query is replaced with an
 * in-memory implementation. No sockets, no real DB, no Graph calls, no tokens.
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const { pool } = await import('../src/db/pg.js');
if (!pool) { console.error('stub pool missing'); process.exit(1); }

/* in-memory state */
const conversations = new Map();
const messages = new Map();
const channels = new Map();
let seq = 0;
const reset = () => { conversations.clear(); messages.clear(); channels.clear(); seq = 0; };
function seed({ tenantId = 't1', conversationId = 'conv1', channelId = 'ch1', provider = 'meta_comment', externalId = 'page_1', externalKey = 'cmt_1' }) {
  conversations.set(conversationId, { id: conversationId, tenant_id: tenantId, channel_id: channelId, external_key: externalKey });
  channels.set(channelId, { id: channelId, tenant_id: tenantId, provider, external_id: externalId, status: 'active' });
  return { tenantId, conversationId, channelId, provider, externalId, externalKey };
}
function addMsg({ tenantId = 't1', conversationId = 'conv1', direction = 'outbound', senderType = 'ai', text = 'hello', pmid = null, deliveryStatus = 'sent', deliveryError = null }) {
  const id = `m${++seq}`;
  messages.set(id, { id, tenant_id: tenantId, conversation_id: conversationId, direction, sender_type: senderType, text, provider_message_id: pmid, delivery_status: deliveryStatus, delivery_error: deliveryError, retry_count: 0, last_retry_at: null });
  return id;
}

pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ');
  if (/UPDATE messages m[\s\S]*FROM conversations c/.test(s)) {
    const [messageId, conversationId, tenantId] = params;
    const m = messages.get(messageId);
    const c = conversations.get(conversationId);
    if (!m || !c || m.conversation_id !== conversationId || m.tenant_id !== tenantId || c.tenant_id !== tenantId) return { rows: [] };
    if (m.direction !== 'outbound' || m.sender_type !== 'ai' || m.delivery_status !== 'failed') return { rows: [] };
    // Mirror the REAL SQL gate: delivery_error must be in the allow-list.
    // Without this the fake would happily 'retry' rows production refuses, which
    // is exactly the defect this change exists to close.
    const allowed = params[3] ?? [];
    if (!allowed.includes(m.delivery_error)) return { rows: [] };
    m.delivery_status = 'pending'; m.delivery_error = null; m.retry_count += 1; m.last_retry_at = new Date();
    return { rows: [{ id: m.id, conversation_id: m.conversation_id, tenant_id: m.tenant_id, text: m.text, retry_count: m.retry_count, provider_message_id: m.provider_message_id }] };
  }
  if (/UPDATE messages[\s\S]*SET delivery_status/.test(s)) {
    const [deliveryStatus, deliveryError, pmid, messageId, tenantId] = params;
    const m = messages.get(messageId);
    if (!m || m.tenant_id !== tenantId || m.direction !== 'outbound') return { rows: [] };
    m.delivery_status = deliveryStatus; m.delivery_error = deliveryError; if (pmid) m.provider_message_id = pmid;
    return { rows: [{ id: m.id, delivery_status: m.delivery_status, provider_message_id: m.provider_message_id, delivery_error: m.delivery_error, retry_count: m.retry_count, last_retry_at: m.last_retry_at }] };
  }
  if (/SELECT c.id AS conversation_id/.test(s)) {
    const [conversationId, tenantId] = params;
    const c = conversations.get(conversationId);
    if (!c || c.tenant_id !== tenantId) return { rows: [] };
    const ch = channels.get(c.channel_id);
    return { rows: [{ conversation_id: c.id, tenant_id: c.tenant_id, external_key: c.external_key, channel_id: c.channel_id, provider: ch.provider, external_id: ch.external_id, status: ch.status }] };
  }
  if (/SELECT/.test(s)) return { rows: [] };
  return { rows: [] };
};

const { claimFailedOutboundForRetry, finishMessageDelivery, getConversationChannelContext, deliveryErrorCategory } = await import('../src/services/conversations.js');
const { isRetryableDeliveryCategory } = await import('../src/services/deliveryOutcome.js');
const { createMetaClient } = await import('../src/facebook.js');

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };
const S = { tenantId: 't1', conversationId: 'conv1', channelId: 'ch1' };

console.log('\n🧪 Stage 4.4.7 — manual delivery retry\n');

// failed → claimable
reset(); seed(S);
const failedId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
const claimed = await claimFailedOutboundForRetry({ ...S, messageId: failedId });
check('failed outbound can be claimed for retry', claimed?.id === failedId && claimed.text === 'hello' && claimed.retry_count === 1);

// ---- THE RETRY GATE: only a provably-safe refusal may be re-sent ----
// Auth/permission: Meta refused, but re-sending cannot succeed until a human
// fixes the credential — and each attempt risks duplicating a delivered reply.
reset(); seed(S);
const permId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_auth_expired' });
check('permanent refusal (auth) is NOT retryable', (await claimFailedOutboundForRetry({ ...S, messageId: permId })) === null);
reset(); seed(S);
const permId2 = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_permission' });
check('permanent refusal (permission) is NOT retryable', (await claimFailedOutboundForRetry({ ...S, messageId: permId2 })) === null);

// Outcome never established: the customer may already have the reply.
reset(); seed(S);
const unknownId = addMsg({ deliveryStatus: 'pending', deliveryError: 'delivery_unknown' });
check('unknown delivery outcome is NOT retryable', (await claimFailedOutboundForRetry({ ...S, messageId: unknownId })) === null && messages.get(unknownId).delivery_status === 'pending');

// A legacy row with no category must fail closed, not open.
reset(); seed(S);
const nullCatId = addMsg({ deliveryStatus: 'failed', deliveryError: null });
check('a failed row with no category is NOT retryable', (await claimFailedOutboundForRetry({ ...S, messageId: nullCatId })) === null);

// sent → not claimable
reset(); seed(S);
const sentId = addMsg({ deliveryStatus: 'sent', pmid: 'p1' });
check('sent outbound cannot be retried', (await claimFailedOutboundForRetry({ ...S, messageId: sentId })) === null);

// pending → not claimable
reset(); seed(S);
const pendingId = addMsg({ deliveryStatus: 'pending' });
check('pending outbound cannot be retried', (await claimFailedOutboundForRetry({ ...S, messageId: pendingId })) === null);

// wrong tenant → not claimable
reset(); seed(S);
const foreignId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
check('wrong tenant cannot retry', (await claimFailedOutboundForRetry({ ...S, tenantId: 'OTHER', messageId: foreignId })) === null);

// inbound → not claimable
reset(); seed(S);
const inId = addMsg({ direction: 'inbound', senderType: 'customer', deliveryStatus: 'sent' });
check('inbound messages cannot be retried', (await claimFailedOutboundForRetry({ ...S, messageId: inId })) === null);

// double claim → only first wins (concurrency/idempotency)
reset(); seed(S);
const dupId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
const [a, b] = await Promise.all([
  claimFailedOutboundForRetry({ ...S, messageId: dupId }),
  claimFailedOutboundForRetry({ ...S, messageId: dupId })
]);
check('double retry claim → exactly one winner', (a ? 1 : 0) + (b ? 1 : 0) === 1 && messages.get(dupId).retry_count === 1);

// success path → sent + provider id + error cleared
reset(); seed(S);
const okId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
await claimFailedOutboundForRetry({ ...S, messageId: okId });
const done = await finishMessageDelivery({ tenantId: 't1', messageId: okId, deliveryStatus: 'sent', providerMessageId: 'new_1' });
check('successful retry → sent + provider id + error cleared', done.delivery_status === 'sent' && done.provider_message_id === 'new_1' && done.delivery_error === null);

// failure path → failed + sanitized category
reset(); seed(S);
const badId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
await claimFailedOutboundForRetry({ ...S, messageId: badId });
const bad = await finishMessageDelivery({ tenantId: 't1', messageId: badId, deliveryStatus: 'failed', errorCategory: 'delivery_unknown' });
check('failed retry → failed + sanitized category', bad.delivery_status === 'failed' && bad.delivery_error === 'delivery_unknown');

// retry_count increments only across attempts the gate actually allows.
// The old test flipped the row back to 'failed' with a NULL category, which the
// gate now refuses; that refusal is itself the property worth asserting.
reset(); seed(S);
const rcId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
await claimFailedOutboundForRetry({ ...S, messageId: rcId });
messages.get(rcId).delivery_status = 'failed'; // category left NULL by the claim
const refused = await claimFailedOutboundForRetry({ ...S, messageId: rcId });
check('a retried row with no category is NOT re-claimed', refused === null && messages.get(rcId).retry_count === 1);

// A second DEFINITIVE refusal (still rate limited) is claimable again, and the
// counter keeps climbing — the gate blocks ambiguity, not legitimate retries.
messages.get(rcId).delivery_error = 'meta_rate_limit';
const again = await claimFailedOutboundForRetry({ ...S, messageId: rcId });
check('retry_count increments per allowed claim', again?.retry_count === 2 && messages.get(rcId).retry_count === 2 && messages.get(rcId).last_retry_at instanceof Date);

// A retry whose own outcome was never established must not be re-sent.
reset(); seed(S);
const unkId = addMsg({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' });
await claimFailedOutboundForRetry({ ...S, messageId: unkId });
await finishMessageDelivery({ tenantId: 't1', messageId: unkId, deliveryStatus: 'pending', errorCategory: 'delivery_unknown' });
check('an unknown outcome on retry ends the retry chain',
  (await claimFailedOutboundForRetry({ ...S, messageId: unkId })) === null &&
  messages.get(unkId).delivery_status === 'pending' &&
  messages.get(unkId).retry_count === 1);

// context resolution is tenant-scoped
reset(); seed(S);
check('conversation context resolved for own tenant', (await getConversationChannelContext({ tenantId: 't1', conversationId: 'conv1' }))?.provider === 'meta_comment');
check('conversation context NOT resolved for other tenant', (await getConversationChannelContext({ tenantId: 'OTHER', conversationId: 'conv1' })) === null);

// current DB credential used (no env fallback inside retry client path)
{
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8'));
  const routeBody = src.slice(src.indexOf('/messages/:messageId/retry'));
  check('retry route re-resolves Meta credential from DB (no env token)', /resolveMetaChannel\(/.test(routeBody) && /createMetaClient\(\{ accessToken: resolved\.credential \}\)/.test(routeBody) && !/FB_PAGE_ACCESS_TOKEN/.test(routeBody));
  check('retry route requires auth + tenant scope', /requireAuth/.test(routeBody) && /req\.auth\?\.tenantId/.test(routeBody));
}

// UI retry button only for failed outbound; no raw technical errors
{
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8'));
  check('retry button rendered only on failed outbound', /delivery_status === 'failed'/.test(src) && /retrybtn/.test(src) && /retrybtn/.test(src.slice(src.indexOf("delivery_status === 'failed'"))) );
  check('no token/secret exposure in UI strings', !/token|secret|password|access_token/i.test(src.match(/إعادة المحاولة[\s\S]{0,80}/)?.[0] ?? ''));
}

// deliveryErrorCategory mapping
check('category: meta_auth_expired', deliveryErrorCategory(new Error('Graph API 401 session expired')) === 'meta_auth_expired');  // Both used to be ordinary failure categories, which the dashboard offered for
  // retry. A 5xx or a dropped connection means the outcome was never established,
  // so both now classify as delivery_unknown — which is not retryable.
  check('category: 5xx is delivery_unknown (outcome never established)',
    deliveryErrorCategory(new Error('Graph API 500 (code 1)')) === 'delivery_unknown');
  check('category: transport failure is delivery_unknown', deliveryErrorCategory(new Error('fetch failed')) === 'delivery_unknown');
  check('no retryable category can be produced by an ambiguous failure',
    !isRetryableDeliveryCategory(deliveryErrorCategory(new Error('Graph API 500 (code 1)'))));

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
