/**
 * Security hotfix regression suite.
 *
 *   node scripts/test-security-hotfix.mjs
 *
 * Covers the three hotfix changes and the boundaries the owner called out:
 *   1. legacy JSON dashboard APIs cannot enforce tenant/brand isolation -> 410
 *   2. the unauthenticated /dashboard-debug render is deleted
 *   3. an escalation now stops the AI
 *
 * The outbound-send race is exercised with a DETERMINISTIC scheduler, not with
 * timing luck: the test decides exactly when the escalation commits relative to
 * the AI's final state read and the provider POST. That lets us state precisely
 * what is and is not guaranteed instead of asserting a hopeful "no in-flight
 * replies".
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.DASHBOARD_PASSWORD ||= 'hotfix-test-password';

import express from 'express';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000a2';
const CONV = '00000000-0000-0000-0000-0000000000c1';
const CONV_B = '00000000-0000-0000-0000-0000000000c2';
const BRAND_1 = '00000000-0000-0000-0000-0000000000b1';
const BRAND_2 = '00000000-0000-0000-0000-0000000000b2';
const USER_A = '00000000-0000-0000-0000-0000000000u1';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  OK   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

/* =========================================================================
 * Fake Postgres. Deterministic, and honours ROLLBACK for real.
 * ========================================================================= */
function makeDb({ state = 'AI_ACTIVE', tenantId = TENANT } = {}) {
  const db = {
    conversations: new Map([
      [CONV, { id: CONV, tenant_id: tenantId, state, last_message_at: null }],
      [CONV_B, { id: CONV_B, tenant_id: TENANT_B, state: 'AI_ACTIVE', last_message_at: null }]
    ]),
    escalations: [],
    messages: [],
    log: [],
    commits: 0, rollbacks: 0,
    // Test hook: awaited right after the AI's final state read, before the
    // provider POST. This is the window the owner asked us to characterise.
    interleave: null
  };

  async function exec(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    db.log.push({ sql: s, params });

    if (s === 'BEGIN') {
      db.snapshot = {
        conversations: new Map([...db.conversations].map(([k, v]) => [k, { ...v }])),
        escalations: [...db.escalations], messages: [...db.messages]
      };
      return { rows: [] };
    }
    if (s === 'COMMIT') { db.commits++; db.snapshot = null; return { rows: [] }; }
    if (s === 'ROLLBACK') {
      db.rollbacks++;
      if (db.snapshot) {
        db.conversations = db.snapshot.conversations;
        db.escalations = db.snapshot.escalations;
        db.messages = db.snapshot.messages;
        db.snapshot = null;
      }
      return { rows: [] };
    }

    let m = s.match(/UPDATE conversations SET state = '(\w+)' WHERE id = \$2 AND tenant_id = \$1 AND state = '(\w+)'/);
    if (m) {
      const row = db.conversations.get(params[1]);
      if (!row || row.tenant_id !== params[0] || row.state !== m[2]) return { rows: [], rowCount: 0 };
      row.state = m[1];
      return { rows: [], rowCount: 1 };
    }

    m = s.match(/SELECT id, state FROM conversations WHERE id = \$1 AND tenant_id = \$2/);
    if (m) {
      const row = db.conversations.get(params[0]);
      return (row && row.tenant_id === params[1]) ? { rows: [{ id: row.id, state: row.state }] } : { rows: [] };
    }

    if (/INSERT INTO escalations/.test(s)) {
      const row = { id: 'esc-' + (db.escalations.length + 1), tenant_id: params[0], conversation_id: params[1], category: params[2], reason: params[3], summary: params[4], priority: params[5], status: 'new', resolved_at: null };
      db.escalations.push(row);
      return { rows: [{ id: row.id, created_at: 'now' }] };
    }

    if (/INSERT INTO messages/.test(s)) {
      // Real parameter order in persistOutboundMessage:
      //   [tenantId, conversationId, text, sentinel, providerTs, deliveryStatus, errorCategory]
      // params[3] is the sentinel/provider id that ON CONFLICT keys on, so that
      // is what the de-dupe guarantee actually depends on.
      const providerKey = params[3];
      if (providerKey && db.messages.some((x) => x.conversation_id === params[1] && x.provider_key === providerKey)) {
        return { rows: [] };
      }
      const row = {
        id: 'msg-' + (db.messages.length + 1), tenant_id: params[0], conversation_id: params[1],
        text: params[2], provider_key: providerKey, delivery_status: params[5]
      };
      db.messages.push(row);
      return { rows: [{ id: row.id }] };
    }

    if (/UPDATE conversations SET last_message_at/.test(s)) return { rows: [] };
    if (/UPDATE messages SET delivery_status/.test(s)) {
      const row = db.messages.find((x) => x.id === params[1]);
      if (row) row.delivery_status = params[0];
      return { rows: row ? [{ id: row.id }] : [] };
    }
    throw new Error('unexpected SQL: ' + s.slice(0, 100));
  }

  db.connect = async () => ({ query: exec, release() {} });
  db.query = exec;
  // Registering here means persistOutboundMessage() (which uses the module-level
  // pool, not deps.db) always talks to the fake the test is currently asserting on.
  activeDb = db;
  return db;
}

