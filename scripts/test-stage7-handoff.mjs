/**
 * Stage 7 — Batch 1 focused backend tests.
 * Runs fully offline: installs a stub pool (same pattern as the existing
 * Stage 4/5 test scripts) so no PostgreSQL is required.
 *
 *   node scripts/test-stage7-handoff.mjs
 */
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const { pool } = await import('../src/db/pg.js');
assert.ok(pool, 'stub pool missing');

/* ---------------------------------------------------------------- */
/* in-memory database                                               */
/* ---------------------------------------------------------------- */

const DB = {
  conversations: new Map(),   // id -> row
  assignments: [],
  escalations: [],
  notifications: [],
  users: new Map(),
  roles: new Map(),
  userRoles: [],
  messages: new Map(),        // id -> row
  channels: new Map(),        // id -> row
  seq: 0
};

function uid(prefix = 'r') {
  DB.seq += 1;
  return `${prefix}_${DB.seq}`;
}

function resetDb() {
  DB.conversations.clear();
  DB.assignments.length = 0;
  DB.escalations.length = 0;
  DB.notifications.length = 0;
  DB.users.clear();
  DB.roles.clear();
  DB.userRoles.length = 0;
  DB.messages.clear();
  DB.channels.clear();
  DB.seq = 0;
  // Channel rows exist so the human-reply path can resolve provider context.
  DB.channels.set('ch_dm', { id: 'ch_dm', tenant_id: 't1', provider: 'meta_dm', external_id: 'page_1', display_name: 'Messenger DM', brand_id: null, status: 'active' });
  DB.channels.set('ch_comment', { id: 'ch_comment', tenant_id: 't1', provider: 'meta_comment', external_id: 'page_1', display_name: 'Facebook comments', brand_id: null, status: 'active' });
}

function now() {
  return new Date().toISOString();
}

/** Seed a tenant with users + roles, mirroring the production role model. */
function seedTenant() {
  const t = 't1';
  for (const name of ['Company Admin', 'Supervisor', 'Agent']) DB.roles.set(name, name);
  for (const [id, name, roles] of [
    ['u_admin', 'Admin', ['Company Admin']],
    ['u_sup', 'Supervisor', ['Supervisor']],
    ['u_a1', 'Agent One', ['Agent']],
    ['u_a2', 'Agent Two', ['Agent']],
    ['u_off', 'Disabled Agent', ['Agent']]
  ]) {
    DB.users.set(id, { id, name, email: `${id}@x.test`, tenant_id: t, status: id === 'u_off' ? 'disabled' : 'active' });
    for (const r of roles) DB.userRoles.push({ user_id: id, role_name: r });
  }
  return t;
}

function newConversation({ tenantId, state = 'AI_ACTIVE', assignedUserId = null, assignedTeamId = null }) {
  const id = uid('conv');
  DB.conversations.set(id, {
    id, tenant_id: tenantId, state, assigned_user_id: assignedUserId, assigned_team_id: assignedTeamId,
    priority: 'normal', resolved_at: null, external_key: 'psid_1', channel_id: 'ch_dm', customer_id: 'cust_1',
    created_at: now()
  });
  return id;
}

/* ---------------------------------------------------------------- */
/* stub pool                                                        */
/* ---------------------------------------------------------------- */

