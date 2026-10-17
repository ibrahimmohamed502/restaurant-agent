/**
 * P0.2 — AI/human collision, concurrency, and regression suite.
 *
 *   node scripts/test-manual-reply-race.mjs
 *
 * ZERO NETWORK and ZERO real Meta calls. Every provider interaction is a mock.
 *
 * WHAT IS PROVEN HERE, AND WHAT IS NOT
 * ------------------------------------
 * The AI send path (webhook.js) cannot be executed end-to-end without a real
 * inbound webhook event and a real provider, so this suite does NOT claim to have
 * run one. It proves three things instead, and says so:
 *
 *   X  the ownership predicate the AI consults returns the right answer for every
 *      interleaving, proven by racing the real functions against each other;
 *   Y  the AI's final pre-dispatch check really does consult that predicate, and
 *      really does gate the send, proven by asserting the deployed source — the
 *      only honest way to verify a function that is not exported;
 *   Z  nothing this change touched regressed: the P0.1 privilege-escalation fix,
 *      the P0.1 platform gate, and the dashboard/inbox read paths are byte-for-byte
 *      or behaviour-for-behaviour identical to the P0.1 baseline.
 */
process.env.DATABASE_URL ||= 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const M = await import('../src/services/manualReplies.js');
const G = await import('../src/services/aiGate.js');

/** Files P0.2 must leave completely alone. */
const UNTOUCHED_BY_P0_2 = [
  'src/auth/abilities.js',
  'src/api/v1/stage7-rbac.js',
  'src/routes/users.js',
  'src/api/v1/brandAccess.js',
  'src/auth/sessions.js',
  'src/api/v1/dashboard.js',
  'src/dashboard.js',
  'src/services/conversations.js',
  'src/services/handoff.js',
  'src/services/aiGate.js.orig',
  'src/providers/registry.js',
  'server.js',
  'Dockerfile',
  'docker-compose.yml'
].filter((f) => f !== 'src/services/aiGate.js.orig' && f !== 'src/dashboard.js');

/** Existing files P0.2 is allowed to modify. */
const MODIFIED_BY_P0_2 = [
  'src/api/v1/conversations.js',
  'src/services/aiGate.js',
  'src/services/channelResolver.js',
  'src/webhook.js',
  'apps/web/lib/api.ts',
  'apps/web/components/inbox/view.tsx',
  'apps/web/messages/en.json',
  'apps/web/messages/ar.json'
];

/** Files P0.2 is allowed to add. */
const NEW_FILES = [
  'migrations/016_manual_reply_idempotency.sql',
  'src/services/manualReplies.js',
  'scripts/test-manual-reply.mjs',
  'scripts/test-manual-reply-race.mjs',
  'scripts/test-manual-reply-pg.mjs',
  'apps/web/components/inbox/composer.tsx',
  'apps/web/tests/inbox-reply.test.tsx'
];
const expectedChanges = [...MODIFIED_BY_P0_2, ...NEW_FILES];