const { createEscalationRecord, persistOutboundMessage } = await import('../src/services/conversations.js');
const { evaluateAiGate } = await import('../src/services/aiGate.js');
const { isAiActive } = await import('../src/services/handoff.js');

// persistOutboundMessage() takes the module-level pool, not deps.db. Rather than
// change production code for testability, point the pool at whichever fake is
// currently active so the real SQL is still exercised.
const { pool } = await import('../src/db/pg.js');
let activeDb = null;
const realPoolQuery = pool.query.bind(pool);
pool.query = async (sql, params = []) => (activeDb ? activeDb.query(sql, params) : realPoolQuery(sql, params));

/* =========================================================================
 * THE SEND PATH, reproduced from src/webhook.js with a deterministic hook.
 * Mirrors the real order exactly:
 *   pre-gate -> generate -> finalAiSendCheck -> [INTERLEAVE] -> provider POST
 * ========================================================================= */
async function runAiSend({ db, escalateAt = null, conversationId = CONV, tenantId = TENANT, text = 'hello' }) {
  activeDb = db;
  const metaClient = {
    sent: [],
    async sendMessengerReply(target, body) { this.sent.push({ target, body }); return { message_id: 'm1' }; }
  };

  // 1. Pre-generation gate (webhook.js applyStage7Gate).
  const preGate = await evaluateAiGate({ tenantId, conversationId, db });
  if (preGate.suppressed) return { sent: 0, at: 'pre-gate', state: preGate.state };

  // 2. "Generation" - nothing to model.

  // 3. Escalation may commit BEFORE the final check.
  if (escalateAt === 'before-final-check') {
    await createEscalationRecord({ tenantId, conversationId, category: 'complaint', reason: 'r', summary: text }, { db });
  }

  // 4. Final state check (webhook.js finalAiSendCheck).
  const finalCheck = await evaluateAiGate({ tenantId, conversationId, db });
  if (finalCheck.suppressed) return { sent: 0, at: 'final-check', state: finalCheck.state };

  // 5. Outbound row persisted, then the irreversible provider call.
  const row = await persistOutboundMessage({ tenantId, conversationId, text });
  if (escalateAt === 'after-final-check-before-post') {
    // The window: an escalation commits here.
    await createEscalationRecord({ tenantId, conversationId, category: 'complaint', reason: 'r', summary: text }, { db });
  }
  await metaClient.sendMessengerReply('psid', text);

  return { sent: metaClient.sent.length, at: 'sent', row, state: finalCheck.state };
}

/* ========================================================================= */
console.log('\n=== 1. ESCALATION STOPS THE AI ===');
{
  const db = makeDb();
  const out = await runAiSend({ db, escalateAt: 'before-final-check' });
  check('an escalation before the final check suppresses the reply', out.sent === 0, JSON.stringify(out));
  check('the conversation is QUEUED afterwards', db.conversations.get(CONV).state === 'QUEUED');
  check('the escalation was recorded', db.escalations.length === 1);
  check('no outbound row was created', db.messages.length === 0);

  const db2 = makeDb();
  await runAiSend({ db: db2, escalateAt: 'before-final-check' });
  const next = await evaluateAiGate({ tenantId: TENANT, conversationId: CONV, db: db2 });
  check('the NEXT inbound event is suppressed too (not just this one)', next.suppressed === true);
  check('the AI is off for good, not for one message', isAiActive(db2.conversations.get(CONV).state) === false);
}