pool.query = async (sql, params = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();

  // ---- conversations: guarded transition UPDATE (dynamic SET + WHERE) ----
  let m = q.match(/^UPDATE conversations SET (.+?) WHERE id = \$(\d+) AND tenant_id = \$(\d+) AND state = ANY\(\$\d+::text\[\]\) RETURNING id, state, assigned_user_id, assigned_team_id, priority, resolved_at$/);
  if (m) {
    // Model two concurrent transactions: yield so the second caller observes
    // the row AFTER the first one has already applied its guarded UPDATE.
    await new Promise((r) => setImmediate(r));
    const setClause = m[1];
    const setParamCount = Number(m[2]) - 1; // $1 is `state`, rest are SET columns
    const convId = params[setParamCount];
    const tenantId = params[setParamCount + 1];
    const fromStates = params[setParamCount + 2];
    const row = DB.conversations.get(convId);
    if (!row || row.tenant_id !== tenantId || !fromStates.includes(row.state)) return { rows: [] };
    row.state = params[0];
    // Apply each dynamic SET column from its positional parameter.
    for (const piece of setClause.split(', ')) {
      const pm = piece.match(/^(\w+) = \$(\d+)$/);
      if (!pm) continue;
      row[pm[1]] = params[Number(pm[2]) - 1];
    }
    return { rows: [row] };
  }

  if (q.startsWith('SELECT id, state FROM conversations WHERE id = $1 AND tenant_id = $2')) {
    const row = DB.conversations.get(params[0]);
    if (!row || row.tenant_id !== params[1]) return { rows: [] };
    return { rows: [{ id: row.id, state: row.state }] };
  }

  if (q.startsWith('SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2')) {
    const row = DB.conversations.get(params[0]);
    return { rows: row && row.tenant_id === params[1] ? [{ id: row.id }] : [] };
  }

  if (q.startsWith('SELECT c.id, c.tenant_id, c.state, c.assigned_user_id')) {
    const row = DB.conversations.get(params[0]);
    if (!row || row.tenant_id !== params[1]) return { rows: [] };
    return { rows: [{ ...row, channel_name: 'DM', brand_name: 'Brand', assigned_user_name: row.assigned_user_id }] };
  }

  if (q.startsWith('UPDATE conversations SET last_message_at = now() WHERE id = $1')) {
    const row = DB.conversations.get(params[0]);
    if (row) row.last_message_at = now();
    return { rows: [] };
  }

  // ---- assignments ----
  if (q.startsWith('INSERT INTO assignments')) {
    DB.assignments.push({
      id: uid('asg'), _seq: ++DB.seq, tenant_id: params[0], conversation_id: params[1], action: params[2],
      user_id: params[3], team_id: params[4], reason: params[5], assigned_by: params[6], created_at: now()
    });
    return { rows: [] };
  }

  // ---- escalations ----
  if (q.startsWith('SELECT id FROM escalations')) {
    const row = DB.escalations.filter((e) => e.conversation_id === params[0] && e.tenant_id === params[1] && e.resolved_at === null).pop();
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (q.startsWith('UPDATE escalations SET status')) {
    const row = DB.escalations.find((e) => e.id === params[4]);
    if (row) { row.status = params[0]; row.assigned_user_id = params[1]; row.assigned_team_id = params[2]; }
    return { rows: [] };
  }
  if (q.startsWith('INSERT INTO escalations')) {
    DB.escalations.push({
      id: uid('esc'), tenant_id: params[0], conversation_id: params[1], category: params[2],
      reason: params[3], priority: params[4], status: params[5], requested_by: params[6],
      assigned_user_id: params[7], assigned_team_id: params[8], resolved_at: null, created_at: now()
    });
    return { rows: [] };
  }
  if (q.startsWith('UPDATE escalations SET status = \'done\', resolved_at = now()')) {
    for (const e of DB.escalations) {
      if (e.conversation_id === params[0] && e.tenant_id === params[1] && e.resolved_at === null) e.resolved_at = now();
    }
    return { rows: [] };
  }

  // ---- eligibility ----
  if (q.startsWith('SELECT 1')) {
    const [userId, tenantId, handling] = params;
    const u = DB.users.get(userId);
    if (!u || u.tenant_id !== tenantId || u.status !== 'active') return { rows: [] };
    const has = DB.userRoles.some((r) => r.user_id === userId && handling.includes(r.role_name));
    return { rows: has ? [{ 1: 1 }] : [] };
  }
  if (q.startsWith('SELECT u.id, u.name, u.email, u.status')) {
    const [tenantId, handling, teamId] = params;
    const rows = [...DB.users.values()]
      .filter((u) => u.tenant_id === tenantId && u.status === 'active')
      .filter((u) => DB.userRoles.some((r) => r.user_id === u.id && handling.includes(r.role_name)))
      .map((u) => ({ id: u.id, name: u.name, email: u.email, status: u.status, roles: DB.userRoles.filter((r) => r.user_id === u.id).map((r) => r.role_name) }));
    return { rows };
  }
  if (q.startsWith('SELECT DISTINCT u.id')) {
    const [tenantId, handling] = params;
    const rows = [...DB.users.values()]
      .filter((u) => u.tenant_id === tenantId && u.status === 'active')
      .filter((u) => DB.userRoles.some((r) => r.user_id === u.id && handling.includes(r.role_name)))
      .map((u) => ({ id: u.id }));
    return { rows };
  }

  // ---- messages ----
  if (q.startsWith('INSERT INTO messages')) {
    const [tenantId, conversationId, text, sentinel, providerTs, status, err, senderType] = params;
    if ([...DB.messages.values()].some((x) => x.conversation_id === conversationId && x.provider_message_id === sentinel)) {
      return { rows: [] };
    }
    const row = {
      id: uid('msg'), tenant_id: tenantId, conversation_id: conversationId, direction: 'outbound',
      sender_type: senderType, text, provider_message_id: sentinel, provider_ts: providerTs,
      delivery_status: status, delivery_error: err, retry_count: 0, created_at: now()
    };
    DB.messages.set(row.id, row);
    const conv = DB.conversations.get(conversationId);
    if (conv) conv.last_message_at = now();
    return { rows: [row] };
  }
  if (q.startsWith('SELECT id, provider_message_id, text, created_at, provider_ts')) {
    const rows = [...DB.messages.values()]
      .filter((x) => x.tenant_id === params[0] && x.conversation_id === params[1] && x.direction === 'inbound')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { rows: rows.slice(0, 1) };
  }
  if (q.startsWith('SELECT id, delivery_status, delivery_error, provider_message_id')) {
    const rows = [...DB.messages.values()]
      .filter((x) =>
        x.tenant_id === params[0] && x.conversation_id === params[1] &&
        x.direction === 'outbound' && x.sender_type === 'employee' && x.text === params[2] &&
        Date.now() - new Date(x.created_at).getTime() < 2 * 60 * 1000)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { rows: rows.slice(0, 1) };
  }
  if (q.startsWith('UPDATE messages m')) {
    const [messageId, conversationId, tenantId, senderTypes] = params;
    const row = [...DB.messages.values()].find((x) =>
      x.id === messageId && x.conversation_id === conversationId && x.tenant_id === tenantId &&
      x.direction === 'outbound' && senderTypes.includes(x.sender_type) && x.delivery_status === 'failed');
    if (!row) return { rows: [] };
    row.delivery_status = 'pending';
    row.delivery_error = null;
    row.retry_count += 1;
    return { rows: [row] };
  }
  if (q.startsWith('UPDATE messages')) {
    const [status, err, providerId, messageId, tenantId] = params;
    const row = [...DB.messages.values()].find((x) => x.id === messageId && x.tenant_id === tenantId && x.direction === 'outbound');
    if (!row) return { rows: [] };
    row.delivery_status = status;
    row.delivery_error = err;
    if (providerId) row.provider_message_id = providerId;
    return { rows: [row] };
  }

  // ---- channels (human reply context) ----
  if (q.startsWith('SELECT id, provider, external_id, display_name, brand_id, status')) {
    const ch = DB.channels.get(params[0]);
    if (!ch || ch.tenant_id !== params[1]) return { rows: [] };
    return { rows: [ch] };
  }

  // ---- assignment history ----
  if (q.startsWith('SELECT a.id, a.action')) {
    // ordered by insertion sequence (models created_at ordering in Postgres)
    const rows = DB.assignments
      .filter((a) => a.conversation_id === params[0] && a.tenant_id === params[1])
      .sort((a, b) => b._seq - a._seq)
      .slice(0, params[2])
      .map((a) => ({ ...a, actor_user_name: null, assigned_by_name: null }));
    return { rows };
  }

  // ---- notifications ----
  if (q.startsWith('INSERT INTO notifications')) {
    // (tenant_id, user_id, type, title, body, data) with shared $1..$4
    const [tenantId, type, title, body] = params.slice(0, 4);
    const rest = params.slice(4);
    for (let i = 0; i < rest.length; i += 2) {
      DB.notifications.push({
        id: uid('ntf'), tenant_id: tenantId, user_id: rest[i], type, title, body,
        data: JSON.parse(rest[i + 1] ?? '{}'), read_at: null, created_at: now()
      });
    }
    return { rows: [] };
  }
  if (q.startsWith('SELECT count(*)::int AS unread')) {
    const unread = DB.notifications.filter(
      (n) => n.tenant_id === params[0] && n.user_id === params[1] && n.read_at === null
    ).length;
    return { rows: [{ unread }] };
  }
  if (q.startsWith('UPDATE notifications SET read_at = now()')) {
    let n = 0;
    for (const row of DB.notifications) {
      if (row.tenant_id === params[0] && row.user_id === params[1] && row.read_at === null) { row.read_at = now(); n++; }
    }
    return { rows: [], rowCount: n };
  }
  if (q.startsWith('SELECT id, type, title, body, data, read_at, created_at')) {
    const rows = DB.notifications
      .filter((n) => n.tenant_id === params[0] && n.user_id === params[1])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, params[3]);
    return { rows };
  }
  if (q.startsWith('UPDATE notifications SET read_at = now() WHERE id')) {
    const row = DB.notifications.find((n) => n.id === params[0] && n.tenant_id === params[1] && n.user_id === params[2] && !n.read_at);
    if (!row) return { rows: [] };
    row.read_at = now();
    return { rows: [row] };
  }

  throw new Error(`unhandled SQL in stub pool: ${q.slice(0, 140)}`);
};