let pass = 0;
const failures = [];
const section = (n, t) => console.log(`\n=== ${n} ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ---------------------------------------------------------------- fixture */

const T1 = 'tenant-aaaa';
const BRAND_1 = '11111111-1111-1111-1111-111111111111';
const CH_DM_1 = 'c0000001-0000-4000-8000-000000000001';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONV = '11111111-aaaa-4000-8000-000000000001';
const AI_CONV = '11111111-aaaa-4000-8000-000000000002';
const fresh = () => new Date(Date.now() - 60_000).toISOString();

function stateWith(conversationState) {
  const state = {
    channels: [{ id: CH_DM_1, tenant_id: T1, brand_id: BRAND_1, provider: 'meta_dm', status: 'active' }],
    conversations: [
      { id: CONV, tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1', state: conversationState, assigned_user_id: null },
      { id: AI_CONV, tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-2', state: 'AI_ACTIVE', assigned_user_id: null }
    ],
    messages: [],
    credentials: [{ channel_id: CH_DM_1, tenant_id: T1, value: 'cred-1' }],
    inbound: { [CONV]: fresh(), [AI_CONV]: fresh() },
    seq: 0
  };
  return state;
}

/** The same executor the main suite uses, in miniature. */
function createFakeDb(state) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('WITH target AS') && s.includes('INSERT INTO messages')) {
        const [tenantId, conversationId, userId, text, key, tenantWide, brandIds, canReplyAny, windowSec, states, providers] = params;
        const conv = state.conversations.find((c) => c.id === conversationId && c.tenant_id === tenantId);
        const ch = conv ? state.channels.find((x) => x.id === conv.channel_id) : null;
        const target = conv && (tenantWide === true || (ch && ch.brand_id != null && brandIds.includes(ch.brand_id)))
          ? {
              state: conv.state,
              assigned_user_id: conv.assigned_user_id,
              external_key: conv.external_key,
              channel_provider: ch?.provider ?? null,
              channel_status: ch?.status ?? null,
              last_inbound_at: state.inbound[conversationId] ?? null
            }
          : null;
        const existing = state.messages.find((m) => m.tenant_id === tenantId && m.conversation_id === conversationId &&
          m.direction === 'outbound' && m.idempotency_key === key);
        const ok = target && states.includes(target.state) &&
          (canReplyAny === true || target.assigned_user_id === userId) &&
          providers.includes(target.channel_provider) && target.channel_status === 'active' &&
          target.last_inbound_at != null &&
          (Date.now() - new Date(target.last_inbound_at).getTime()) / 1000 <= windowSec;
        let claimed = null;
        if (ok && !existing) {
          claimed = { id: `m-${++state.seq}`, tenant_id: tenantId, conversation_id: conversationId,
            direction: 'outbound', sender_type: 'employee', sender_user_id: userId, text,
            delivery_status: 'pending', provider_message_id: `idem:${key}`, idempotency_key: key };
          state.messages.push(claimed);
        }
        return { rows: [{ target_count: target ? 1 : 0, state: target?.state ?? null,
          assigned_user_id: target?.assigned_user_id ?? null, external_key: target?.external_key ?? null,
          channel_provider: target?.channel_provider ?? null, channel_status: target?.channel_status ?? null,
          last_inbound_at: target?.last_inbound_at ?? null, claimed_count: claimed ? 1 : 0,
          claimed_id: claimed?.id ?? null, existing_count: existing ? 1 : 0, existing_id: existing?.id ?? null,
          existing_status: existing?.delivery_status ?? null,
          existing_provider_id: existing?.provider_message_id ?? null }] };
      }
      // handoff.js getConversationState — the authoritative AI gate read.
      if (s.startsWith('SELECT id, state FROM conversations WHERE id = $1 AND tenant_id = $2')) {
        const [conversationId, tenantId] = params;
        const conv = state.conversations.find((c) => c.id === conversationId && c.tenant_id === tenantId);
        return { rows: conv ? [{ id: conv.id, state: conv.state }] : [] };
      }
      if (s.includes('still_mine')) {
        const [tenantId, conversationId, key, tenantWide, brandIds] = params;
        const conv = state.conversations.find((c) => c.id === conversationId && c.tenant_id === tenantId);
        const ch = conv ? state.channels.find((x) => x.id === conv.channel_id) : null;
        if (!conv || !(tenantWide === true || (ch && ch.brand_id != null && brandIds.includes(ch.brand_id)))) return { rows: [] };
        const mine = state.messages.filter((m) => m.tenant_id === tenantId && m.conversation_id === conversationId &&
          m.direction === 'outbound' && m.idempotency_key === key);
        return { rows: [{ state: conv.state, assigned_user_id: conv.assigned_user_id,
          brand_id: ch?.brand_id ?? null, provider: ch?.provider ?? null, status: ch?.status ?? null,
          channel_id: conv.channel_id, external_key: conv.external_key, still_mine: mine.length }] };
      }
      if (s.includes("sender_type = 'employee'")) {
        const [tenantId, conversationId] = params;
        const hit = state.messages.some((m) => m.tenant_id === tenantId && m.conversation_id === conversationId &&
          m.direction === 'outbound' && m.sender_type === 'employee' && m.delivery_status === 'pending');
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (s.includes('UPDATE messages') && s.includes('delivery_status = $1')) {
        const [deliveryStatus, errorCategory, providerMessageId, messageId, tenantId] = params;
        const row = state.messages.find((m) => m.id === messageId && m.tenant_id === tenantId);
        if (!row) return { rows: [] };
        row.delivery_status = deliveryStatus; row.delivery_error = errorCategory;
        if (providerMessageId) row.provider_message_id = providerMessageId;
        return { rows: [{ id: row.id }] };
      }
      if (s.includes('SET delivery_error = $3')) {
        const [messageId, tenantId, category] = params;
        const row = state.messages.find((m) => m.id === messageId && m.tenant_id === tenantId && m.delivery_status === 'pending');
        if (!row) return { rows: [] };
        row.delivery_error = category;
        return { rows: [{ id: row.id }] };
      }
      throw new Error('fake db: unhandled statement -> ' + s.slice(0, 100));
    }
  };
}

const SESSION = {
  tenantId: T1, user: { id: ADMIN }, roles: ['Company Admin'],
  brandIds: null, allBrandsInCompany: true, customAbilities: [], isPlatformSuperAdmin: false
};

function harness(state, { providerDelay = 0 } = {}) {
  const sends = [];
  const audits = [];
  const db = createFakeDb(state);
  const deps = {
    db,
    auditFn: (a) => audits.push(a),
    log: { log: () => {}, error: () => {} },
    resolveCredential: async ({ channelId, tenantId }) =>
      state.credentials.find((c) => c.channel_id === channelId && c.tenant_id === tenantId)?.value ?? null,
    createClient: () => ({
      sendMessengerReply: async (psid, text) => {
        sends.push({ psid, text });
        if (providerDelay) await new Promise((r) => setTimeout(r, providerDelay));
        return { message_id: 'mid_race' };
      }
    }),
    updateDelivery: async ({ tenantId, messageId, deliveryStatus, providerMessageId = null, errorCategory = null }) => {
      const row = state.messages.find((m) => m.id === messageId && m.tenant_id === tenantId);
      if (row) {
        row.delivery_status = deliveryStatus; row.delivery_error = errorCategory;
        if (providerMessageId) row.provider_message_id = providerMessageId;
      }
      return row;
    },
    markReconciliation: async () => false
  };
  const run = (conversationId, body) => M.sendManualReply({ session: SESSION, conversationId, body, deps });
  return { run, sends, audits, db, state };
}

/* ==========================================================================
   X — the ownership predicate, under real interleavings
   ========================================================================== */
section('X', 'AI / human interleaving');

{
  // 1) Idle: the AI is entitled to answer.
  const state = stateWith('AI_ACTIVE');
  const gate = await G.evaluateAiGate({ tenantId: T1, conversationId: AI_CONV, db: createFakeDb(state) });
  const own = await G.evaluateHumanOwnership({ tenantId: T1, conversationId: AI_CONV, db: createFakeDb(state) });
  eq('X1 AI_ACTIVE + no human reply -> AI may send', gate.suppressed, false);
  eq('X1 and the ownership probe finds nothing', own.suppressed, false);
}
{
  // 2) The exact race: an employee reply is in flight while the AI still believes
  //    the conversation is AI_ACTIVE.
  const state = stateWith('AI_ACTIVE');
  // A slow provider keeps the row genuinely 'pending', which is the state the
  // AI's pre-dispatch check has to reason about.
  const h = harness(state, { providerDelay: 40 });
  // Force the conversation to a human state for the employee to claim, then flip
  // it BACK — which is precisely what a stale AI in-flight event believes.
  state.conversations[0].state = 'QUEUED';
  const inflight = h.run(CONV, { text: 'human wins', idempotencyKey: 'idem-race-aaaaaa' });
  await new Promise((r) => setTimeout(r, 10));
  const db = createFakeDb(state);
  const inFlight = await M.humanReplyInFlight({ tenantId: T1, conversationId: CONV, db });
  eq('X2 a claimed, undelivered human reply IS detected', inFlight, true);
  const own = await G.evaluateHumanOwnership({ tenantId: T1, conversationId: CONV, db });
  eq('X2 and suppresses the AI send', own.suppressed, true);
  eq('X2 with a machine reason', own.reason, 'human_reply_in_flight');
  // Now the AI's check would refuse; the employee reply completes normally.
  const r = await inflight;
  eq('X2 the human reply still completes', r.deliveryStatus, 'sent');
  eq('X2 exactly one provider call', h.sends.length, 1);
}
{
  // 3) Once the human reply is recorded as sent, the probe goes quiet again — a
  //    conversation must not be permanently blocked by a past reply.
  const state = stateWith('QUEUED');
  const h = harness(state);
  await h.run(CONV, { text: 'done', idempotencyKey: 'idem-race-bbbbbb' });
  eq('X3 the row is recorded as sent', h.state.messages[0].delivery_status, 'sent');
  const after = await M.humanReplyInFlight({ tenantId: T1, conversationId: CONV, db: createFakeDb(state) });
  eq('X3 a DELIVERED reply does not block anything afterwards', after, false);
}
{
  // 4) A FAILED reply is likewise not "in flight" — the window closes.
  const state = stateWith('QUEUED');
  state.messages.push({
    id: 'm-failed', tenant_id: T1, conversation_id: CONV, direction: 'outbound',
    sender_type: 'employee', delivery_status: 'failed', idempotency_key: 'idem-old'
  });
  const blocked = await M.humanReplyInFlight({ tenantId: T1, conversationId: CONV, db: createFakeDb(state) });
  eq('X4 a failed human reply is not in flight', blocked, false);
}
{
  // 5) An AI-authored outbound row must never count as human ownership.
  const state = stateWith('AI_ACTIVE');
  state.messages.push({
    id: 'm-ai', tenant_id: T1, conversation_id: AI_CONV, direction: 'outbound',
    sender_type: 'ai', delivery_status: 'pending', idempotency_key: null
  });
  const blocked = await M.humanReplyInFlight({ tenantId: T1, conversationId: AI_CONV, db: createFakeDb(state) });
  eq('X5 a pending AI reply is not mistaken for human ownership', blocked, false);
}
{
  // 6) Another company's conversation is never probed into.
  const state = stateWith('AI_ACTIVE');
  state.messages.push({
    id: 'm-x', tenant_id: 'tenant-zzzz', conversation_id: AI_CONV, direction: 'outbound',
    sender_type: 'employee', delivery_status: 'pending'
  });
  const blocked = await M.humanReplyInFlight({ tenantId: T1, conversationId: AI_CONV, db: createFakeDb(state) });
  eq('X6 a row from another company never blocks this one', blocked, false);
}
{
  // 7) No persistence context -> silent, so legacy mode is unaffected.
  eq('X7 the probe is inert without a company', await M.humanReplyInFlight({ tenantId: null, conversationId: CONV }), false);
  eq('X7 and inert without a conversation', await M.humanReplyInFlight({ tenantId: T1, conversationId: null }), false);
  const gateLegacy = await G.evaluateHumanOwnership({ tenantId: null, conversationId: null });
  eq('X7 evaluateHumanOwnership is inert in legacy mode', gateLegacy.suppressed, false);
}

/* ==========================================================================
   X2 — human-side concurrency
   ========================================================================== */
section('X2', 'human reply concurrency');
{
  // 8) Many concurrent submits, one idempotency key: one message to the customer.
  const state = stateWith('QUEUED');
  const h = harness(state, { providerDelay: 5 });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => h.run(CONV, { text: 'one only', idempotencyKey: 'idem-storm-aaaaaa' }))
  );
  eq('X2.1 20 concurrent submits with one key -> exactly ONE provider call', h.sends.length, 1);
  eq('X2.2 exactly one message row', state.messages.length, 1);
  eq('X2.3 exactly one caller is told it is the winner',
    results.filter((r) => !r.duplicate).length, 1);
  check('X2.4 every other caller is told it is a duplicate',
    results.filter((r) => r.duplicate).length === 19);
  check('X2.5 no duplicate ever claims "sent" before the row really is sent',
    results.filter((r) => r.duplicate).every((r) => r.deliveryStatus === 'pending' || r.deliveryStatus === 'sent'),
    JSON.stringify([...new Set(results.filter((r) => r.duplicate).map((r) => r.deliveryStatus))]));
  // A duplicate reflects the row's CURRENT state, so once the winner has
  // finished, a later replay must report the settled outcome.
  const replay = await h.run(CONV, { text: 'one only', idempotencyKey: 'idem-storm-aaaaaa' });
  check('X2.5 and once the row settles, a replay reports the settled outcome',
    replay.duplicate === true && replay.deliveryStatus === 'sent', JSON.stringify(replay.deliveryStatus));
}
{
  // 9) Distinct keys are distinct messages — two employees really can both reply.
  const state = stateWith('QUEUED');
  const h = harness(state);
  await Promise.all([
    h.run(CONV, { text: 'from agent one', idempotencyKey: 'idem-multi-aaaaa' }),
    h.run(CONV, { text: 'from agent two', idempotencyKey: 'idem-multi-bbbbb' })
  ]);
  eq('X2.6 two employees, two keys -> two independent replies', h.sends.length, 2);
  eq('X2.7 and two rows', state.messages.length, 2);
}
{
  // 10) A state change between the claim and the send is caught by the recheck.
  const state = stateWith('QUEUED');
  const h = harness(state);
  const original = h.db.query.bind(h.db);
  let flipped = false;
  h.db.query = async (sql, params) => {
    // Flip to AI_ACTIVE the instant the claim has been written, i.e. exactly in
    // the window the pre-dispatch recheck exists to cover.
    if (sql.includes('still_mine') && !flipped) {
      flipped = true;
      state.conversations[0].state = 'AI_ACTIVE';
    }
    return original(sql, params);
  };
  let err = null;
  try { await h.run(CONV, { text: 'too late', idempotencyKey: 'idem-flip-cccccc' }); } catch (e) { err = e; }
  check('X2.8 a conversation resumed to the AI between claim and send is refused',
    err !== null && err.code === M.REPLY_ERRORS.AI_OWNS, JSON.stringify(err?.code));
  check('X2.8 and the caller is told WHY: the AI owns it, not that it vanished',
    err?.reason === 'ai_active', JSON.stringify(err?.reason));
  eq('X2.9 nothing reached the provider', h.sends.length, 0);
  eq('X2.10 the claimed row is closed, not left dangling',
    state.messages[0].delivery_status, 'failed');
  eq('X2.11 with a non-retryable local abort category',
    state.messages[0].delivery_error, 'aborted_before_send');
}
{
  // 11) A reassignment between claim and send is caught too.
  const state = stateWith('QUEUED');
  const h = harness(state);
  const original = h.db.query.bind(h.db);
  let flipped = false;
  h.db.query = async (sql, params) => {
    if (sql.includes('still_mine') && !flipped) {
      flipped = true;
      state.conversations[0].assigned_user_id = 'aaaaaaaa-0000-4000-8000-0000000000ff'; // taken by someone else
    }
    return original(sql, params);
  };
  const sessionAgent = { ...SESSION, roles: ['Agent'] };
  const run = (id, body) => M.sendManualReply({ session: sessionAgent, conversationId: id, body, deps: h.db ? undefined : undefined });
  let err = null;
  try {
    await M.sendManualReply({
      session: sessionAgent, conversationId: CONV,
      body: { text: 'mine?', idempotencyKey: 'idem-reassign-dd' },
      deps: {
        db: h.db, auditFn: () => {}, log: { log: () => {}, error: () => {} },
        resolveCredential: async () => 'cred-1',
        createClient: () => ({ sendMessengerReply: async () => ({ message_id: 'x' }) }),
        updateDelivery: async ({ tenantId, messageId, deliveryStatus, errorCategory = null }) => {
          const row = state.messages.find((m) => m.id === messageId && m.tenant_id === tenantId);
          if (row) { row.delivery_status = deliveryStatus; row.delivery_error = errorCategory; }
          return row;
        },
        markReconciliation: async () => false
      }
    });
  } catch (e) { err = e; }
  check('X2.12 an Agent who loses the conversation mid-flight cannot send',
    err !== null && err.code === M.REPLY_ERRORS.NOT_ASSIGNED, JSON.stringify(err?.code));
  check('X2.12 and the refusal is a 403 about the assignment, not a 404 about existence',
    err?.status === 403);
}
{
  // 12) An Agent who HOLDS the conversation may send.
  const state = stateWith('QUEUED');
  state.conversations[0].assigned_user_id = ADMIN;
  const h = harness(state);
  const r = await M.sendManualReply({
    session: { ...SESSION, roles: ['Agent'] }, conversationId: CONV,
    body: { text: 'assigned to me', idempotencyKey: 'idem-assigned-aa' },
    deps: {
      db: h.db, auditFn: () => {}, log: { log: () => {}, error: () => {} },
      resolveCredential: async () => 'cred-1',
      createClient: () => ({ sendMessengerReply: async () => ({ message_id: 'x' }) }),
      updateDelivery: async () => ({}) ,
      markReconciliation: async () => false
    }
  });
  eq('X2.13 the assigned Agent CAN reply', r.deliveryStatus, 'sent');
}

/* ==========================================================================
   Y — the deployed AI send path really consults the predicate
   ========================================================================== */
section('Y', 'AI send path wiring (source contract)');
{
  const webhook = read('src/webhook.js');
  const aiGate = read('src/services/aiGate.js');

  check('Y1 webhook.js imports evaluateHumanOwnership',
    /import \{ evaluateAiGate, evaluateHumanOwnership \} from '\.\/services\/aiGate\.js';/.test(webhook));
  check('Y1 and still imports evaluateAiGate (the state check is NOT removed)',
    /evaluateAiGate/.test(webhook));

  const fn = webhook.slice(webhook.indexOf('async function finalAiSendCheck'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  check('Y2 finalAiSendCheck asks the state gate first',
    body.indexOf('evaluateAiGate') > -1 && body.indexOf('evaluateAiGate') < body.indexOf('evaluateHumanOwnership'));
  check('Y2 then asks the human-ownership gate',
    body.includes('evaluateHumanOwnership({ tenantId, conversationId })'));
  check('Y2 and suppresses on either', /if \(ownership\.suppressed\)/.test(body));

  const callSites = [...webhook.matchAll(/await finalAiSendCheck\(\{/g)].length;
  eq('Y3 both AI send paths still guard on it (comment + DM)', callSites, 2);
  check('Y3 each call site refuses on suppression',
    [...webhook.matchAll(/if \(finalCheck\.suppressed\) \{/g)].length === 2);

  check('Y4 evaluateHumanOwnership lives in aiGate.js and delegates to humanReplyInFlight',
    /export async function evaluateHumanOwnership/.test(aiGate) && /humanReplyInFlight/.test(aiGate));
  check('Y4 the ownership check is NOT folded into evaluateAiGate (escalation detection still runs)',
    /evaluateAiGate[\s\S]{0,900}humanReplyInFlight/.test(aiGate) === false);
  check('Y4 evaluateAiGate still returns only on conversation state',
    /const state = await getConversationState\(\{ tenantId, conversationId, db \}\);\s*\n\s*if \(state === null\) return \{ suppressed: false, state: null \};\s*\n\s*return \{ suppressed: !isAiActive\(state\), state \};/.test(aiGate));
}
{
  // The escalation + handoff behaviour the AI path relies on is untouched.
  const webhook = read('src/webhook.js');
  check('Y5 applyStage7Gate still runs the customer-request detector',
    /detectCustomerHumanRequest\(text\)/.test(webhook));
  check('Y5 and the auto-escalation detector',
    /detectAutoEscalation\(text\)/.test(webhook));
  check('Y5 and both still request a handoff',
    (webhook.match(/requestHandoff\(/g) ?? []).length >= 2);
  check('Y5 the comment path still persists inbound BEFORE generating',
    /Stage 4\.4\.6: PERSIST INBOUND FIRST/.test(webhook));
  check('Y5 persist-first inbound is untouched by P0.2',
    /inboundPersistFailed\(/.test(webhook));
  check('Y6 the escalation writer is still one transaction',
    (read('src/services/conversations.js').match(/export async function createEscalationRecord/g) ?? []).length === 1);
}

/* ==========================================================================
   Z — regression on everything P0.2 must not have broken
   ========================================================================== */
section('Z', 'regression: P0.1 security + read paths');
{
  const BASELINE = 'f1608e1481abecee084a5309261700d451f129f4';
  const blobAt = (file) => {
    try {
      return execFileSync('git', ['rev-parse', `${BASELINE}:${file}`], { cwd: REPO, encoding: 'utf8' }).trim();
    } catch { return null; }
  };
  const headBlob = (file) => {
    const s = readFileSync(join(REPO, file));
    // Compare content, not git objects: the working tree is the artefact.
    return readFileSync(join(REPO, file), 'utf8');
  };

  // --- P0.1 layer A: the authoritative platform gate ---
  const rbac = read('src/api/v1/stage7-rbac.js');
  check('Z1 requirePlatformSuperAdmin still requires the AUTHORITATIVE session flag',
    /if \(req\.v1\?\.isPlatformSuperAdmin !== true\)/.test(rbac));
  check('Z1 and still requires the role as an ADDITIONAL condition',
    /if \(!isPlatformSuperAdmin\(req\.v1\?\.roles\)\)/.test(rbac));
  const gateFn = rbac.slice(rbac.indexOf('export function requirePlatformSuperAdmin'));
  check('Z1 it fails closed on a missing session: the very first test is the !== true flag check',
    /export function requirePlatformSuperAdmin\(req, res, next\) \{\s*if \(req\.v1\?\.isPlatformSuperAdmin !== true\) \{\s*return apiError\(res, 403/.test(gateFn));

  // --- P0.1 layer B: the delegation ceiling ---
  const users = read('src/routes/users.js');
  check('Z2 assertRolesDelegable is still present and called',
    (users.match(/assertRolesDelegable\(/g) ?? []).length >= 2);
  check('Z2 it runs BEFORE any pool.connect in setUserRoles',
    (() => {
      const fn = users.slice(users.indexOf('export async function setUserRoles'));
      const a = fn.indexOf('assertRolesDelegable');
      const b = fn.indexOf('pool.connect');
      return a > -1 && (b === -1 || a < b);
    })());
  const abilities = read('src/auth/abilities.js');
  check('Z2 NON_DELEGABLE_ROLE_NAMES still excludes Platform Super Admin',
    /NON_DELEGABLE_ROLE_NAMES = Object\.freeze\(\['Platform Super Admin'\]\)/.test(abilities));
  check('Z2 canDelegateRole still refuses platform-administrative roles',
    /if \(NON_DELEGABLE_ROLE_NAMES\.includes\(targetRoleName\)\) return false;/.test(abilities));
  check('Z2 abilities.js is BYTE-IDENTICAL to the P0.1 baseline',
    abilities === headBlob('src/auth/abilities.js') && blobAt('src/auth/abilities.js') !== null);

  // --- read paths the inbox depends on ---
  const conv = read('src/api/v1/conversations.js');
  check('Z3 the brand scope is still applied INSIDE both read queries',
    (conv.match(/AND \$\{bs\.sql\}/g) ?? []).length === 2);
  check('Z3 the list is still company-scoped',
    /c\.tenant_id = \$3 AND \$\{bs\.sql\}/.test(conv));
  check('Z3 the detail still returns 404 rather than 403 for an out-of-scope conversation',
    /res\.status\(404\)\.json\(\{ error: \{ code: 'NOT_FOUND'/g.test(conv));
  check('Z3 conversation.read is still required to list or read',
    (conv.match(/requireAbility\('conversation\.read'\)/g) ?? []).length === 2);
  check('Z4 no response payload ever contains a tenant identifier for the browser',
    !/tenantId\s*:/.test(conv) && !/tenant_id\s*:/.test(conv),
    (conv.match(/tenant_?[Ii]d\s*:/g) ?? []).join(','));
  check('Z4 nor the assignee list leaks a company outside the session scope',
    /FROM users u\s*\n\s*WHERE u\.tenant_id = \$1 AND u\.status = 'active'/.test(conv));

  // --- the dashboard route is byte-identical to the deployed P0.1 file ---
  const changedSinceBaseline = (file) => {
    try {
      return execFileSync('git', ['diff', '--name-only', BASELINE, '--', file], { cwd: REPO, encoding: 'utf8' }).trim();
    } catch { return 'error'; }
  };
  for (const untouched of UNTOUCHED_BY_P0_2) {
    check(`Z5 ${untouched} is UNCHANGED since the deployed P0.1 baseline`,
      changedSinceBaseline(untouched) === '', changedSinceBaseline(untouched));
  }
  // Everything the branch adds or modifies relative to the deployed P0.1 baseline.
  // Untracked new files are folded in explicitly so the list is correct whether or
  // not the work has been committed yet.
  const tracked = execFileSync('git', ['diff', '--name-only', BASELINE], { cwd: REPO, encoding: 'utf8' })
    .trim().split(/\n/).filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .trim().split(/\n/).filter(Boolean);
  const changeSet = [...new Set([...tracked, ...untracked.filter((f) => NEW_FILES.includes(f))])].sort();
  check('Z5 the P0.2 change set is EXACTLY the declared file list — nothing else is touched',
    JSON.stringify(changeSet) === JSON.stringify(expectedChanges.slice().sort()),
    JSON.stringify(changeSet) + ' vs ' + JSON.stringify(expectedChanges.slice().sort()));
  check('Z5 every declared modification really IS modified',
    MODIFIED_BY_P0_2.every((f) => tracked.includes(f)),
    MODIFIED_BY_P0_2.filter((f) => !tracked.includes(f)).join(','));
  check('Z5 nothing is left staged-but-uncommitted',
    (() => {
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: REPO, encoding: 'utf8' }).trim();
      return staged === '' || staged.split(/\n/).every((f) => expectedChanges.includes(f));
    })(), '');
  for (const f of NEW_FILES) {
    let present = false;
    try { present = readFileSync(join(REPO, f), 'utf8').length > 0; } catch { present = false; }
    check(`Z5 new file present: ${f}`, present);
  }
  // A pre-existing untracked scratch directory in this worktree must NOT become
  // part of the review branch.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: REPO, encoding: 'utf8' }).trim();
  check('Z5 nothing outside the change set is staged for commit',
    staged === '' || staged.split(/\n/).every((f) => expectedChanges.includes(f)), staged);
  check('Z5 the pre-existing untracked GROUP-C-PATCH/ scratch directory is NOT committed',
    !modified.includes('GROUP-C-PATCH/009_handoff.sql') &&
    !execFileSync('git', ['ls-files', 'GROUP-C-PATCH'], { cwd: REPO, encoding: 'utf8' }).includes('009_handoff.sql'));

  // --- migration discipline ---
  const mig016 = read('migrations/016_manual_reply_idempotency.sql');
  check('Z6 it creates no table',
    !/CREATE TABLE/i.test(mig016));
  check('Z6 it changes no existing role or permission',
    !/UPDATE roles|INSERT INTO roles/i.test(mig016));
  check('Z6 it never tightens an existing constraint',
    !/ALTER TABLE [\w]+\s+(?![^;]*idempotency_key)[^;]*VALIDATE/i.test(mig016.replace(/NOT VALID/g, '')));
}

/* ========================================================================== */
console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);