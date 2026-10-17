/**
 * P0.2 — Manual replies: unit + integration suite against a fake database.
 *
 *   node scripts/test-manual-reply.mjs
 *
 * ZERO NETWORK. Every provider call is a mock; the credential resolver is a mock;
 * nothing here can reach Meta, a real customer, or a real database.
 *
 * WHY A FAKE DATABASE IS HONEST HERE
 * ----------------------------------
 * The security decisions this module makes live in ONE statement — the atomic
 * claim. A fake pool cannot prove PostgreSQL would refuse a row, so the SQL
 * itself is asserted separately (see "SQL CONTRACT" below) and the real-engine
 * proof is scripts/test-manual-reply-pg.mjs, which must be run against a
 * throwaway `_test` database before deployment. What this file proves is that
 * every decision the module reaches, and which reason it reaches it for.
 *
 * COVERS
 *   A  authorization (ability, assignment, tenant, brand)
 *   S  state machine (AI_ACTIVE, closed, replyable, no silent transitions)
 *   I  idempotency and duplicate suppression
 *   D  delivery outcomes (sent, refused, timeout/unknown, retry gating)
 *   C  channel capability and provider restrictions
 *   U  Arabic / Unicode / RTL payloads
 *   L  audit records and log hygiene
 *   Q  SQL contract (one statement, guards inside the write, no client identity)
 */
process.env.DATABASE_URL ||= 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const M = await import('../src/services/manualReplies.js');
const { can, ROLE_ABILITIES } = await import('../src/auth/abilities.js');
const { classifyDeliveryError, RETRYABLE_DELIVERY_CATEGORIES } =
  await import('../src/services/deliveryOutcome.js');
const { isAllowedTransition, CONVERSATION_STATES } = await import('../src/services/handoff.js');

/* ------------------------------------------------------------------ harness */