/* ---------------------------------------------------------------- */
/* modules under test                                               */
/* ---------------------------------------------------------------- */

const {
  CONVERSATION_STATES, HANDLED_STATES, isAiActive, TRANSITIONS, isAllowedTransition,
  requestHandoff, claimConversation, assignConversation, activateHumanHandling, unassignConversation,
  resolveConversation, resumeAi, listEligibleMembers, getConversationHandoffView,
  listAssignmentHistory, HandoffError
} = await import('../src/services/handoff.js');
const { detectCustomerHumanRequest } = await import('../src/services/handoffDetector.js');
const { evaluateAiGate } = await import('../src/services/aiGate.js');
const { createNotifications, countUnreadNotifications, markAllNotificationsRead } = await import('../src/services/notifications.js');
const { sendHumanReply, retryHumanReply, HumanReplyError, canUserReplyToConversation } = await import('../src/services/humanReply.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} :: ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} :: ${e.message}`); }
}

const auditTrail = [];
const notificationTrail = [];
const depsFor = (tenantId) => ({
  db: pool,
  actorUserId: 'u_admin',
  onHandoffRequested: async (p) => notificationTrail.push({ type: 'handoff.requested', ...p }),
  onAssigned: async (p) => notificationTrail.push({ type: 'conversation.assigned', ...p }),
  onUnassigned: async (p) => notificationTrail.push({ type: 'conversation.unassigned', ...p }),
  onResolved: async (p) => notificationTrail.push({ type: 'conversation.resolved', ...p }),
  onAiResumed: async (p) => notificationTrail.push({ type: 'conversation.resume_ai', ...p })
});

