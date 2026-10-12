/**
 * Stage 7 — Batch 2 API tests: RBAC, route ordering, tenant isolation, notes,
 * notifications and the human-reply endpoints.
 *
 * Fully offline: a stub pool + injected module mocks. No PostgreSQL, no network,
 * and above all NO live Meta calls.
 *
 *   node scripts/test-stage7-api.mjs
 */
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const { pool } = await import('../src/db/pg.js');
assert.ok(pool, 'stub pool missing');

/* ------------------------------------------------------------------ */
/* in-memory database                                                 */
/* ------------------------------------------------------------------ */

const DB = {
  tenants: new Map(),
  conversations: new Map(),
  users: new Map(),
  userRoles: [],
  assignments: [],
  escalations: [],
  notes: [],
  notifications: [],
  messages: new Map(),
  channels: new Map(),
  audit: [],
  seq: 0
};

const uid = (p = 'r') => `${p}_${++DB.seq}`;
const now = () => new Date().toISOString();

function reset() {
  DB.tenants.clear(); DB.conversations.clear(); DB.users.clear(); DB.userRoles.length = 0;
  DB.assignments.length = 0; DB.escalations.length = 0; DB.notes.length = 0;
  DB.notifications.length = 0; DB.messages.clear(); DB.channels.clear(); DB.audit.length = 0; DB.seq = 0;

  DB.tenants.set('t1', { id: 't1', name: 'Tenant A' });
  DB.tenants.set('t2', { id: 't2', name: 'Tenant B' });
  DB.channels.set('ch_dm', { id: 'ch_dm', tenant_id: 't1', provider: 'meta_dm', external_id: 'page_1', display_name: 'DM', brand_id: null, status: 'active' });
  DB.channels.set('ch_dm2', { id: 'ch_dm2', tenant_id: 't2', provider: 'meta_dm', external_id: 'page_2', display_name: 'DM B', brand_id: null, status: 'active' });

  const people = [
    ['u_admin', 't1', 'Admin', ['Company Admin']],
    ['u_sup', 't1', 'Supervisor', ['Supervisor']],
    ['u_a1', 't1', 'Agent One', ['Agent']],
    ['u_a2', 't1', 'Agent Two', ['Agent']],
    ['u_b', 't2', 'Tenant B Admin', ['Company Admin']]
  ];
  for (const [id, tenantId, name, roles] of people) {
    DB.users.set(id, { id, tenant_id: tenantId, name, email: `${id}@x.test`, status: 'active' });
    for (const r of roles) DB.userRoles.push({ user_id: id, role_name: r, tenant_id: tenantId });
  }
  for (const id of ['c1', 'c2', 'c3', 'c4']) {
    DB.conversations.set(id, {
      id, tenant_id: 't1', state: 'AI_ACTIVE', assigned_user_id: null, assigned_team_id: null,
      priority: 'normal', resolved_at: null, external_key: 'psid_1', channel_id: 'ch_dm',
      customer_id: 'cust_1', created_at: now(), last_message_at: now()
    });
  }
  DB.conversations.set('x1', {
    id: 'x1', tenant_id: 't2', state: 'AI_ACTIVE', assigned_user_id: null, assigned_team_id: null,
    priority: 'normal', resolved_at: null, external_key: 'psid_b', channel_id: 'ch_dm2',
    customer_id: 'cust_b', created_at: now(), last_message_at: now()
  });
}

/* ------------------------------------------------------------------ */
/* stub pool                                                          */
/* ------------------------------------------------------------------ */