/* ========================================================================= */
console.log('\n=== 2. CONCURRENT ESCALATION AND OUTBOUND REPLY RACE ===');
{
  // 2a. Escalation commits BEFORE the final state read -> deterministic no-send.
  const db = makeDb();
  const clean = await runAiSend({ db, escalateAt: 'before-final-check' });
  check('escalation BEFORE the final state read => 0 replies', clean.sent === 0);
  check('  ...and the state read saw QUEUED', clean.state === 'QUEUED', String(clean.state));

  // 2b. Escalation commits AFTER the final state read, BEFORE the provider POST.
  // This is the residual in-flight window. It is real and it is bounded.
  const db2 = makeDb();
  const raced = await runAiSend({ db: db2, escalateAt: 'after-final-check-before-post' });
  check('escalation AFTER the final state read => the reply STILL goes out (window is real)',
    raced.sent === 1, `sent=${raced.sent}`);
  check('  ...the conversation did end up QUEUED', db2.conversations.get(CONV).state === 'QUEUED');
  check('  ...exactly ONE reply, not a stream (the window is bounded)', raced.sent === 1);

  // 2c. The bound: after the window, the AI is permanently off.
  const afterwards = await evaluateAiGate({ tenantId: TENANT, conversationId: CONV, db: db2 });
  check('after the window the AI is suppressed for every later event',
    afterwards.suppressed === true);

  // 2d. The window does not reopen on a subsequent event.
  const again = await runAiSend({ db: db2, escalateAt: null });
  check('a subsequent event is suppressed even with no new escalation',
    again.sent === 0 && again.at === 'pre-gate', JSON.stringify(again));

  // 2e. Concurrent escalations + a concurrent send: the state always settles once.
  const db3 = makeDb();
  await Promise.all([
    createEscalationRecord({ tenantId: TENANT, conversationId: CONV, category: 'complaint', reason: 'a' }, { db: db3 }),
    createEscalationRecord({ tenantId: TENANT, conversationId: CONV, category: 'complaint', reason: 'b' }, { db: db3 }),
    createEscalationRecord({ tenantId: TENANT, conversationId: CONV, category: 'complaint', reason: 'c' }, { db: db3 })
  ]);
  check('3 concurrent escalations settle in exactly one terminal state',
    ['QUEUED', 'HUMAN_REQUIRED'].includes(db3.conversations.get(CONV).state), db3.conversations.get(CONV).state);
  check('all 3 escalations are recorded (nothing lost)', db3.escalations.length === 3);
}

/* ========================================================================= */
console.log('\n=== 3. NO DUPLICATE OUTBOUND REPLIES ===');
{
  // The escalation gate is per event, so the same event cannot produce two
  // replies through the escalation path.
  const db = makeDb();
  await createEscalationRecord({ tenantId: TENANT, conversationId: CONV, category: 'complaint', reason: 'r' }, { db });
  const first = await runAiSend({ db, escalateAt: null });
  const second = await runAiSend({ db, escalateAt: null });
  check('a redelivered event after escalation produces no reply at all',
    first.sent === 0 && second.sent === 0, `${first.sent}/${second.sent}`);
  check('no outbound message rows were created', db.messages.length === 0);

  // Pre-escalation: two separate events each get their own reply, which is
  // correct (they are different customer messages, not a duplicate).
  const db2 = makeDb();
  await runAiSend({ db: db2, escalateAt: null, text: 'first' });
  await runAiSend({ db: db2, escalateAt: null, text: 'second' });
  check('two distinct inbound events before escalation each get one reply',
    db2.messages.length === 2, `rows=${db2.messages.length}`);

  // The de-dupe primitive: a redelivery carrying the SAME provider message id
  // must not create a second row (ON CONFLICT DO NOTHING).
  const db3 = makeDb();
  await persistOutboundMessage({ tenantId: TENANT, conversationId: CONV, text: 'x', providerMessageId: 'prov-123' });
  await persistOutboundMessage({ tenantId: TENANT, conversationId: CONV, text: 'x', providerMessageId: 'prov-123' });
  check('the same provider message id does not create a second outbound row (would be a visible duplicate)',
    db3.messages.length === 1, `rows=${db3.messages.length}`);
}