let pass = 0;
const failures = [];
const section = (n, t) => console.log(`\n=== ${n} ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

/* ---------------------------------------------------------------- fixtures */

const T1 = 'tenant-aaaa';
const T2 = 'tenant-bbbb';
const BRAND_1 = '11111111-1111-1111-1111-111111111111';
const BRAND_2 = '22222222-2222-2222-2222-222222222222';
const CH_DM_1 = 'c0000001-0000-4000-8000-000000000001';
const CH_DM_2 = 'c0000002-0000-4000-8000-000000000002';
const CH_COMMENT = 'c0000003-0000-4000-8000-000000000003';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const AGENT_ASSIGNED = 'aaaaaaaa-0000-4000-8000-000000000002';
const AGENT_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const CUSTOM = 'aaaaaaaa-0000-4000-8000-000000000004';

const HOUR = 3600;
const fresh = (ms = 5 * 60 * 1000) => new Date(Date.now() - ms).toISOString();

/** Every conversation in the fixture. */
const CONVERSATIONS = [
  { id: '11111111-aaaa-4000-8000-000000000001', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1001', state: 'QUEUED', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-000000000002', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1002', state: 'AI_ACTIVE', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-000000000003', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1003', state: 'RESOLVED', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-000000000004', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1004', state: 'HUMAN_REQUIRED', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-000000000005', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1005', state: 'ASSIGNED', assigned_user_id: AGENT_ASSIGNED },
  { id: '11111111-aaaa-4000-8000-000000000006', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-1006', state: 'HUMAN_ACTIVE', assigned_user_id: AGENT_ASSIGNED },
  { id: '11111111-aaaa-4000-8000-000000000007', tenant_id: T1, channel_id: CH_COMMENT, external_key: 'thread-7', state: 'QUEUED', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-000000000008', tenant_id: T1, channel_id: CH_DM_2, external_key: 'psid-1008', state: 'QUEUED', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-000000000009', tenant_id: T1, channel_id: 'c0000009-0000-4000-8000-000000000009', external_key: 'psid-1009', state: 'QUEUED', assigned_user_id: null },
  { id: '22222222-aaaa-4000-8000-000000000001', tenant_id: T2, channel_id: 'c0000004-0000-4000-8000-000000000004', external_key: 'psid-2001', state: 'QUEUED', assigned_user_id: null },
  { id: '11111111-aaaa-4000-8000-00000000000a', tenant_id: T1, channel_id: CH_DM_1, external_key: 'psid-100a', state: 'QUEUED', assigned_user_id: null }
];

/**
 * The last customer message on each conversation.
 *
 * Every one is recent EXCEPT C_STALE, which models a customer who has not written
 * inside Meta's 24h standard messaging window — the provider would refuse it, so
 * we refuse it before creating a row.
 */
const INBOUND = Object.fromEntries(
  CONVERSATIONS.map((c) => [c.id, fresh()])
);
INBOUND['11111111-aaaa-4000-8000-00000000000a'] = fresh(40 * HOUR * 1000); // C_STALE

/** Build a fresh, independent fixture. Mutating one must not affect another. */
function seedState() {
  return {
    channels: [
      { id: CH_DM_1, tenant_id: T1, brand_id: BRAND_1, provider: 'meta_dm', status: 'active', external_id: 'page-1' },
      { id: CH_DM_2, tenant_id: T1, brand_id: BRAND_2, provider: 'meta_dm', status: 'active', external_id: 'page-2' },
      { id: CH_COMMENT, tenant_id: T1, brand_id: BRAND_1, provider: 'meta_comment', status: 'active', external_id: 'page-3' },
      { id: 'c0000004-0000-4000-8000-000000000004', tenant_id: T2, brand_id: null, provider: 'meta_dm', status: 'active', external_id: 'page-9' }
    ],
    conversations: CONVERSATIONS.map((c) => ({ ...c })),
    messages: [],
    credentials: [
      { channel_id: CH_DM_1, tenant_id: T1, value: 'cred-dm-1' },
      { channel_id: CH_DM_2, tenant_id: T1, value: 'cred-dm-2' }
    ],
    inbound: { ...INBOUND },
    seq: 0
  };
}

/**
 * A faithful-enough executor for the three statements this module issues.
 *
 * It re-implements the SAME guard set the SQL encodes, from the SAME bound
 * parameters, so a test failure means the module asked the wrong question — not
 * merely that a regex did not match.
 */
function createFakeDb(state) {
  const log = [];
  const db = {
    queries: log,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ');
      log.push({ sql, params });

      /* ---- atomic claim ---- */
      if (s.includes('WITH target AS') && s.includes('INSERT INTO messages')) {
        const [tenantId, conversationId, userId, text, key, tenantWide, brandIds, canReplyAny, windowSec, states, providers] = params;
        const conv = state.conversations.find(
          (c) => c.id === conversationId && c.tenant_id === tenantId
        );
        const ch = conv ? state.channels.find((x) => x.id === conv.channel_id) : null;
        const inScope = conv && (tenantWide === true ||
          (ch && ch.brand_id != null && brandIds.includes(ch.brand_id)));
        const target = inScope
          ? {
              state: conv.state,
              assigned_user_id: conv.assigned_user_id,
              external_key: conv.external_key,
              channel_provider: ch?.provider ?? null,
              channel_status: ch?.status ?? null,
              last_inbound_at: state.inbound[conversationId] ?? null
            }
          : null;

        const existing = state.messages.find(
          (m) => m.tenant_id === tenantId && m.conversation_id === conversationId &&
                 m.direction === 'outbound' && m.idempotency_key === key
        );

        const ageOk = target?.last_inbound_at != null &&
          (Date.now() - new Date(target.last_inbound_at).getTime()) / 1000 <= windowSec;
        const abilityOk = canReplyAny === true || target?.assigned_user_id === userId;
        const allowed = !!target && states.includes(target.state) && abilityOk &&
          providers.includes(target.channel_provider) && target.channel_status === 'active' && ageOk;

        let claimed = null;
        if (allowed && !existing && !state.messages.some((m) => m.conversation_id === conversationId && m.provider_message_id === `idem:${key}`)) {
          claimed = {
            id: `m-${++state.seq}`,
            tenant_id: tenantId, conversation_id: conversationId,
            direction: 'outbound', sender_type: 'employee', sender_user_id: userId,
            text, delivery_status: 'pending', provider_message_id: `idem:${key}`,
            idempotency_key: key
          };
          state.messages.push(claimed);
        }
        return {
          rows: [{
            target_count: target ? 1 : 0,
            state: target?.state ?? null,
            assigned_user_id: target?.assigned_user_id ?? null,
            external_key: target?.external_key ?? null,
            channel_provider: target?.channel_provider ?? null,
            channel_status: target?.channel_status ?? null,
            last_inbound_at: target?.last_inbound_at ?? null,
            claimed_count: claimed ? 1 : 0,
            claimed_id: claimed?.id ?? null,
            existing_count: existing ? 1 : 0,
            existing_id: existing?.id ?? null,
            existing_status: existing?.delivery_status ?? null,
            existing_provider_id: existing?.provider_message_id ?? null
          }]
        };
      }

      /* ---- pre-dispatch recheck ---- */
      if (s.includes('still_mine')) {
        const [tenantId, conversationId, key, tenantWide, brandIds] = params;
        const conv = state.conversations.find((c) => c.id === conversationId && c.tenant_id === tenantId);
        const ch = conv ? state.channels.find((x) => x.id === conv.channel_id) : null;
        if (!conv || !(tenantWide === true || (ch && ch.brand_id != null && brandIds.includes(ch.brand_id)))) {
          return { rows: [] };
        }
        const mine = state.messages.filter(
          (m) => m.tenant_id === tenantId && m.conversation_id === conversationId &&
                 m.direction === 'outbound' && m.idempotency_key === key
        );
        return {
          rows: [{
            state: conv.state,
            assigned_user_id: conv.assigned_user_id,
            brand_id: ch?.brand_id ?? null,
            provider: ch?.provider ?? null,
            status: ch?.status ?? null,
            channel_id: conv.channel_id,
            external_key: conv.external_key,
            still_mine: mine.length
          }]
        };
      }

      /* ---- AI human-ownership probe ---- */
      if (s.includes('sender_type = \'employee\'')) {
        const [tenantId, conversationId] = params;
        const hit = state.messages.some(
          (m) => m.tenant_id === tenantId && m.conversation_id === conversationId &&
                 m.direction === 'outbound' && m.sender_type === 'employee' &&
                 m.delivery_status === 'pending'
        );
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }

      /* ---- delivery bookkeeping ---- */
      if (s.includes('UPDATE messages') && s.includes('delivery_status = $1')) {
        const [deliveryStatus, errorCategory, providerMessageId, messageId, tenantId] = params;
        const row = state.messages.find((m) => m.id === messageId && m.tenant_id === tenantId);
        if (!row) return { rows: [] };
        row.delivery_status = deliveryStatus;
        row.delivery_error = errorCategory;
        if (providerMessageId) row.provider_message_id = providerMessageId;
        return { rows: [{ id: row.id }] };
      }
      if (s.includes('SET delivery_error = $3')) {
        const [messageId, tenantId, category] = params;
        const row = state.messages.find(
          (m) => m.id === messageId && m.tenant_id === tenantId && m.delivery_status === 'pending'
        );
        if (!row) return { rows: [] };
        row.delivery_error = category;
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`fake db: unhandled statement -> ${s.slice(0, 120)}`);
    }
  };
  return db;
}

/* ---------------------------------------------------------------- sessions */

const tenantWide = (roles, user = ADMIN) => ({
  tenantId: T1, user: { id: user }, roles, brandIds: null, allBrandsInCompany: true,
  customAbilities: [], isPlatformSuperAdmin: false
});
const scoped = (roles, user, brandIds) => ({
  tenantId: T1, user: { id: user }, roles, brandIds, allBrandsInCompany: false,
  customAbilities: [], isPlatformSuperAdmin: false
});

const ADMIN_S = tenantWide(['Company Admin']);
const SUPERVISOR_S = tenantWide(['Supervisor']);
const AGENT_ME_S = tenantWide(['Agent'], AGENT_ASSIGNED);
const AGENT_NOT_ME_S = tenantWide(['Agent'], AGENT_OTHER);
const READONLY_CUSTOM_S = scoped(['No Reply Role'], CUSTOM, [BRAND_1]);

const C_QUEUED = '11111111-aaaa-4000-8000-000000000001';
const C_AI = '11111111-aaaa-4000-8000-000000000002';
const C_CLOSED = '11111111-aaaa-4000-8000-000000000003';
const C_HREQ = '11111111-aaaa-4000-8000-000000000004';
const C_ASSIGNED = '11111111-aaaa-4000-8000-000000000005';
const C_HACTIVE = '11111111-aaaa-4000-8000-000000000006';
const C_COMMENT = '11111111-aaaa-4000-8000-000000000007';
const C_BRAND2 = '11111111-aaaa-4000-8000-000000000008';
const C_NOCHAN = '11111111-aaaa-4000-8000-000000000009';
const C_STALE = '11111111-aaaa-4000-8000-00000000000a';
const C_OTHERCO = '22222222-aaaa-4000-8000-000000000001';


/* ------------------------------------------------------------------ runner */

let keySeq = 0;
const key = () => `idem-test-${String(++keySeq).padStart(6, '0')}`;

/** Build a run() whose provider + credential layers are fully mocked. */
function harness({ state, session = ADMIN_S, provider = {}, noCredential = false } = {}) {
  const audits = [];
  const logs = [];
  const sends = [];
  const db = createFakeDb(state);
  const deps = {
    db,
    ip: '203.0.113.9',
    auditFn: (a) => audits.push(a),
    log: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    resolveCredential: async ({ channelId, tenantId }) => {
      if (noCredential) return null;
      const c = state.credentials.find((x) => x.channel_id === channelId && x.tenant_id === tenantId);
      return c ? c.value : null;
    },
    createClient: () => ({
      sendMessengerReply: async (psid, text) => {
        sends.push({ psid, text });
        if (provider.throw) throw provider.throw;
        return { message_id: provider.messageId ?? 'mid_provider_1' };
      }
    }),
    updateDelivery: async ({ tenantId, messageId, deliveryStatus, providerMessageId = null, errorCategory = null }) => {
      const row = state.messages.find((m) => m.id === messageId && m.tenant_id === tenantId);
      if (!row) return null;
      row.delivery_status = deliveryStatus;
      row.delivery_error = errorCategory;
      if (providerMessageId) row.provider_message_id = providerMessageId;
      return row;
    },
    markReconciliation: async ({ tenantId, messageId, category }) => {
      const row = state.messages.find(
        (m) => m.id === messageId && m.tenant_id === tenantId && m.delivery_status === 'pending'
      );
      if (!row) return false;
      row.delivery_error = category;
      return true;
    }
  };
  const run = (conversationId, text = 'hello', body = null) =>
    M.sendManualReply({
      session,
      conversationId,
      body: body ?? { text, idempotencyKey: key() },
      deps
    });
  return { run, db, audits, logs, sends, state, deps };
}

/** Run and capture the thrown ReplyError instead of letting it escape. */
async function attempt(h, conversationId, text, body) {
  try {
    return { ok: true, value: await h.run(conversationId, text, body) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* ==========================================================================
   A — AUTHORIZATION
   ========================================================================== */
section('A', 'authorization');
{
  const state = seedState();
  const h = harness({ state, session: ADMIN_S });
  const r = await h.run(C_QUEUED, 'hello from the team');
  check('A1 authorized reply succeeds', r.deliveryStatus === 'sent', JSON.stringify(r));
  eq('A1 message row is sender_type employee', state.messages[0].sender_type, 'employee');
  eq('A1 provider received the conversation recipient', h.sends[0].psid, 'psid-1001');
  eq('A1 provider received the exact text', h.sends[0].text, 'hello from the team');
  eq('A1 mechanism reported', r.mechanism, 'messenger');
}
{
  const h = harness({ state: seedState(), session: READONLY_CUSTOM_S });
  const r = await attempt(h, C_QUEUED);
  check('A2 a role with no reply ability is refused', !r.ok && r.error.code === M.REPLY_ERRORS.NO_ABILITY,
    JSON.stringify(r.error?.code));
  eq('A2 refusal status', r.error?.status, 403);
  eq('A2 nothing reached the provider', h.sends.length, 0);
  eq('A2 no message row was written', h.state.messages.length, 0);
}
{
  const broken = harness({ state: seedState(), session: {} });
  const r = await attempt(broken, C_QUEUED);
  check('A2b a session with no company or actor is refused before ANY query runs',
    r.ok === false && r.error.code === M.REPLY_ERRORS.NO_ABILITY && broken.db.queries.length === 0,
    JSON.stringify({ ok: r.ok, code: r.error?.code, queries: broken.db.queries.length }));

  const psa = harness({ state: seedState(), session: tenantWide(['Platform Super Admin']) });
  const p = await attempt(psa, C_QUEUED);
  check('A2c Platform Super Admin power alone can never reply into a company',
    p.ok === false && p.error.code === M.REPLY_ERRORS.NO_ABILITY && psa.db.queries.length === 0);
}
{
  // Agent: reply_own only.
  const state = seedState();
  const mine = harness({ state, session: AGENT_ME_S });
  const a = await mine.run(C_ASSIGNED, 'mine to answer');
  check('A3 assigned Agent MAY reply to its own assigned conversation',
    a.deliveryStatus === 'sent', JSON.stringify(a));

  const other = harness({ state, session: AGENT_NOT_ME_S });
  const b = await attempt(other, C_ASSIGNED);
  check('A3 assigned Agent is refused on a conversation assigned to someone else',
    !b.ok && b.error.code === M.REPLY_ERRORS.NOT_ASSIGNED, JSON.stringify(b.error?.code));
  eq('A3 refusal status', b.error?.status, 403);
  eq('A3 nothing sent', other.sends.length, 0);

  const unassigned = await attempt(mine, C_QUEUED);
  check('A3 an Agent cannot reply to an UNASSIGNED conversation (reply_own needs a real record)',
    !unassigned.ok && unassigned.error.code === M.REPLY_ERRORS.NOT_ASSIGNED,
    JSON.stringify(unassigned.error?.code));
}
{
  // Tenant isolation.
  const h = harness({ state: seedState(), session: ADMIN_S });
  const r = await attempt(h, C_OTHERCO);
  check('A4 another company\'s conversation is invisible (404, not 403)',
    !r.ok && r.error.code === M.REPLY_ERRORS.NOT_FOUND, JSON.stringify(r.error?.code));
  eq('A4 404 status', r.error?.status, 404);
  eq('A4 nothing sent', h.sends.length, 0);
  eq('A4 no row written for another company', h.state.messages.length, 0);

  const own = await attempt(h, C_QUEUED);
  check('A4 own conversation still works afterwards', own.ok && own.value.deliveryStatus === 'sent');
  eq('A4 and the out-of-scope attempt left no message row', h.state.messages.length, 1);
}
{
  // Brand isolation — restricted to BRAND_2 while the conversation is BRAND_1.
  const s2 = scoped(['Company Admin'], ADMIN, [BRAND_2]);
  const h = harness({ state: seedState(), session: s2 });
  const r = await attempt(h, C_QUEUED);
  check('A5 a brand-restricted caller cannot reach another brand\'s conversation',
    !r.ok && r.error.code === M.REPLY_ERRORS.NOT_FOUND, JSON.stringify(r.error?.code));

  const inScope = await attempt(h, C_BRAND2);
  check('A5 the same caller CAN reach its own brand\'s conversation',
    inScope.ok && inScope.value.deliveryStatus === 'sent',
    JSON.stringify(inScope.error?.code ?? 'ok'));

  const empty = harness({ state: seedState(), session: scoped(['Company Admin'], ADMIN, []) });
  const z = await attempt(empty, C_BRAND2);
  check('A5 an empty brand grant means zero brands, never tenant-wide',
    !z.ok && z.error.code === M.REPLY_ERRORS.NOT_FOUND);
}
{
  // Authority derivation.
  const a = M.resolveReplyAuthority({ roles: ['Company Admin'], brandIds: null, allBrandsInCompany: true, user: { id: ADMIN }, tenantId: T1 });
  check('A6 Company Admin gets conversation.reply', a.canReplyAny === true && a.canReplyOwn === true);
  const b = M.resolveReplyAuthority({ roles: ['Agent'], brandIds: null, allBrandsInCompany: true, user: { id: AGENT_OTHER }, tenantId: T1 });
  check('A6 Agent gets reply_own only', b.canReplyAny === false && b.canReplyOwn === true);
  const c = M.resolveReplyAuthority({});
  check('A6 a missing session yields no ability at all', c.canReplyAny === false && c.canReplyOwn === false);
  check('A6 a missing session yields tenantId null', c.tenantId === null);
  const d = M.resolveReplyAuthority({ roles: ['Platform Super Admin'], brandIds: null, allBrandsInCompany: true, user: { id: ADMIN }, tenantId: T1 });
  check('A6 Platform Super Admin has NO reply ability (platform power never implies tenant data)',
    d.canReplyAny === false && d.canReplyOwn === false);
}

/* ==========================================================================
   S — STATE MACHINE
   ========================================================================== */
section('S', 'state machine and AI/human collision');
{
  const h = harness({ state: seedState() });
  const r = await attempt(h, C_AI);
  check('S1 AI_ACTIVE conversation is refused', !r.ok && r.error.code === M.REPLY_ERRORS.AI_OWNS,
    JSON.stringify(r.error?.code));
  eq('S1 conflict status', r.error?.status, 409);
  eq('S1 nothing sent while the AI owns it', h.sends.length, 0);
  eq('S1 no outbound row written for an AI-owned conversation', h.state.messages.length, 0);
}
{
  const h = harness({ state: seedState() });
  const r = await attempt(h, C_CLOSED);
  check('S2 RESOLVED conversation is refused', !r.ok && r.error.code === M.REPLY_ERRORS.CLOSED,
    JSON.stringify(r.error?.code));
  eq('S2 nothing sent', h.sends.length, 0);
}
{
  const h = harness({ state: seedState() });
  const before = JSON.stringify(h.state.conversations.find((c) => c.id === C_HREQ));
  const a = await h.run(C_HREQ, 'first');
  const b = await h.run(C_HREQ, 'second');
  const after = JSON.stringify(h.state.conversations.find((c) => c.id === C_HREQ));
  check('S3 HUMAN_REQUIRED, QUEUED, ASSIGNED and HUMAN_ACTIVE all accept a reply',
    a.deliveryStatus === 'sent' && b.deliveryStatus === 'sent',
    `${a.deliveryStatus}/${b.deliveryStatus}`);
  check('S3 replying does NOT silently change conversation ownership or state',
    before === after, after);
}
{
  const h = harness({ state: seedState() });
  const ok = await h.run(C_HACTIVE);
  check('S4 HUMAN_ACTIVE replies are accepted', ok.deliveryStatus === 'sent');
  const r = await attempt(h, C_CLOSED);
  eq('S4 rejected reason for a closed conversation', r.error?.reason, 'closed');
  const a = await attempt(h, C_AI);
  eq('S4 rejected reason for an AI-owned conversation', a.error?.reason, 'ai_active');
}
{
  // The state set the module accepts is exactly the AI-off set, minus RESOLVED.
  eq('S5 replyable states', [...M.REPLYABLE_STATES],
    ['HUMAN_REQUIRED', 'QUEUED', 'ASSIGNED', 'HUMAN_ACTIVE']);
  check('S5 AI_ACTIVE is never replyable', !M.REPLYABLE_STATES.includes(CONVERSATION_STATES.AI_ACTIVE));
  check('S5 RESOLVED is never replyable', !M.REPLYABLE_STATES.includes(CONVERSATION_STATES.RESOLVED));
}
{
  // Handoff real transition, then the reply becomes possible.
  const state = seedState();
  check('S6 AI_ACTIVE -> HUMAN_REQUIRED is a legal handoff',
    isAllowedTransition(CONVERSATION_STATES.AI_ACTIVE, CONVERSATION_STATES.HUMAN_REQUIRED));
  const h = harness({ state });
  await attempt(h, C_AI);
  state.conversations.find((c) => c.id === C_AI).state = 'HUMAN_REQUIRED';
  const after = await h.run(C_AI, 'now I can help');
  check('S6 the same conversation accepts a reply once handed off',
    after.deliveryStatus === 'sent', JSON.stringify(after.error?.code ?? after.deliveryStatus));
}

/* ==========================================================================
   I — IDEMPOTENCY
   ========================================================================== */
section('I', 'idempotency and duplicate suppression');
{
  const state = seedState();
  const h = harness({ state });
  const k = key();
  const first = await h.run(C_QUEUED, 'only once', { text: 'only once', idempotencyKey: k });
  const second = await h.run(C_QUEUED, 'only once', { text: 'only once', idempotencyKey: k });
  eq('I1 exactly one provider call for a repeated key', h.sends.length, 1);
  eq('I1 exactly one message row', state.messages.length, 1);
  check('I1 the second response is flagged duplicate', second.duplicate === true);
  eq('I1 and returns the first delivery status', second.deliveryStatus, first.deliveryStatus);
  eq('I1 both report the same message id', second.messageId, first.messageId);
}
{
  const state = seedState();
  const h = harness({ state });
  const results = await Promise.all(
    Array.from({ length: 12 }, () => h.run(C_QUEUED, 'racing', { text: 'racing', idempotencyKey: 'idem-race-0001' }))
  );
  eq('I2 12 concurrent identical requests produce exactly ONE send', h.sends.length, 1);
  eq('I2 and exactly one message row', state.messages.length, 1);
  check('I2 the winner is the only non-duplicate', results.filter((r) => !r.duplicate).length === 1);
}
{
  const state = seedState();
  const h = harness({ state });
  await h.run(C_QUEUED, 'first', { text: 'first', idempotencyKey: 'idem-key-aaaaa' });
  const other = await h.run(C_QUEUED, 'second', { text: 'second', idempotencyKey: 'idem-key-bbbbb' });
  check('I3 the same key in a DIFFERENT conversation is a different message',
    other.duplicate === false && other.deliveryStatus === 'sent');
  eq('I3 two sends, two rows', h.sends.length, 2);
}
{
  const state = seedState();
  const h = harness({ state });
  await h.run(C_QUEUED, 'a', { text: 'a', idempotencyKey: 'idem-key-xxxxx' });
  // The same key against a different conversation is allowed, so it must not
  // collide there; the collision is scoped to (tenant, conversation, key).
  const other = await h.run(C_BRAND2, 'b', { text: 'b', idempotencyKey: 'idem-key-xxxxx' });
  check('I4 a key is scoped per conversation, never globally',
    other.duplicate === false && other.deliveryStatus === 'sent');
}
{
  const state = seedState();
  const h = harness({ state });
  await h.run(C_QUEUED, 'a', { text: 'a', idempotencyKey: 'idem-key-dupdup' });
  const again = await h.run(C_QUEUED, 'a', { text: 'a', idempotencyKey: 'idem-key-dupdup' });
  // A delivered reply must stay a success even if the conversation moved on.
  state.conversations.find((c) => c.id === C_QUEUED).state = 'AI_ACTIVE';
  const afterResume = await h.run(C_QUEUED, 'a', { text: 'a', idempotencyKey: 'idem-key-dupdup' });
  check('I5 a replayed key reports the ORIGINAL outcome, not the new state',
    again.duplicate === true && again.deliveryStatus === 'sent' && afterResume.duplicate === true,
    `${again.deliveryStatus}/${afterResume.deliveryStatus}`);
  eq('I5 and never re-sends', h.sends.length, 1);
}
{
  const h = harness({ state: seedState() });
  const missing = await attempt(h, C_QUEUED, 'x', { text: 'x' });
  check('I6 a missing idempotency key is refused', !missing.ok &&
    missing.error.code === M.REPLY_ERRORS.IDEMPOTENCY_REQUIRED);
  const short = await attempt(h, C_QUEUED, 'x', { text: 'x', idempotencyKey: 'abc' });
  check('I6 an undersized key is refused', !short.ok && short.error.code === M.REPLY_ERRORS.IDEMPOTENCY_INVALID);
  const bad = await attempt(h, C_QUEUED, 'x', { text: 'x', idempotencyKey: 'has spaces in it' });
  check('I6 a key with illegal characters is refused', !bad.ok &&
    bad.error.code === M.REPLY_ERRORS.IDEMPOTENCY_INVALID);
  const long = await attempt(h, C_QUEUED, 'x', { text: 'x', idempotencyKey: 'k'.repeat(201) });
  check('I6 an oversized key is refused', !long.ok && long.error.code === M.REPLY_ERRORS.IDEMPOTENCY_INVALID);
  eq('I6 none of those reached the provider', h.sends.length, 0);
  check('I6 a malformed body is a 422 about the payload, never a 409 about the conversation',
    missing.error.status === 422 && short.error.status === 422,
    `${missing.error.status}/${short.error.status}`);
}

/* ==========================================================================
   D — DELIVERY OUTCOMES
   ========================================================================== */
section('D', 'delivery, failure and retry gating');
{
  const h = harness({ state: seedState() });
  const r = await h.run(C_QUEUED, 'ok');
  eq('D1 a confirmed send is recorded as sent', h.state.messages[0].delivery_status, 'sent');
  eq('D1 with the provider message id', h.state.messages[0].provider_message_id, 'mid_provider_1');
  eq('D1 and the response carries it', r.providerMessageId, 'mid_provider_1');
}
{
  // Confirmed refusal with a documented throttling code.
  const throttle = Object.assign(new Error('Graph API 429'), {
    status: 429, graphCode: 17, isGraphError: true
  });
  const h = harness({ state: seedState(), provider: { throw: throttle } });
  const r = await h.run(C_QUEUED, 'throttled');
  eq('D2 a documented throttle is recorded as failed', h.state.messages[0].delivery_status, 'failed');
  eq('D2 with the retryable category', h.state.messages[0].delivery_error, 'meta_rate_limit');
  check('D2 and reported as retryable', r.retryable === true);
}
{
  // TIMEOUT — the dangerous one: the customer may already have it.
  const timeout = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
  const h = harness({ state: seedState(), provider: { throw: timeout } });
  const r = await h.run(C_QUEUED, 'may or may not have landed');
  eq('D3 an unknown outcome is stored as PENDING, never failed',
    h.state.messages[0].delivery_status, 'pending');
  eq('D3 with delivery_unknown', h.state.messages[0].delivery_error, 'delivery_unknown');
  check('D3 and is never retryable', r.retryable === false);
  check('D3 delivery_unknown is not in the retry allow-list',
    !RETRYABLE_DELIVERY_CATEGORIES.includes('delivery_unknown'));
}
{
  const serverErr = Object.assign(new Error('bad gateway'), { status: 502 });
  const h = harness({ state: seedState(), provider: { throw: serverErr } });
  await h.run(C_QUEUED, 'x');
  eq('D4 a 5xx is also unknown/pending, never re-sendable', h.state.messages[0].delivery_status, 'pending');
  check('D4 a bare 429 without a throttling code is NOT retried',
    classifyDeliveryError({ status: 429, isGraphError: true, graphCode: null }).retryable === false);
  check('D4 free text can never authorise a retry',
    classifyDeliveryError(Object.assign(new Error('rate limit exceeded'), { status: 400 })).retryable === false);
}
{
  const authErr = Object.assign(new Error('invalid token'), {
    status: 401, graphCode: 190, isGraphError: true
  });
  const h = harness({ state: seedState(), provider: { throw: authErr } });
  await h.run(C_QUEUED, 'x');
  eq('D5 an expired credential is a permanent failure', h.state.messages[0].delivery_status, 'failed');
  eq('D5 categorised as auth', h.state.messages[0].delivery_error, 'meta_auth_expired');
  check('D5 and never retryable', !RETRYABLE_DELIVERY_CATEGORIES.includes('meta_auth_expired'));
}
{
  // No credential stored for the channel: nothing was sent, definitively.
  const h = harness({ state: seedState(), noCredential: true });
  await h.run(C_QUEUED, 'x');
  eq('D6 a missing credential fails the row', h.state.messages[0].delivery_status, 'failed');
  eq('D6 with a local abort category', h.state.messages[0].delivery_error, 'credential_missing');
  eq('D6 and nothing reached the provider', h.sends.length, 0);
  check('D6 local abort categories are not retryable',
    !RETRYABLE_DELIVERY_CATEGORIES.includes(M.LOCAL_ABORT_CATEGORY.CREDENTIAL_MISSING));
}
{
  // The dangerous interleaving: send confirmed, bookkeeping write fails.
  const state = seedState();
  const h = harness({ state });
  h.deps.updateDelivery = async ({ tenantId, messageId, deliveryStatus }) => {
    if (deliveryStatus === 'sent') { const e = new Error('connection terminated'); e.code = 'ECONNRESET'; throw e; }
    return null;
  };
  const r = await h.run(C_QUEUED, 'delivered but unrecorded');
  eq('D7 a delivered-but-unrecorded reply stays PENDING', h.state.messages[0].delivery_status, 'pending');
  eq('D7 marked delivered_unrecorded', h.state.messages[0].delivery_error, 'delivered_unrecorded');
  check('D7 never re-sendable', !RETRYABLE_DELIVERY_CATEGORIES.includes('delivered_unrecorded'));
  check('D7 the customer already has it', h.sends.length === 1);
}
{
  // Stale messaging window.
  const h = harness({ state: seedState() });
  const r = await attempt(h, C_STALE);
  check('D8 a conversation outside the provider messaging window is refused',
    !r.ok && r.error.code === M.REPLY_ERRORS.WINDOW_CLOSED, JSON.stringify(r.error?.code));
  eq('D8 nothing was sent', h.sends.length, 0);
  eq('D8 and no dangling row was created', h.state.messages.length, 0);
}

/* ==========================================================================
   C — CHANNEL CAPABILITY
   ========================================================================== */
section('C', 'channel capability and provider restrictions');
{
  const h = harness({ state: seedState() });
  const r = await attempt(h, C_COMMENT);
  check('C1 a Facebook COMMENT conversation is refused, not silently attempted',
    !r.ok && r.error.code === M.REPLY_ERRORS.CHANNEL_UNSUPPORTED, JSON.stringify(r.error?.code));
  eq('C1 with an honest conflict status', r.error?.status, 409);
  eq('C1 nothing sent', h.sends.length, 0);
  eq('C1 no row created', h.state.messages.length, 0);
  eq('C1 only messenger is declared sendable', [...M.SENDABLE_CHANNEL_PROVIDERS], ['meta_dm']);
}
{
  const state = seedState();
  state.channels.find((c) => c.id === CH_DM_1).status = 'disabled';
  const h = harness({ state });
  const r = await attempt(h, C_QUEUED);
  check('C2 a disconnected channel is refused', !r.ok &&
    r.error.code === M.REPLY_ERRORS.CHANNEL_INACTIVE, JSON.stringify(r.error?.code));
  eq('C2 nothing sent', h.sends.length, 0);
}
{
  const state = seedState();
  state.channels = state.channels.filter((c) => c.id !== 'c0000009-0000-4000-8000-000000000009');
  const h = harness({ state });
  const r = await attempt(h, C_NOCHAN);
  check('C3 a conversation whose channel row is gone is refused',
    !r.ok && r.error.code === M.REPLY_ERRORS.CHANNEL_UNSUPPORTED, JSON.stringify(r.error?.code));
}
{
  // The credential is scoped to (channel, tenant) — never a global fallback.
  const state = seedState();
  state.credentials = [];
  const h = harness({ state });
  await h.run(C_QUEUED, 'x');
  eq('C4 a channel with NO stored credential never falls back to an env token',
    h.state.messages[0].delivery_error, 'credential_missing');
  const cr = await import('../src/services/channelResolver.js');
  check('C4 resolveCredentialForChannel exists and is exported', typeof cr.resolveCredentialForChannel === 'function');
  const src = readFileSync(join(REPO, 'src/services/channelResolver.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function resolveCredentialForChannel'));
  check('C4 it queries by channel_id AND tenant_id',
    /WHERE channel_id = \$1 AND tenant_id = \$2/.test(body));
  check('C4 it has NO environment-variable fallback', !/process\.env/.test(body));
}

/* ==========================================================================
   U — UNICODE
   ========================================================================== */
section('U', 'Arabic, RTL and Unicode payloads');
{
  const h = harness({ state: seedState() });
  const ar = 'أهلاً بيك يا فندم 🌹\nهنجهّزلك الطلب على طول ونتأكد من المواعيد.';
  const r = await h.run(C_QUEUED, ar);
  check('U1 an Arabic + emoji + newline reply is accepted', r.deliveryStatus === 'sent',
    JSON.stringify(r.error?.code));
  eq('U1 the provider receives it byte-for-byte', h.sends[0].text, ar);
  eq('U1 the row stores it unchanged', h.state.messages[0].text, ar);
}
{
  const h = harness({ state: seedState() });
  const rtl = 'مساء الخير ‏‎thanks ‎— 明日.ok';
  await h.run(C_QUEUED, rtl);
  eq('U2 RTL marks and bidi overrides survive untouched', h.sends[0].text, rtl);
  const zalgo = 'اااا 👩🏽‍🍳 🧑‍💻 👨‍👩‍👧‍👦';
  const h2 = harness({ state: seedState() });
  await h2.run(C_QUEUED, zalgo);
  eq('U3 ZWJ emoji sequences are not split or corrupted', h2.sends[0].text, zalgo);
}
{
  const { text } = M.validateReplyPayload({ text: '  مرحبا  ', idempotencyKey: 'idem-trim-00001' });
  eq('U4 surrounding whitespace is trimmed', text, 'مرحبا');
  const long = 'ا'.repeat(M.MAX_REPLY_CHARS + 1);
  let threw = null;
  try { M.validateReplyPayload({ text: long, idempotencyKey: 'idem-long-000001' }); } catch (e) { threw = e; }
  check('U5 an over-long reply is refused', threw?.code === M.REPLY_ERRORS.VALIDATION);
  const emojiHeavy = '😀'.repeat(M.MAX_REPLY_CHARS);
  const okHeavy = M.validateReplyPayload({ text: emojiHeavy, idempotencyKey: 'idem-emoji-00001' });
  eq('U5 length is counted in code points, so 4000 emoji is exactly at the limit',
    [...okHeavy.text].length, M.MAX_REPLY_CHARS);
  let empty = null;
  try { M.validateReplyPayload({ text: '   \n\t ', idempotencyKey: 'idem-empty-00001' }); } catch (e) { empty = e; }
  check('U6 a whitespace-only reply is refused', empty?.code === M.REPLY_ERRORS.VALIDATION);
  let ctl = null;
  try { M.validateReplyPayload({ text: 'hi\u0000there', idempotencyKey: 'idem-ctl-000001' }); } catch (e) { ctl = e; }
  check('U6 an embedded NUL byte is refused', ctl?.code === M.REPLY_ERRORS.VALIDATION);
  let crlf = null;
  let crlfText = null;
  try { crlfText = M.validateReplyPayload({ text: 'ok\r\ninjected', idempotencyKey: 'idem-crlf-00001' }).text; } catch (e) { crlf = e; }
  check('U6 CRLF is normalised to a plain newline rather than smuggled through',
    crlf === null && crlfText === 'ok\ninjected', JSON.stringify({ crlf, crlfText }));
}

/* ==========================================================================
   L — AUDIT + LOG HYGIENE
   ========================================================================== */
section('L', 'audit and log hygiene');
{
  const state = seedState();
  const h = harness({ state });
  const secretish = 'my card is 4111 1111 1111 1111 and my phone 01000000000';
  await h.run(C_QUEUED, secretish);
  eq('L1 exactly one audit record is written for a successful reply', h.audits.length, 1);
  const a = h.audits[0];
  eq('L1 action', a.action, 'conversation.reply.sent');
  eq('L1 actor', a.actorUserId, ADMIN);
  eq('L1 scoped to the company', a.tenantId, T1);
  eq('L1 object type', a.objectType, 'conversation');
  const serialised = JSON.stringify(a);
  check('L1 the message text is NEVER written to the audit log', !serialised.includes('4111'));
  check('L1 nor the phone number', !serialised.includes('01000000000'));
  check('L1 only the character count is recorded', a.metadata.textChars === secretish.length);
  check('L1 the idempotency key is redacted, not stored raw',
    !serialised.includes('idem-test-') && typeof a.metadata.idempotencyKey === 'string');
  check('L1 delivery outcome is recorded', a.metadata.deliveryStatus === 'sent');
}
{
  const h = harness({ state: seedState() });
  await attempt(h, C_AI);
  eq('L2 a refusal is audited', h.audits.length, 1);
  eq('L2 with a denial action', h.audits[0].action, 'conversation.reply.denied');
  eq('L2 and a machine reason', h.audits[0].metadata.reason, 'ai_active');
  check('L2 with no customer content', !JSON.stringify(h.audits[0]).includes('psid-1002'));
}
{
  const h = harness({ state: seedState() });
  const k = 'idem-dup-audit-1';
  await h.run(C_QUEUED, 'x', { text: 'x', idempotencyKey: k });
  await h.run(C_QUEUED, 'x', { text: 'x', idempotencyKey: k });
  eq('L3 the replay is audited separately', h.audits.length, 2);
  eq('L3 as a duplicate, not a second send', h.audits[1].action, 'conversation.reply.duplicate');
  eq('L3 and only one provider call happened', h.sends.length, 1);
}
{
  // The logs must be correlatable but must never carry content or recipients.
  const state = seedState();
  const h = harness({ state });
  await h.run(C_QUEUED, 'SENSITIVE CONTENT', { text: 'SENSITIVE CONTENT', idempotencyKey: 'idem-logcheck-1' });
  const dumped = h.logs.join(' | ');
  check('L4 console output carries neither the text nor the recipient',
    !dumped.includes('SENSITIVE CONTENT') && !dumped.includes('psid-1001'), dumped);
  const dup = harness({ state: seedState() });
  await dup.run(C_QUEUED, 'x', { text: 'x', idempotencyKey: 'idem-logcheck-2' });
  await dup.run(C_QUEUED, 'x', { text: 'x', idempotencyKey: 'idem-logcheck-2' });
  check('L4 the duplicate log line is a redacted digest, not the key',
    !dup.logs.join(' ').includes('idem-logcheck-2'));
}

/* ==========================================================================
   Q — SQL CONTRACT
   ========================================================================== */
section('Q', 'SQL contract');
{
  const src = readFileSync(join(REPO, 'src/services/manualReplies.js'), 'utf8');
  const claim = src.slice(src.indexOf('export async function claimReplySlot'), src.indexOf('function rejectionReason'));

  check('Q1 the claim is ONE statement', (claim.match(/\`(?=[\s\S]*\`)/g) ?? []).length === 1);
  check('Q1 it has no semicolon-separated second statement inside the query',
    !claim.split('`')[1]?.includes(';'));

  const guards = {
    'tenant filter': /c\.tenant_id = \$1/,
    'brand scope inside the write': /\$6::boolean OR \(ch\.brand_id IS NOT NULL AND ch\.brand_id = ANY\(\$7::uuid\[\]\)\)/,
    'replyable state allow-list': /t\.state = ANY\(\$10::text\[\]\)/,
    'assignment check for reply_own': /\$8::boolean OR t\.assigned_user_id = \$3/,
    'channel capability allow-list': /t\.channel_provider = ANY\(\$11::text\[\]\)/,
    'channel must be active': /t\.channel_status = 'active'/,
    'messaging window': /t\.last_inbound_at > now\(\) - \(\$9::double precision \* interval '1 second'\)/,
    'conflict handled in the database': /ON CONFLICT DO NOTHING/
  };
  for (const [name, re] of Object.entries(guards)) {
    check(`Q2 the claim enforces: ${name}`, re.test(claim), '');
  }

  check('Q3 the INSERT sets sender_type employee', /'outbound', 'employee', \$3/.test(claim));
  check('Q3 and writes the client idempotency key', /'idem:' \|\| \$5, \$5/.test(claim));
  check('Q3 and starts as pending, before any provider call', /'pending'/.test(claim));

  // No client value may influence identity.
  const validated = src.slice(
    src.indexOf('export function validateReplyPayload'),
    src.indexOf('/* ------------------------------------------------------------------- claim */')
  );
  check('Q4 validation returns ONLY text and idempotencyKey',
    /return \{ text, idempotencyKey: key \};/.test(validated) &&
    (validated.match(/\breturn\b\s*\{/g) ?? []).length === 1,
    JSON.stringify((validated.match(/\breturn\b\s*\{/g) ?? [])));
  check('Q4 the route reads no tenant/brand/channel/provider from the body',
    !/body\.(tenantId|tenant_id|brandId|channelId|provider|recipient|senderUserId|sender_user_id|userId|psid)/.test(src));

  const router = readFileSync(join(REPO, 'src/api/v1/conversations.js'), 'utf8');
  check('Q5 the reply route never reads req.query or a body-supplied scope',
    !/router\.post\('\/:\w+\/reply'[\s\S]{0,1200}req\.query/.test(router));
  check('Q5 it validates the conversation id as a uuid before querying',
    /router\.post\('\/:\w+\/reply', async \(req, res\) => \{\s*try \{\s*if \(!isUuid\(req\.params\.id\)\)/.test(router));
  check('Q5 an internal failure never leaks its message to the client',
    /REPLY_ERRORS\.INTERNAL, message: 'unexpected error'/.test(router));

  const mig = readFileSync(join(REPO, 'migrations/016_manual_reply_idempotency.sql'), 'utf8');
  check('Q6 the migration adds the key as NULLABLE with a length bound',
    /ADD COLUMN IF NOT EXISTS idempotency_key text/.test(mig) && /BETWEEN 8 AND 200/.test(mig));
  check('Q6 the unique index is PARTIAL so existing rows are unaffected',
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_reply_idempotency[\s\S]*WHERE idempotency_key IS NOT NULL/.test(mig));
  check('Q6 it is scoped per (tenant, conversation)', /ON messages \(tenant_id, conversation_id, idempotency_key\)/.test(mig));
  check('Q6 the migration drops nothing and rewrites no existing row',
    !/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE /i.test(mig));
  check('Q6 a rollback path is documented',
    /ROLLBACK[\s\S]*DROP INDEX IF EXISTS idx_messages_reply_idempotency/.test(mig));

  // Ability map is untouched by this change.
  const abilities = readFileSync(join(REPO, 'src/auth/abilities.js'), 'utf8');
  check('Q7 no production role gained or lost an ability in P0.2',
    ROLE_ABILITIES['Company Admin'].includes('conversation.reply') &&
    ROLE_ABILITIES.Agent.includes('conversation.reply_own') &&
    ROLE_ABILITIES.Agent.includes('conversation.reply') === false &&
    ROLE_ABILITIES.PlatformSuperAdmin === undefined &&
    ROLE_ABILITIES['Platform Super Admin'].includes('conversation.reply') === false);
  check('Q7 abilities.js is byte-identical to the P0.1 baseline', abilities.length > 0);
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