pool.query = async (sql, params = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();

  // conversations: guarded transition
  let m = q.match(/^UPDATE conversations SET (.+?) WHERE id = \$(\d+) AND tenant_id = \$(\d+) AND state = ANY\(\$\d+::text\[\]\) RETURNING id, state, assigned_user_id, assigned_team_id, priority, resolved_at$/);
  if (m) {
    const n = Number(m[2]) - 1;
    const row = DB.conversations.get(params[n]);
    if (!row || row.tenant_id !== params[n + 1] || !params[n + 2].includes(row.state)) return { rows: [] };
    row.state = params[0];
    for (const piece of m[1].split(', ')) {
      const pm = piece.match(/^(\w+) = \$(\d+)$/);
      if (pm) row[pm[1]] = params[Number(pm[2]) - 1];
    }
    return { rows: [row] };
  }

  if (q.startsWith('SELECT c.id, c.tenant_id, c.state, c.assigned_user_id')) {
    const row = DB.conversations.get(params[0]);
    return { rows: !row || row.tenant_id !== params[1] ? [] : [{ ...row, channel_name: 'DM', brand_name: 'Brand' }] };
  }
  if (q.startsWith('SELECT a.id, a.action')) {
    return { rows: DB.assignments.filter((a) => a.conversation_id === params[0] && a.tenant_id === params[1])
      .sort((a, b) => b._seq - a._seq).slice(0, params[2])
      .map((a) => ({ ...a, actor_user_name: null, assigned_by_name: null })) };
  }
  if (q.startsWith('SELECT id, state FROM conversations')) {
    const row = DB.conversations.get(params[0]);
    return { rows: row && row.tenant_id === params[1] ? [{ id: row.id, state: row.state }] : [] };
  }
  if (q.startsWith('SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2')) {
    const row = DB.conversations.get(params[0]);
    return { rows: row && row.tenant_id === params[1] ? [{ id: row.id }] : [] };
  }

  // list + detail queries
  if (q.startsWith('SELECT c.id, c.state, c.language, c.last_message_at, c.priority')) {
    // The outer WHERE sits between the last subquery and the outer ORDER BY.
    const orderIdx = q.indexOf('ORDER BY c.last_message_at');
    const where = q.slice(q.lastIndexOf('WHERE', orderIdx > 0 ? orderIdx : undefined), orderIdx > 0 ? orderIdx : undefined);
    let rows = [...DB.conversations.values()].filter((c) => c.tenant_id === params[0]);

    const apply = (re, predicate) => {
      const mm = where.match(re);
      if (mm) rows = rows.filter(predicate(params[Number(mm[1]) - 1]));
    };
    apply(/c\.state = ANY\(\$(\d+)::text\[\]\)/, (v) => (c) => v.includes(c.state));
    apply(/c\.state = \$(\d+)/, (v) => (c) => c.state === v);
    apply(/c\.assigned_user_id = \$(\d+)/, (v) => (c) => c.assigned_user_id === v);
    if (where.includes('c.assigned_user_id IS NULL')) rows = rows.filter((c) => !c.assigned_user_id);
    apply(/ch\.brand_id = \$(\d+)/, (v) => (c) => (DB.channels.get(c.channel_id)?.brand_id ?? null) === v);

    const limit = Number(params[params.length - 1]);
    rows = rows.slice(0, limit);
    return {
      rows: rows.map((c) => ({ ...c, customer_name: 'Cust', provider: 'meta_dm', message_count: 1, last_text: 'hi' }))
    };
  }
  if (q.startsWith('SELECT c.id, c.state, c.language, c.created_at, c.priority, c.resolved_at')) {
    const row = DB.conversations.get(params[0]);
    if (!row || row.tenant_id !== params[1]) return { rows: [] };
    return { rows: [{ ...row, customer_name: 'Cust', provider: 'meta_dm', channel_name: 'DM', brand_id: null, brand_name: 'B', assigned_user_name: null }] };
  }
  if (q.startsWith('SELECT id, direction, sender_type, text, created_at, provider_ts')) {
    return {
      rows: [...DB.messages.values()]
        .filter((m) => m.conversation_id === params[0] && m.tenant_id === params[1])
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, 200)
    };
  }
  if (q.startsWith('UPDATE conversations SET last_message_at = now() WHERE id = $1')) {
    const row = DB.conversations.get(params[0]);
    if (row) row.last_message_at = now();
    return { rows: [] };
  }
  if (q.startsWith('INSERT INTO audit_logs')) {
    DB.audit.push({ tenant_id: params[0], actor_user_id: params[1], action: params[2], object_type: params[3], object_id: params[4], ip: params[5], metadata: JSON.parse(params[6] ?? '{}'), created_at: now() });
    return { rows: [] };
  }
  if (q.startsWith('SELECT c.id, c.state, c.language, c.last_message_at, cu.display_name')) {
    // dashboard "recent conversations"
    return {
      rows: [...DB.conversations.values()].filter((c) => c.tenant_id === params[0])
        .map((c) => ({ ...c, customer_name: 'Cust', provider: 'meta_dm', last_text: 'hi' }))
    };
  }

  if (q.startsWith('INSERT INTO assignments')) {
    DB.assignments.push({
      id: uid('asg'), _seq: ++DB.seq, tenant_id: params[0], conversation_id: params[1],
      action: params[2], user_id: params[3], team_id: params[4], reason: params[5],
      assigned_by: params[6], created_at: now()
    });
    return { rows: [] };
  }

  // escalations
  if (q.startsWith('SELECT id FROM escalations')) {
    const row = DB.escalations.filter((e) => e.conversation_id === params[0] && e.tenant_id === params[1] && !e.resolved_at).pop();
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (q.startsWith('UPDATE escalations SET status')) {
    const row = DB.escalations.find((e) => e.id === params[4]);
    if (row) { row.status = params[0]; row.assigned_user_id = params[1]; }
    return { rows: [] };
  }
  if (q.startsWith('INSERT INTO escalations')) {
    DB.escalations.push({ id: uid('esc'), tenant_id: params[0], conversation_id: params[1], status: params[5], requested_by: params[6], resolved_at: null });
    return { rows: [] };
  }
  if (q.startsWith('UPDATE escalations SET status')) {
    for (const e of DB.escalations) if (e.conversation_id === params[0] && e.tenant_id === params[1] && !e.resolved_at) e.resolved_at = now();
    return { rows: [] };
  }

  // eligibility
  if (q.startsWith('SELECT 1')) {
    const [userId, tenantId, handling] = params;
    const u = DB.users.get(userId);
    if (!u || u.tenant_id !== tenantId || u.status !== 'active') return { rows: [] };
    return { rows: DB.userRoles.some((r) => r.user_id === userId && handling.includes(r.role_name)) ? [{ 1: 1 }] : [] };
  }
  if (q.startsWith('SELECT u.id, u.name, u.email, u.status')) {
    const [tenantId, handling] = params;
    return { rows: [...DB.users.values()].filter((u) => u.tenant_id === tenantId && u.status === 'active')
      .filter((u) => DB.userRoles.some((r) => r.user_id === u.id && handling.includes(r.role_name)))
      .map((u) => ({ id: u.id, name: u.name, email: u.email, status: u.status, roles: DB.userRoles.filter((r) => r.user_id === u.id).map((r) => r.role_name) })) };
  }
  if (q.startsWith('SELECT DISTINCT u.id')) {
    const [tenantId, handling] = params;
    return { rows: [...DB.users.values()].filter((u) => u.tenant_id === tenantId && u.status === 'active')
      .filter((u) => DB.userRoles.some((r) => r.user_id === u.id && handling.includes(r.role_name)))
      .map((u) => ({ id: u.id })) };
  }

  // internal notes
  if (q.startsWith('INSERT INTO internal_notes')) {
    const note = { id: uid('note'), tenant_id: params[0], conversation_id: params[1], user_id: params[2], body: params[3], created_at: now() };
    DB.notes.push(note);
    return { rows: [note] };
  }
  if (q.startsWith('SELECT n.id, n.body')) {
    return { rows: DB.notes.filter((n) => n.conversation_id === params[0] && n.tenant_id === params[1])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((n) => ({ ...n, author_name: DB.users.get(n.user_id)?.name ?? null, author_email: null })) };
  }
  if (q.startsWith('SELECT id, user_id FROM internal_notes')) {
    const n = DB.notes.find((x) => x.id === params[0] && x.conversation_id === params[1] && x.tenant_id === params[2]);
    return { rows: n ? [n] : [] };
  }
  if (q.startsWith('DELETE FROM internal_notes')) {
    const i = DB.notes.findIndex((n) => n.id === params[0] && n.tenant_id === params[1]);
    if (i >= 0) DB.notes.splice(i, 1);
    return { rows: [] };
  }

  // notifications
  if (q.startsWith('INSERT INTO notifications')) {
    const [tenantId, type, title, body] = params.slice(0, 4);
    const rest = params.slice(4);
    const rows = [];
    for (let i = 0; i < rest.length; i += 2) {
      const n = { id: uid('ntf'), tenant_id: tenantId, user_id: rest[i], type, title, body, data: JSON.parse(rest[i + 1] ?? '{}'), read_at: null, created_at: now() };
      DB.notifications.push(n); rows.push(n);
    }
    return { rows };
  }
  if (q.startsWith('SELECT count(*)::int AS unread')) {
    return { rows: [{ unread: DB.notifications.filter((n) => n.tenant_id === params[0] && n.user_id === params[1] && !n.read_at).length }] };
  }
  if (q.startsWith('SELECT id, type, title, body, data, read_at, created_at')) {
    return { rows: DB.notifications.filter((n) => n.tenant_id === params[0] && n.user_id === params[1])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, params[3]) };
  }
  if (q.startsWith('UPDATE notifications SET read_at = now() WHERE id')) {
    const n = DB.notifications.find((x) => x.id === params[0] && x.tenant_id === params[1] && x.user_id === params[2] && !x.read_at);
    if (n) n.read_at = now();
    return { rows: n ? [n] : [] };
  }
  if (q.startsWith('UPDATE notifications SET read_at = now()')) {
    let c = 0;
    for (const n of DB.notifications) if (n.tenant_id === params[0] && n.user_id === params[1] && !n.read_at) { n.read_at = now(); c++; }
    return { rows: [], rowCount: c };
  }
  if (q.startsWith('SELECT (SELECT count(*) FROM conversations')) {
    const t = params[0];
    const all = [...DB.conversations.values()].filter((c) => c.tenant_id === t);
    return { rows: [{
      conversations: all.length, messages: DB.messages.size, active_channels: 1, escalations: DB.escalations.filter((e) => e.tenant_id === t).length,
      needs_human: all.filter((c) => ['HUMAN_REQUIRED', 'QUEUED'].includes(c.state)).length,
      human_active: all.filter((c) => ['ASSIGNED', 'HUMAN_ACTIVE'].includes(c.state)).length,
      assigned_to_me: all.filter((c) => c.assigned_user_id === params[1] && ['ASSIGNED', 'HUMAN_ACTIVE'].includes(c.state)).length
    }] };
  }

  // messages
  if (q.startsWith('SELECT id, delivery_status, delivery_error, provider_message_id')) {
    const rows = [...DB.messages.values()].filter((x) => x.tenant_id === params[0] && x.conversation_id === params[1]
      && x.direction === 'outbound' && x.sender_type === 'employee' && x.text === params[2]
      && Date.now() - new Date(x.created_at).getTime() < 120000);
    return { rows: rows.slice(-1) };
  }
  if (q.startsWith('SELECT id, provider_message_id, text, created_at, provider_ts')) {
    return { rows: [...DB.messages.values()].filter((x) => x.tenant_id === params[0] && x.conversation_id === params[1] && x.direction === 'inbound') };
  }
  if (q.startsWith('INSERT INTO messages')) {
    const [tenantId, conversationId, text, sentinel, providerTs, status, err, senderType] = params;
    if ([...DB.messages.values()].some((x) => x.conversation_id === conversationId && x.provider_message_id === sentinel)) return { rows: [] };
    const row = { id: uid('msg'), tenant_id: tenantId, conversation_id: conversationId, direction: 'outbound', sender_type: senderType, text, provider_message_id: sentinel, delivery_status: status, delivery_error: err, created_at: now() };
    DB.messages.set(row.id, row);
    const conv = DB.conversations.get(conversationId);
    if (conv) conv.last_message_at = now();
    return { rows: [row] };
  }
  if (q.startsWith('UPDATE messages m')) {
    const [messageId, conversationId, tenantId, senderTypes] = params;
    const row = [...DB.messages.values()].find((x) => x.id === messageId && x.conversation_id === conversationId
      && x.tenant_id === tenantId && x.direction === 'outbound' && senderTypes.includes(x.sender_type) && x.delivery_status === 'failed');
    if (!row) return { rows: [] };
    row.delivery_status = 'pending'; row.retry_count = (row.retry_count ?? 0) + 1;
    return { rows: [row] };
  }
  if (q.startsWith('UPDATE messages')) {
    const [status, err, providerId, messageId, tenantId] = params;
    const row = [...DB.messages.values()].find((x) => x.id === messageId && x.tenant_id === tenantId && x.direction === 'outbound');
    if (!row) return { rows: [] };
    row.delivery_status = status; row.delivery_error = err;
    if (providerId) row.provider_message_id = providerId;
    return { rows: [row] };
  }
  if (q.startsWith('SELECT id, provider, external_id, display_name, brand_id, status')) {
    const ch = DB.channels.get(params[0]);
    return { rows: ch && ch.tenant_id === params[1] ? [ch] : [] };
  }
  // channelResolver: routing channel lookup + credential lookup
  if (q.startsWith('SELECT id, tenant_id, brand_id, provider, external_id, display_name, status')) {
    const ch = [...DB.channels.values()].find((c) => c.external_id === params[0] && c.provider === 'meta');
    return { rows: ch ? [ch] : [] };
  }
  if (q.startsWith('SELECT value_encrypted, iv')) {
    return { rows: [] };
  }
  // knowledge (dashboard)
  if (q.startsWith('SELECT s.brand_id, d.version, d.updated_at')) {
    return { rows: [] };
  }
  if (q.startsWith('SELECT a.id, a.name, a.is_active FROM ai_agents')) {
    return { rows: [{ id: 'ag1', name: 'LWC AI Agent', brand_id: null, is_active: true }] };
  }
  if (q.startsWith('SELECT tone, languages, rules, working_hours, system_prompt_extra')) {
    return { rows: [] };
  }

  throw new Error(`unhandled SQL: ${q.slice(0, 130)}`);
};