/* ================================================================ */
console.log('\n=== A. state model ===');
check('all six official states exist', () => {
  assert.deepEqual(Object.values(CONVERSATION_STATES), [
    'AI_ACTIVE', 'HUMAN_REQUIRED', 'QUEUED', 'ASSIGNED', 'HUMAN_ACTIVE', 'RESOLVED'
  ]);
});
check('AI is active only for AI_ACTIVE', () => {
  for (const s of Object.values(CONVERSATION_STATES)) {
    assert.equal(isAiActive(s), s === 'AI_ACTIVE', `state ${s}`);
  }
});
check('HANDLED_STATES = every non-AI state', () => {
  assert.equal(HANDLED_STATES.length, 5);
  assert.ok(!HANDLED_STATES.includes('AI_ACTIVE'));
});
check('official happy path is permitted', () => {
  const path = ['AI_ACTIVE', 'HUMAN_REQUIRED', 'QUEUED', 'ASSIGNED', 'HUMAN_ACTIVE', 'RESOLVED'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(isAllowedTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`);
  }
});
check('RESOLVED never resumes AI automatically', () => {
  // The only path back to AI_ACTIVE is the explicit resumeAi() action, which
  // requires Admin/Supervisor AND a reason — the state machine itself has no
  // automatic RESOLVED → AI_ACTIVE edge.
  assert.ok(isAllowedTransition('RESOLVED', 'AI_ACTIVE')); // explicit action only
  assert.ok(!TRANSITIONS.some((t) => t.to === 'AI_ACTIVE' && t.automatic));
});
check('AI_ACTIVE cannot be assigned directly', () => {
  assert.ok(!isAllowedTransition('AI_ACTIVE', 'ASSIGNED'));
});
check('QUEUED cannot resolve', () => {
  assert.ok(!isAllowedTransition('QUEUED', 'RESOLVED'));
});
check('explicit Resume AI allowed from every non-AI state', () => {
  for (const s of HANDLED_STATES) assert.ok(isAllowedTransition(s, 'AI_ACTIVE'), s);
});
check('unassign returns the conversation to QUEUED', () => {
  assert.ok(isAllowedTransition('ASSIGNED', 'QUEUED'));
  assert.ok(isAllowedTransition('HUMAN_ACTIVE', 'QUEUED'));
});

/* ================================================================ */
console.log('\n=== B. customer handoff detector ===');

const MUST_TRIGGER = [
  'عايز أكلم موظف', 'ممكن أكلم حد', 'عايز مدير', 'أريد التحدث مع موظف',
  'I want to speak to a human', 'Can I talk to an agent?', 'Get me a manager',
  'عايزة أكلم حد من المسؤولين', 'ابغى اكلم موظف', 'i need to talk to someone please',
  'مش بوت right? بدي أكلم موظف', 'are you a bot? i want a real person'
];
const MUST_NOT_TRIGGER = [
  'بكم الكيك؟', 'وين الفرع؟', 'عندكم منيو؟', 'مواعيد العمل؟', 'Do you deliver?',
  'Opening hours?', 'عندكم حجز؟', 'كم سعر البوكس', 'وين اقرب فرع',
  'رقمي 99991234', 'my email is a@b.com', 'الاكل كان مو حلو وعيب',
  'مش عايز أكلم موظف', "I don't need an agent", 'i do not want to speak to anyone',
  '', '   ', '🔥🔥🔥', 'the manager recommended this cake yesterday'
];

for (const t of MUST_TRIGGER) {
  check(`triggers: "${t}"`, () => {
    const r = detectCustomerHumanRequest(t);
    assert.equal(r.matched, true, JSON.stringify(r));
    assert.equal(r.actor, 'customer');
  });
}
for (const t of MUST_NOT_TRIGGER) {
  check(`does NOT trigger: "${t}"`, () => {
    assert.equal(detectCustomerHumanRequest(t).matched, false, JSON.stringify(detectCustomerHumanRequest(t)));
  });
}
check('very long messages are ambiguous (AI stays on)', () => {
  assert.equal(detectCustomerHumanRequest('عايز '.repeat(200) + 'أكلم موظف').matched, false);
});
check('mixed language triggers', () => {
  assert.equal(detectCustomerHumanRequest('I want to speak to موظف').matched, true);
});

/* ================================================================ */
console.log('\n=== C. transitions + concurrency ===');

await checkAsync('full happy path AI_ACTIVE → … → RESOLVED', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  const h = await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human', requestedBy: 'customer' }, d);
  assert.equal(h.state, 'QUEUED');
  assert.equal(DB.conversations.get(id).state, 'QUEUED');

  const a = await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  assert.equal(a.state, 'ASSIGNED');
  assert.equal(DB.conversations.get(id).assigned_user_id, 'u_a1');

  const act = await activateHumanHandling({ tenantId: t, conversationId: id }, d);
  assert.equal(act.state, 'HUMAN_ACTIVE');

  const r = await resolveConversation({ tenantId: t, conversationId: id }, d);
  assert.equal(r.state, 'RESOLVED');
  assert.ok(DB.conversations.get(id).resolved_at);
});

await checkAsync('RESOLVED keeps AI off until explicit resume', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  await resolveConversation({ tenantId: t, conversationId: id }, d);
  // no auto resume:
  assert.equal(DB.conversations.get(id).state, 'RESOLVED');
  const gate = await evaluateAiGate({ tenantId: t, conversationId: id, db: pool });
  assert.equal(gate.suppressed, true);
  // resume requires a reason
  await assert.rejects(() => resumeAi({ tenantId: t, conversationId: id, reason: 'x' }, d), (e) => e.code === 'HANDOFF_REASON_REQUIRED');
  const resumed = await resumeAi({ tenantId: t, conversationId: id, reason: 'customer confirmed handled' }, d);
  assert.equal(resumed.state, 'AI_ACTIVE');
  assert.equal(DB.conversations.get(id).assigned_user_id, null);
  const after = await evaluateAiGate({ tenantId: t, conversationId: id, db: pool });
  assert.equal(after.suppressed, false);
});

await checkAsync('concurrent claim: exactly ONE winner', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  const results = await Promise.allSettled([
    claimConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d),
    claimConversation({ tenantId: t, conversationId: id, userId: 'u_a2' }, d)
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, `expected 1 winner, got ${won.length}`);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, 'HANDOFF_CONFLICT');
  assert.equal(DB.conversations.get(id).assigned_user_id, won[0].value.assignedUserId);
});

await checkAsync('eligibility excludes other tenants and disabled users', async () => {
  resetDb(); const t = seedTenant();
  const rows = await listEligibleMembers({ tenantId: t, db: pool });
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids.sort(), ['u_a1', 'u_a2', 'u_admin', 'u_sup']);
  assert.ok(!ids.includes('u_off'), 'disabled user must not be eligible');
});

await checkAsync('assigning an ineligible user is rejected', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assert.rejects(
    () => assignConversation({ tenantId: t, conversationId: id, userId: 'u_off' }, d),
    (e) => e.code === 'HANDOFF_USER_NOT_ELIGIBLE'
  );
  await assert.rejects(
    () => assignConversation({ tenantId: t, conversationId: id, userId: 'u_stranger' }, d),
    (e) => e.code === 'HANDOFF_USER_NOT_ELIGIBLE'
  );
});

await checkAsync('cross-tenant access is rejected (no data returned)', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  // getConversationHandoffView returns null for a foreign tenant (callers throw 404).
  assert.equal(await getConversationHandoffView({ tenantId: 't_other', conversationId: id, db: pool }), null);
  // The AI gate must never let a foreign tenant suppress or resume anything.
  const gate = await evaluateAiGate({ tenantId: 't_other', conversationId: id, db: pool });
  assert.equal(gate.suppressed, false);
  assert.equal(gate.state, null);
});

await checkAsync('direct reassign, unassign, then fresh assign keep full history', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);

  // direct reassignment: ASSIGNED → ASSIGNED with a different eligible user
  const re = await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a2', reason: 'better fit' }, d);
  assert.equal(re.action, 'reassigned');
  assert.equal(re.previousAssignee, 'u_a1');

  // unassign returns it to the queue with no assignee
  await unassignConversation({ tenantId: t, conversationId: id, reason: 'wrong team' }, d);
  assert.equal(DB.conversations.get(id).state, 'QUEUED');
  assert.equal(DB.conversations.get(id).assigned_user_id, null);

  // a fresh assign after unassign is a NEW assignment, not a reassignment
  const fresh = await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  assert.equal(fresh.action, 'assigned');

  const history = await listAssignmentHistory({ tenantId: t, conversationId: id, db: pool });
  // newest first: handoff-queue entry + each transition
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((h) => h.action), ['assigned', 'unassigned', 'reassigned', 'assigned', 'assigned'], JSON.stringify(history.map((h) => h.action)));
  // History is append-only: nothing is ever rewritten or deleted.
  assert.ok(history.every((h) => h.reason !== undefined));
});

await checkAsync('handoff keeps AI off and notifies', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human', requestedBy: 'customer' }, d);
  const gate = await evaluateAiGate({ tenantId: t, conversationId: id, db: pool });
  assert.equal(gate.suppressed, true);
  assert.equal(gate.state, 'QUEUED');
  assert.equal(notificationTrail.at(-1).type, 'handoff.requested');
  assert.equal(DB.escalations.at(-1).requested_by, 'customer');
});

/* ================================================================ */
console.log('\n=== D. notifications ===');

await checkAsync('notification recipients are tenant-scoped', async () => {
  resetDb(); const t = seedTenant();
  const n = await createNotifications({ tenantId: t, userIds: ['u_a1', 'u_a2'], type: 'handoff.requested', title: 'x', data: { conversationId: 'c1' }, db: pool });
  assert.equal(n, 2);
  assert.equal(DB.notifications.length, 2);
  for (const row of DB.notifications) assert.equal(row.tenant_id, t);
});
await checkAsync('unread counter + mark-all-read', async () => {
  resetDb(); const t = seedTenant();
  await createNotifications({ tenantId: t, userIds: ['u_a1'], type: 'conversation.assigned', title: 'a', db: pool });
  await createNotifications({ tenantId: t, userIds: ['u_a1'], type: 'conversation.resolved', title: 'b', db: pool });
  assert.equal(await countUnreadNotifications({ tenantId: t, userId: 'u_a1', db: pool }), 2);
  assert.equal(await countUnreadNotifications({ tenantId: t, userId: 'u_a2', db: pool }), 0);
  assert.equal(await markAllNotificationsRead({ tenantId: t, userId: 'u_a1', db: pool }), 2);
  assert.equal(await countUnreadNotifications({ tenantId: t, userId: 'u_a1', db: pool }), 0);
});

/* ================================================================ */
console.log('\n=== E. human reply (mocked provider) ===');

/** Mock the provider adapter so NO live Meta call is ever made. */
const metaAdapter = (await import('../src/providers/meta/humanOutbound.js')).metaHumanOutboundAdapter;
let sendCalls = [];
let nextSendFails = false;
metaAdapter.send = async ({ target, text }) => {
  sendCalls.push({ target, text });
  if (nextSendFails) throw new Error('Graph API 400 (code 1545041): Messaging window closed');
  return { providerMessageId: 'mid_1', mechanism: 'response' };
};
/** Injected credential resolver — no real credential is ever loaded. */
const fakeCredential = async () => 'injected-test-credential';
const reply = (extra) => ({ resolveCredential: fakeCredential, ...extra });

await checkAsync('DM human reply persists employee + sent', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  sendCalls = [];
  const r = await sendHumanReply(reply({
    tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'],
    text: 'هلا والله، معك أحمد', idempotencyKey: 'k1'
  }));
  assert.equal(r.deliveryStatus, 'sent');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].target.kind, 'dm');
  assert.equal(sendCalls[0].target.identifier, 'psid_1');
  const msg = [...DB.messages.values()].find((m) => m.id === r.messageId);
  assert.equal(msg.sender_type, 'employee');
});

await checkAsync('double submit does not send twice', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  sendCalls = [];
  await sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'], text: 'one', idempotencyKey: 'dup' }));
  const second = await sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'], text: 'one', idempotencyKey: 'dup' }));
  assert.equal(second.duplicate, true);
  assert.equal(sendCalls.length, 1, 'the provider must only be called once');
});

await checkAsync('Agent cannot reply to another agent conversation', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  await assert.rejects(
    () => sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a2', roles: ['Agent'], text: 'hi' })),
    (e) => e instanceof HumanReplyError && e.code === 'HUMAN_REPLY_NOT_ALLOWED'
  );
});

await checkAsync('human reply is refused while AI_ACTIVE', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  await assert.rejects(
    () => sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_admin', roles: ['Company Admin'], text: 'hi' })),
    (e) => e.code === 'HUMAN_REPLY_NOT_HUMAN_HANDLED'
  );
});

await checkAsync('cross-tenant human reply is refused', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  await assert.rejects(
    () => sendHumanReply(reply({ tenantId: 't_other', conversationId: id, userId: 'u_admin', roles: ['Company Admin'], text: 'hi' })),
    (e) => e.status === 404
  );
});

await checkAsync('failed human send is stored as failed (never fake success)', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  nextSendFails = true;
  await assert.rejects(
    () => sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'], text: 'hi', idempotencyKey: 'f1' })),
    (e) => e.code === 'HUMAN_REPLY_SEND_FAILED'
  );
  nextSendFails = false;
  const msg = [...DB.messages.values()].at(-1);
  assert.equal(msg.delivery_status, 'failed');
  assert.equal(msg.delivery_error, 'messaging_window_closed');
  assert.equal(msg.sender_type, 'employee');
});

await checkAsync('failed human message can be retried, concurrency-safe', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_a1' }, d);
  nextSendFails = true;
  await assert.rejects(() => sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'], text: 'hi', idempotencyKey: 'f2' })), () => true);
  nextSendFails = false;
  const failedId = [...DB.messages.values()].at(-1).id;
  sendCalls = [];
  const results = await Promise.allSettled([
    retryHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'], messageId: failedId })),
    retryHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_a1', roles: ['Agent'], messageId: failedId }))
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(sendCalls.length, 1, 'a retried message must only reach the provider once');
  assert.equal(won[0].value.deliveryStatus, 'sent');
});

await checkAsync('comment replies are sanitized', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  DB.conversations.get(id).channel_id = 'ch_comment';
  const d = depsFor(t);
  await requestHandoff({ tenantId: t, conversationId: id, reason: 'customer_requested_human' }, d);
  await assignConversation({ tenantId: t, conversationId: id, userId: 'u_sup' }, d);
  sendCalls = [];
  await sendHumanReply(reply({ tenantId: t, conversationId: id, userId: 'u_sup', roles: ['Supervisor'], text: 'شوف المنيو\nhttps://link.lifewithcacao.com/\nتحياتنا' }));
  assert.equal(sendCalls[0].target.kind, 'comment');
  assert.ok(!/https?:\/\//.test(sendCalls[0].text), 'URLs must be stripped from public comment replies');
});

await checkAsync('reply authorization matrix', () => {
  const view = { assigned_user_id: 'u_a1' };
  assert.equal(canUserReplyToConversation({ roles: ['Company Admin'], userId: 'u_a2', view }), true);
  assert.equal(canUserReplyToConversation({ roles: ['Supervisor'], userId: 'u_a2', view }), true);
  assert.equal(canUserReplyToConversation({ roles: ['Agent'], userId: 'u_a1', view }), true);
  assert.equal(canUserReplyToConversation({ roles: ['Agent'], userId: 'u_a2', view }), false);
});

/* ================================================================ */
console.log('\n=== F. AI gate coverage ===');

await checkAsync('gate suppresses every non-AI state', async () => {
  resetDb(); const t = seedTenant();
  for (const s of HANDLED_STATES) {
    const id = newConversation({ tenantId: t, state: s });
    const gate = await evaluateAiGate({ tenantId: t, conversationId: id, db: pool });
    assert.equal(gate.suppressed, true, s);
    assert.equal(gate.state, s);
  }
});
await checkAsync('AI_ACTIVE is not suppressed', async () => {
  resetDb(); const t = seedTenant();
  const id = newConversation({ tenantId: t });
  const gate = await evaluateAiGate({ tenantId: t, conversationId: id, db: pool });
  assert.equal(gate.suppressed, false);
  assert.equal(gate.state, 'AI_ACTIVE');
});
await checkAsync('missing persistence context fails open (legacy mode)', async () => {
  const gate = await evaluateAiGate({ tenantId: null, conversationId: null, db: pool });
  assert.equal(gate.suppressed, false);
});

/* ================================================================ */
console.log(`\nStage 7 Batch 1: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);