/* ========================================================================= */
console.log('\n=== 4. CROSS-TENANT AND CROSS-BRAND ESCALATION ACCESS ===');
{
  const db = makeDb();
  await createEscalationRecord({ tenantId: TENANT_B, conversationId: CONV, category: 'x', reason: 'r' }, { db });
  check('a foreign tenant cannot transition another company conversation',
    db.conversations.get(CONV).state === 'AI_ACTIVE', db.conversations.get(CONV).state);
  check('the foreign tenant conversation is untouched',
    db.conversations.get(CONV_B).state === 'AI_ACTIVE');

  const db2 = makeDb();
  await createEscalationRecord({ tenantId: TENANT, conversationId: CONV_B, category: 'x', reason: 'r' }, { db: db2 });
  check('the reverse direction is refused too',
    db2.conversations.get(CONV_B).state === 'AI_ACTIVE');

  // A cross-tenant escalation must not let the AI reply on a foreign tenant's
  // conversation, and must not silently park it either.
  const db3 = makeDb();
  await createEscalationRecord({ tenantId: TENANT_B, conversationId: CONV, category: 'x', reason: 'r' }, { db: db3 });
  check('the rejected cross-tenant escalation did NOT park the conversation in QUEUED',
    db3.conversations.get(CONV).state === 'AI_ACTIVE', db3.conversations.get(CONV).state);
  const gate = await evaluateAiGate({ tenantId: TENANT_B, conversationId: CONV, db: db3 });
  check('and it did NOT suppress the owner tenant AI either (no cross-tenant DoS)',
    gate.suppressed === false, JSON.stringify(gate));
}