/* ------------------------------------------------------------------ */
/* modules under test                                                 */
/* ------------------------------------------------------------------ */

const express = (await import('express')).default;
const { createApiV1Router } = await import('../src/api/v1/index.js');

// Mock the Meta provider adapter → NO live Meta call is ever possible.
const metaAdapter = (await import('../src/providers/meta/humanOutbound.js')).metaHumanOutboundAdapter;
let sendCalls = [];
metaAdapter.send = async ({ target, text }) => {
  sendCalls.push({ target, text });
  return { providerMessageId: 'mid_1', mechanism: 'response' };
};

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} :: ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} :: ${e.message}`); }
};

/* ---------------- tiny express harness ---------------- */

let currentUser = null;
const app = express();
app.use(express.json());
// The API factory overwrites req.validateSession with the injected function,
// so the session mock must be injected through the factory itself.
app.use('/api/v1', createApiV1Router({
  pool,
  validateSessionFn: async () => currentUser,
  // Injected so the API test never touches real credential material.
  conversationsRouterDeps: { resolveCredential: async () => 'injected-test-credential' }
}));

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;

/** Cookie jar so the CSRF double-submit and session cookies behave for real. */
let cookieJar = {};
function captureCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookieJar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}
function cookieHeader() {
  return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(userId, method, path, body) {
  currentUser = {
    tenantId: DB.users.get(userId).tenant_id,
    user: { id: userId, email: `${userId}@x.test`, name: DB.users.get(userId).name },
    roles: DB.userRoles.filter((r) => r.user_id === userId).map((r) => r.role_name),
    sessionId: 's1'
  };
  // Warm the CSRF cookie once (GET never needs it, and the API sets it on first touch).
  if (!cookieJar.csrf_token) {
    const warm = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/me`, { headers: { cookie: cookieHeader() } });
    captureCookies(warm);
    await warm.json().catch(() => ({}));
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': cookieJar.csrf_token ?? 'tok',
      cookie: `${cookieHeader()}; lwc_session=stub-session-token`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  captureCookies(res);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const admin = 'u_admin', sup = 'u_sup', a1 = 'u_a1', a2 = 'u_a2', tenantB = 'u_b';

/** Put a conversation into the QUEUED state for assignment tests. */
async function toQueued(conversationId) {
  const d = { db: pool, actorUserId: admin };
  const { requestHandoff, claimConversation } = await import('../src/services/handoff.js');
  await requestHandoff({ tenantId: 't1', conversationId, reason: 'customer_requested_human' }, d).catch(() => {});
  return claimConversation({ tenantId: 't1', conversationId, userId: a1 }, d);
}

/* ================================================================ */
console.log('\n=== A. auth / tenant isolation ===');

await checkAsync('unauthenticated request is rejected', async () => {
  currentUser = null;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/conversations`, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 401);
});

await checkAsync('cross-tenant conversation is invisible (404)', async () => {
  reset();
  const r = await call(admin, 'GET', '/conversations/x1');
  assert.equal(r.status, 404);
});

await checkAsync('cross-tenant handoff is rejected (404)', async () => {
  reset();
  const r = await call(admin, 'POST', '/conversations/x1/handoff', { reason: 'customer_requested_human' });
  assert.equal(r.status, 404);
  assert.equal(DB.conversations.get('x1').state, 'AI_ACTIVE');
});

await checkAsync('cross-tenant assignment is rejected (404)', async () => {
  reset();
  const r = await call(admin, 'POST', '/conversations/x1/assign', { userId: a1 });
  assert.equal(r.status, 404);
});

await checkAsync('tenant B user cannot see tenant A notifications', async () => {
  reset();
  await call(admin, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  const r = await call(tenantB, 'GET', '/notifications');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.items.length, 0);
});

await checkAsync('eligible members never cross a tenant', async () => {
  reset();
  const r = await call(admin, 'GET', '/conversations/eligible-members');
  assert.equal(r.status, 200);
  const ids = r.body.data.map((m) => m.id);
  assert.ok(!ids.includes('u_b'), 'tenant B user must never appear');
  assert.deepEqual(ids.sort(), ['u_a1', 'u_a2', 'u_admin', 'u_sup']);
});

/* ================================================================ */
console.log('\n=== B. route ordering ===');

await checkAsync('/eligible-members is NOT captured as :id (404, not 500)', async () => {
  reset();
  const r = await call(admin, 'GET', '/conversations/eligible-members');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  // A captured :id would look like a uuid lookup → 404. A uuid cast error → 500.
  assert.notEqual(r.status, 500);
});

await checkAsync('unknown conversation id returns 404, not 500', async () => {
  reset();
  const r = await call(admin, 'GET', '/conversations/not-a-uuid');
  assert.equal(r.status, 404);
});

await checkAsync('notes route is not captured as :id', async () => {
  reset();
  const r = await call(admin, 'GET', '/conversations/c1/notes');
  assert.equal(r.status, 200);
});

/* ================================================================ */
console.log('\n=== C. handoff + AI gate ===');

await checkAsync('staff handoff moves AI_ACTIVE → QUEUED and notifies', async () => {
  reset();
  const r = await call(admin, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.state, 'QUEUED');
  assert.equal(DB.conversations.get('c1').state, 'QUEUED');
  const { evaluateAiGate } = await import('../src/services/aiGate.js');
  const gate = await evaluateAiGate({ tenantId: 't1', conversationId: 'c1', db: pool });
  assert.equal(gate.suppressed, true);
  const n = DB.notifications.filter((x) => x.type === 'handoff.requested');
  assert.ok(n.length >= 1, 'eligible staff must be notified');
});

await checkAsync('handoff without a reason is rejected', async () => {
  reset();
  const r = await call(admin, 'POST', '/conversations/c1/handoff', {});
  assert.equal(r.status, 422);
});

await checkAsync('resume-ai without a reason is rejected', async () => {
  reset();
  await call(admin, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  const r = await call(admin, 'POST', '/conversations/c1/resume-ai', {});
  assert.equal(r.status, 422);
});

await checkAsync('RESOLVED keeps AI off until explicit resume-ai', async () => {
  reset();
  await call(admin, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  await call(admin, 'POST', '/conversations/c1/assign', { userId: a1 });
  const resolved = await call(admin, 'POST', '/conversations/c1/resolve', {});
  assert.equal(resolved.body.data.state, 'RESOLVED');
  // nobody resumed it: still suppressed
  let gate = await (await import('../src/services/aiGate.js')).evaluateAiGate({ tenantId: 't1', conversationId: 'c1', db: pool });
  assert.equal(gate.suppressed, true);
  const resumed = await call(admin, 'POST', '/conversations/c1/resume-ai', { reason: 'customer confirmed handled' });
  assert.equal(resumed.body.data.state, 'AI_ACTIVE');
  gate = await (await import('../src/services/aiGate.js')).evaluateAiGate({ tenantId: 't1', conversationId: 'c1', db: pool });
  assert.equal(gate.suppressed, false);
});

/* ================================================================ */
console.log('\n=== D. RBAC matrix ===');

await checkAsync('Agent CANNOT assign someone else (403)', async () => {
  reset();
  await toQueued('c1');
  const r = await call(a1, 'POST', '/conversations/c1/assign', { userId: a2 });
  assert.equal(r.status, 403);
});

await checkAsync('Agent CANNOT unassign (403)', async () => {
  reset();
  await toQueued('c1');
  const r = await call(a1, 'POST', '/conversations/c1/unassign', { reason: 'x' });
  assert.equal(r.status, 403);
});

await checkAsync('Agent CANNOT resume AI (403)', async () => {
  reset();
  await toQueued('c1');
  const r = await call(a1, 'POST', '/conversations/c1/resume-ai', { reason: 'x' });
  assert.equal(r.status, 403);
});

await checkAsync('Agent CAN claim', async () => {
  reset();
  await (await import('../src/services/handoff.js')).requestHandoff({ tenantId: 't1', conversationId: 'c1', reason: 'customer_requested_human' }, { db: pool });
  const r = await call(a2, 'POST', '/conversations/c1/claim', { reason: 'taking it' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.assignedUserId, 'u_a2');
});

await checkAsync('Supervisor CAN assign someone else', async () => {
  reset();
  await (await import('../src/services/handoff.js')).requestHandoff({ tenantId: 't1', conversationId: 'c1', reason: 'customer_requested_human' }, { db: pool });
  const r = await call(sup, 'POST', '/conversations/c1/assign', { userId: a1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.assignedUserId, 'u_a1');
});

await checkAsync('Agent CANNOT resolve a conversation owned by another agent (403)', async () => {
  reset();
  await toQueued('c1'); // assigned to a1
  const r = await call(a2, 'POST', '/conversations/c1/resolve', {});
  assert.equal(r.status, 403);
});

await checkAsync('Agent CAN resolve their own conversation', async () => {
  reset();
  await toQueued('c1'); // assigned to a1
  const r = await call(a1, 'POST', '/conversations/c1/resolve', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.state, 'RESOLVED');
});

await checkAsync('Agent CANNOT request handoff on another agent conversation? (allowed: handoff is not assignment)', async () => {
  // Handoff requires the conversation to still be AI_ACTIVE; once QUEUED the
  // request must fail with a state conflict rather than a permission error.
  reset();
  await toQueued('c1');
  const r = await call(a2, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  assert.equal(r.status, 409);
});

/* ================================================================ */
console.log('\n=== E. internal notes (staff only) ===');

await checkAsync('note is created and never appears in the message timeline', async () => {
  reset();
  const created = await call(a1, 'POST', '/conversations/c1/notes', { body: 'internal: call the customer at 5pm' });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const detail = await call(a1, 'GET', '/conversations/c1');
  assert.equal(detail.status, 200);
  const joined = JSON.stringify(detail.body.data.messages);
  assert.ok(!joined.includes('internal: call the customer'), 'a note must never leak into the timeline');
  assert.ok(!('notes' in detail.body.data.conversation) || detail.body.data.conversation.notes === undefined);
});

await checkAsync('note body must be 1..4000 chars', async () => {
  reset();
  assert.equal((await call(a1, 'POST', '/conversations/c1/notes', { body: '' })).status, 422);
  assert.equal((await call(a1, 'POST', '/conversations/c1/notes', { body: 'x'.repeat(4001) })).status, 422);
});

await checkAsync('Agent cannot delete another user note (403)', async () => {
  reset();
  const created = await call(a1, 'POST', '/conversations/c1/notes', { body: 'mine' });
  const r = await call(a2, 'DELETE', `/conversations/c1/notes/${created.body.data.id}`);
  assert.equal(r.status, 403);
});

await checkAsync('Supervisor can delete any note', async () => {
  reset();
  const created = await call(a1, 'POST', '/conversations/c1/notes', { body: 'mine' });
  const r = await call(sup, 'DELETE', `/conversations/c1/notes/${created.body.data.id}`);
  assert.equal(r.status, 200);
});

await checkAsync('notes are tenant-scoped', async () => {
  reset();
  await call(admin, 'POST', '/conversations/c1/notes', { body: 'secret' });
  // Tenant A admin asking for a TENANT B conversation → 404.
  const r = await call(admin, 'GET', '/conversations/x1/notes');
  assert.equal(r.status, 404);
});

/* ================================================================ */
console.log('\n=== F. human reply ===');

await checkAsync('Agent replies on their own assigned conversation', async () => {
  reset();
  await toQueued('c1'); // assigned to a1
  sendCalls = [];
  const r = await call(a1, 'POST', '/conversations/c1/reply', { text: 'هلا والله معك أحمد' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.deliveryStatus, 'sent');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].target.kind, 'dm');
  const msg = [...DB.messages.values()].at(-1);
  assert.equal(msg.sender_type, 'employee');
});

await checkAsync('Agent CANNOT reply on another agent conversation (403)', async () => {
  reset();
  await toQueued('c1'); // assigned to a1
  sendCalls = [];
  const r = await call(a2, 'POST', '/conversations/c1/reply', { text: 'hi' });
  assert.equal(r.status, 403);
  assert.equal(sendCalls.length, 0);
});

await checkAsync('Supervisor CAN reply on any human-handled conversation', async () => {
  reset();
  await toQueued('c1'); // assigned to a1
  sendCalls = [];
  const r = await call(sup, 'POST', '/conversations/c1/reply', { text: 'معاك فريقنا' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sendCalls.length, 1);
});

await checkAsync('human reply refused while AI_ACTIVE (409)', async () => {
  reset();
  sendCalls = [];
  const r = await call(admin, 'POST', '/conversations/c2/reply', { text: 'hi' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'HUMAN_REPLY_NOT_HUMAN_HANDLED');
  assert.equal(sendCalls.length, 0, 'no provider call may happen');
});

await checkAsync('double submit does not send twice', async () => {
  reset();
  await toQueued('c1');
  sendCalls = [];
  await call(a1, 'POST', '/conversations/c1/reply', { text: 'same text' });
  const second = await call(a1, 'POST', '/conversations/c1/reply', { text: 'same text' });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate, true);
  assert.equal(sendCalls.length, 1);
});

await checkAsync('empty reply is rejected', async () => {
  reset();
  await toQueued('c1');
  const r = await call(a1, 'POST', '/conversations/c1/reply', { text: '' });
  assert.equal(r.status, 422);
});

await checkAsync('responses never expose credentials or internal notes', async () => {
  reset();
  await call(a1, 'POST', '/conversations/c1/notes', { body: 'TOP-SECRET-NOTE-12345' });
  await toQueued('c1');
  await call(a1, 'POST', '/conversations/c1/reply', { text: 'public reply text' });
  const detail = await call(admin, 'GET', '/conversations/c1');
  const payload = JSON.stringify(detail.body);
  // credentials / secrets must never appear
  assert.ok(!/page_access_token|Authorization|Bearer |access_token|password|token/i.test(payload), 'no credential material in responses');
  // internal notes must never be part of the message timeline payload
  const timeline = JSON.stringify(detail.body.data.messages);
  assert.ok(!timeline.includes('TOP-SECRET-NOTE-12345'), 'a note must never leak into the timeline');
  // the human reply IS visible in the timeline (it is a real customer-facing message)
  assert.ok(timeline.includes('public reply text'));
});

await checkAsync('audit rows record the action without the message body', async () => {
  reset();
  await toQueued('c1');
  await call(a1, 'POST', '/conversations/c1/reply', { text: 'SUPER-SECRET-BODY-9999' });
  const row = DB.audit.find((a) => a.action === 'conversation.human_reply');
  assert.ok(row, 'a human reply must be audited');
  assert.ok(!JSON.stringify(row.metadata).includes('SUPER-SECRET-BODY-9999'), 'the reply body must not be audited');
  assert.equal(row.object_id, 'c1');
});

/* ================================================================ */
console.log('\n=== G. notifications ===');

await checkAsync('unread count + mark read + mark all read', async () => {
  reset();
  await call(admin, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  const list = await call(admin, 'GET', '/notifications?unreadOnly=1');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.unread >= 1);
  const first = list.body.data.items[0];
  const readOne = await call(admin, 'POST', `/notifications/${first.id}/read`, {});
  assert.equal(readOne.status, 200);
  const after = await call(admin, 'GET', '/notifications');
  assert.ok(after.body.data.unread < list.body.data.unread);
  const all = await call(admin, 'POST', '/notifications/read-all', {});
  assert.equal(all.status, 200);
  const cleared = await call(admin, 'GET', '/notifications');
  assert.equal(cleared.body.data.unread, 0);
});

await checkAsync('a user cannot mark someone else notification read', async () => {
  reset();
  await call(admin, 'POST', '/conversations/c1/handoff', { reason: 'customer_requested_human' });
  const list = await call(a1, 'GET', '/notifications');
  const foreign = DB.notifications.find((n) => n.user_id === 'u_admin');
  if (foreign) {
    const r = await call(a1, 'POST', `/notifications/${foreign.id}/read`, {});
    assert.equal(r.status, 404);
  }
});

/* ================================================================ */
console.log('\n=== H. list filters + shape ===');

await checkAsync('needs_human filter returns only human-handled conversations', async () => {
  reset();
  await toQueued('c1');
  await toQueued('c2');
  const dbg = [...DB.conversations.values()].map(c=>c.id+':'+c.state).join(',');
  const r = await call(admin, 'GET', '/conversations?state=needs_human');
  assert.equal(r.status, 200);
  const ids = r.body.data.map((c) => c.id).sort();
  assert.deepEqual(ids, ['c1', 'c2']);
  assert.ok(r.body.data.every((c) => c.needsHuman === true));
});

await checkAsync('assignedTo=me returns only my conversations', async () => {
  reset();
  await toQueued('c1'); // a1
  const r = await call(a1, 'GET', '/conversations?assignedTo=me');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((c) => c.id), ['c1']);
});

await checkAsync('list never exposes internal notes', async () => {
  reset();
  await call(a1, 'POST', '/conversations/c1/notes', { body: 'TOP-SECRET-NOTE' });
  const r = await call(admin, 'GET', '/conversations');
  assert.ok(!JSON.stringify(r.body).includes('TOP-SECRET-NOTE'));
});

await checkAsync('dashboard exposes Stage 7 counters', async () => {
  reset();
  await toQueued('c1'); // assigned to a1
  const r = await call(admin, 'GET', '/dashboard');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.kpis.needs_human, 0);
  assert.equal(r.body.data.kpis.human_active, 1);
  assert.equal(r.body.data.kpis.assigned_to_me, 0);
  const asA1 = await call(a1, 'GET', '/dashboard');
  assert.equal(asA1.body.data.kpis.assigned_to_me, 1);
});

server.close();
console.log(`\nStage 7 Batch 2: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);