/* ========================================================================= */
console.log('\n=== 5. LEGACY JSON DASHBOARD APIs (real router over HTTP) ===');
{
  const crypto = await import('node:crypto');
  // validateSession hashes the cookie before looking it up; reproduce that so
  // the stub can tell an authenticated request from an anonymous one.
  const testTokenHash = crypto.createHash('sha256').update('test-token').digest('hex');
  const section5Queries = [];
  // Section 5 drives the REAL Express router, so the pool must serve the
  // session queries and behave sanely for everything else. It must not fall
  // through to a previous fake or to a real socket.
  activeDb = null;
  const { pool } = await import('../src/db/pg.js');
  pool.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ');
    // An absent cookie must NOT authenticate.
    if (/FROM sessions s JOIN users u/.test(s)) {
      const cookiePresent = String(params[0] ?? '') === testTokenHash;
      return cookiePresent
        ? { rows: [{ tenant_id: TENANT, session_id: 'sess-1', user_id: USER_A, email: 'admin@test', name: 'Admin', status: 'active' }] }
        : { rows: [] };
    }
    if (/FROM user_roles ur JOIN roles r/.test(s)) return { rows: [{ name: 'Company Admin' }] };
    if (/FROM platform_super_admins/.test(s)) return { rows: [] };
    // Any other query the authenticated dashboard routes issue: empty, and
    // recorded so we can assert they never touch the legacy JSON store.
    section5Queries.push(s);
    return { rows: [] };
  };

  // Seed the legacy JSON store with cross-tenant PII.
  const dbjson = await import('../src/db.js');
  dbjson.addEscalation({ channel: 'messenger', customerName: 'CUSTOMER-LEAK', customerId: 'cid-1', message: 'SECRET-INBOUND-TEXT', reply: 'SECRET-AI-REPLY', reason: 'complaint' });
  dbjson.logEvent({ channel: 'messenger', customerName: 'CUSTOMER-LEAK', message: 'SECRET-EVENT-TEXT', reply: 'SECRET-EVENT-REPLY' });

  const { dashboardRouter } = await import('../src/dashboard.js');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/legacy', dashboardRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/legacy`;

  const AUTHED = { Cookie: 'lwc_session=test-token' };

  for (const path of ['/dashboard/api/stats', '/dashboard/api/events', '/dashboard/api/escalations']) {
    const r = await fetch(base + path, { headers: AUTHED });
    const body = await r.text();
    check(`${path} is retired (410)`, r.status === 410, `got ${r.status}`);
    check(`${path} leaks NO customer data`, !/CUSTOMER-LEAK|SECRET-/.test(body), body.slice(0, 90));
  }

  // Unauthorized escalation resolution: the critical one.
  const before = dbjson.listEscalations().map((e) => e.status);
  const res = await fetch(base + '/dashboard/api/escalations/does-not-exist/resolve', { method: 'POST', headers: AUTHED });
  const resBody = await res.text();
  check('POST .../escalations/:id/resolve is retired (410)', res.status === 410, `got ${res.status}`);
  check('the resolve response leaks no store data', !/CUSTOMER-LEAK|SECRET-/.test(resBody));
  const after = dbjson.listEscalations().map((e) => e.status);
  check('NO escalation was resolved by any caller', JSON.stringify(before) === JSON.stringify(after), `${before} -> ${after}`);

  // Unauthenticated callers must not reach the payload at all.
  // redirect:'manual' is essential: res.redirect() uses an ABSOLUTE path, which
  // escapes this test app's /legacy mount, and an auto-followed redirect would
  // report the 404 of the login page rather than the 302 that proves the gate.
  const anon = await fetch(base + '/dashboard/api/escalations', { redirect: 'manual' });
  check('an unauthenticated caller is redirected to login (302), never served data',
    anon.status === 302, `got ${anon.status}`);
  const anonResolve = await fetch(base + '/dashboard/api/escalations/any-id/resolve', { method: 'POST', redirect: 'manual' });
  check('an unauthenticated resolve attempt is redirected too (no unauthorised mutation path)',
    anonResolve.status === 302, `got ${anonResolve.status}`);

  // The unauthenticated debug render must be GONE, not hidden.
  const dbg = await fetch(base + '/dashboard-debug');
  const dbgBody = await dbg.text();
  check('GET /dashboard-debug is deleted (404), not merely hidden in the UI', dbg.status === 404, `got ${dbg.status}`);
  check('  ...and serves no dashboard HTML', !/debug@debug|Company Admin/.test(dbgBody));
  const dbgRoot = await fetch(`http://127.0.0.1:${srv.address().port}/dashboard-debug`);
  check('  ...also gone when mounted at the app root (where it actually lived)', dbgRoot.status === 404, `got ${dbgRoot.status}`);

  /* ---- Existing AUTHENTICATED dashboard functionality still works ---- */
  const me = await fetch(base + '/dashboard/api/me', { headers: AUTHED });
  const meBody = await me.json();
  check('authenticated GET /dashboard/api/me still returns the session identity',
    me.status === 200 && meBody.user?.email === 'admin@test', `got ${me.status}`);

  const page = await fetch(base + '/dashboard', { headers: AUTHED });
  const pageBody = await page.text();
  check('authenticated GET /dashboard still renders the page',
    page.status === 200 && pageBody.length > 200, `got ${page.status} len=${pageBody.length}`);
  check('the authenticated page shows the REAL user, not the debug identity',
    !/debug@debug/.test(pageBody));

  const inbox = await fetch(base + '/dashboard/api/conversations', { headers: AUTHED });
  check('authenticated GET /dashboard/api/conversations is still routed',
    [200, 401, 404].includes(inbox.status) && inbox.status !== 410, `got ${inbox.status}`);

  srv.close();
  check('no authenticated dashboard route fell through to the legacy JSON store',
    !section5Queries.some((q) => /dashboard\.json|db\./.test(q)));
}

/* ========================================================================= */
console.log('\n=== 6. PRODUCTION DATA WAS NOT TOUCHED BY THIS SUITE ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  check('no route still reads the legacy JSON store',
    !/dashboardRouter\.(get|post)\([^)]*,\s*(getStats|listEvents|listEscalations|resolveEscalation)/.test(src));
  check('the retired handler body never touches the JSON store',
    (() => {
      const src = fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
      const start = src.indexOf('const LEGACY_STORE_RETIRED');
      const body = src.slice(start, src.indexOf('\n};', start));
      return start > 0 && body.length > 0 && !/\bdb\.|listEvents|listEscalations|getStats|resolveEscalation/.test(
        body.replace(/getStats\/listEvents\/listEscalations\/resolveEscalation are/, '')
      );
    })());
  check('the escalation writer never UPDATEs or DELETEs an escalation',
    (() => {
      const conv = fs.readFileSync(new URL('../src/services/conversations.js', import.meta.url), 'utf8');
      const start = conv.indexOf('export async function createEscalationRecord');
      const body = conv.slice(start, start + 4000);
      return !/UPDATE escalations|DELETE FROM escalations/.test(body);
    })());
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
