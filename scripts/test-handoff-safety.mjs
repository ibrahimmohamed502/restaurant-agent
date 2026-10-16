/**
 * Critical handoff safety — regression tests for the second escalation writer.
 *
 *   node scripts/test-handoff-safety.mjs
 *
 * Defect: src/services/conversations.js `createEscalationRecord()` inserted an
 * escalations row but left the conversation in AI_ACTIVE. Because the AI gate
 * suppresses replies unless state === 'AI_ACTIVE', the AI kept answering a
 * conversation already flagged for human handling.
 *
 * These tests pin the fixed behaviour: the transition is atomic with the
 * insert, concurrent and repeated calls are no-ops rather than errors, a human's
 * in-progress work is never clobbered, existing escalation rows are never
 * touched, and the existing AI gate really does suppress afterwards.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

const T = '00000000-0000-0000-0000-0000000000a1';
const T2 = '00000000-0000-0000-0000-0000000000a2';
const C = '00000000-0000-0000-0000-0000000000c1';
const C_OTHER = '00000000-0000-0000-0000-0000000000c2';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  OK   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

/* ---------------------------------------------------------------------------
 * Fake database. `db` holds the rows; `client` records the statements so the
 * test can assert on atomicity, ordering and what was NOT touched.
 * ------------------------------------------------------------------------- */
function makeDb({ state = 'AI_ACTIVE', tenantId = T } = {}) {
  const db = {
    conversations: new Map([[C, { id: C, tenant_id: tenantId, state }]]),
    escalations: [],
    log: [],
    failOnInsert: false,
    commits: 0,
    rollbacks: 0
  };
  // A second conversation in another tenant, used to prove tenant isolation.
  db.conversations.set(C_OTHER, { id: C_OTHER, tenant_id: T2, state: 'AI_ACTIVE' });

  async function exec(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    db.log.push({ sql: s, params });

    // A real ROLLBACK discards uncommitted work. The fake must honour that,
    // otherwise the "no stranded state" assertion would be meaningless.
    if (s === 'BEGIN') {
      db.snapshot = {
        conversations: new Map([...db.conversations].map(([k, v]) => [k, { ...v }])),
        escalations: [...db.escalations]
      };
      return { rows: [] };
    }
    if (s === 'COMMIT') { db.commits++; db.snapshot = null; return { rows: [] }; }
    if (s === 'ROLLBACK') {
      db.rollbacks++;
      if (db.snapshot) {
        db.conversations = db.snapshot.conversations;
        db.escalations = db.snapshot.escalations;
        db.snapshot = null;
      }
      return { rows: [] };
    }

    // UPDATE conversations SET state = '<to>' WHERE id = $2 AND tenant_id = $1 AND state = '<from>'
    let m = s.match(/UPDATE conversations SET state = '(\w+)' WHERE id = \$2 AND tenant_id = \$1 AND state = '(\w+)'/);
    if (m) {
      const [, to, from] = m;
      const row = db.conversations.get(params[1]);
      if (!row || row.tenant_id !== params[0] || row.state !== from) return { rows: [], rowCount: 0 };
      row.state = to;
      return { rows: [], rowCount: 1 };
    }

    // getConversationState() reads the conversation back through the same handle.
    m = s.match(/SELECT id, state FROM conversations WHERE id = \$1 AND tenant_id = \$2/);
    if (m) {
      const row = db.conversations.get(params[0]);
      if (!row || row.tenant_id !== params[1]) return { rows: [] };
      return { rows: [{ id: row.id, state: row.state }] };
    }

    if (/INSERT INTO escalations/.test(s)) {
      if (db.failOnInsert) throw new Error('simulated insert failure');
      const row = {
        id: 'esc-' + (db.escalations.length + 1),
        tenant_id: params[0], conversation_id: params[1],
        category: params[2], reason: params[3], summary: params[4], priority: params[5],
        status: 'new', resolved_at: null
      };
      db.escalations.push(row);
      return { rows: [{ id: row.id, created_at: 'now' }] };
    }

    throw new Error('unexpected SQL: ' + s.slice(0, 90));
  }

  db.connect = async () => ({ query: exec, release() {} });
  db.query = exec;
  return db;
}

const { createEscalationRecord } = await import('../src/services/conversations.js');
const { isAiActive, getConversationState, CONVERSATION_STATES } = await import('../src/services/handoff.js');
const { evaluateAiGate } = await import('../src/services/aiGate.js');

console.log('\n=== 1. THE DEFECT: an escalation must stop the AI ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  check('conversation starts AI_ACTIVE', db.conversations.get(C).state === 'AI_ACTIVE');

  const out = await createEscalationRecord(
    { tenantId: T, conversationId: C, category: 'complaint', reason: 'customer complaint', summary: 'angry' },
    { db }
  );

  const state = db.conversations.get(C).state;
  check('R1 FIX: the conversation is NO LONGER AI_ACTIVE after an escalation',
    state !== 'AI_ACTIVE', `state=${state}`);
  check('R1 FIX: it lands in QUEUED (same target as requestHandoff)', state === CONVERSATION_STATES.QUEUED, `state=${state}`);
  check('isAiActive() is now false, so the AI gate will suppress',
    isAiActive(state) === false);
  check('the escalation row was recorded', db.escalations.length === 1);
  check('the escalation carries the caller-supplied category', db.escalations[0].category === 'complaint');
  check('the escalation starts open (status new, resolved_at null)',
    db.escalations[0].status === 'new' && db.escalations[0].resolved_at === null);
  check('the call reports success', out.recorded === true && !!out.id);
}

console.log('\n=== 2. ATOMICITY: transition + insert share one transaction ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'r' }, { db });

  const sqls = db.log.map((l) => l.sql);
  const iBegin = sqls.indexOf('BEGIN');
  const iHuman = sqls.findIndex((s) => s.includes("SET state = 'HUMAN_REQUIRED'"));
  const iQueued = sqls.findIndex((s) => s.includes("SET state = 'QUEUED'"));
  const iInsert = sqls.findIndex((s) => s.includes('INSERT INTO escalations'));
  const iCommit = sqls.indexOf('COMMIT');

  check('everything is inside one BEGIN', iBegin === 0);
  check('the state leaves AI_ACTIVE BEFORE the escalation is inserted',
    iHuman > iBegin && iHuman < iInsert, `human=${iHuman} insert=${iInsert}`);
  check('both hops complete before the insert', iQueued > iHuman && iQueued < iInsert);
  check('the insert precedes COMMIT', iInsert > iQueued && iInsert < iCommit);
  check('exactly one COMMIT', db.commits === 1);
  check('no ROLLBACK on the happy path', db.rollbacks === 0);
}

console.log('\n=== 3. FAILURE ROLLS BACK — no half-applied state ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  db.failOnInsert = true;
  let threw = null;
  try {
    await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'r' }, { db });
  } catch (e) { threw = e; }
  check('the failure propagates to the caller', threw !== null);
  check('the transaction is rolled back', db.rollbacks === 1);
  check('R1 FIX: a failed escalation leaves the conversation AI_ACTIVE (no stranded state)',
    db.conversations.get(C).state === 'AI_ACTIVE', db.conversations.get(C).state);
  check('no escalation row was persisted', db.escalations.length === 0);
  check('nothing was committed', db.commits === 0);
}

console.log('\n=== 4. IDEMPOTENT: repeated calls are no-ops, not errors ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'r1' }, { db });
  const afterFirst = db.conversations.get(C).state;

  // Same conversation again (a second inbound message also flagged).
  await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'r2' }, { db });

  check('a second call does not throw', true);
  check('the state is stable at QUEUED', db.conversations.get(C).state === afterFirst, db.conversations.get(C).state);
  check('the second call records its own escalation (history preserved)',
    db.escalations.length === 2);
  check('R1: the first escalation is NOT modified or closed',
    db.escalations[0].reason === 'r1' && db.escalations[0].status === 'new' && db.escalations[0].resolved_at === null);
}

console.log('\n=== 5. CONCURRENCY: only one caller transitions ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  // Three simultaneous escalations for the same conversation.
  await Promise.all([
    createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'a' }, { db }),
    createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'b' }, { db }),
    createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'c' }, { db })
  ]);
  check('the conversation settles in exactly one state: QUEUED',
    db.conversations.get(C).state === 'QUEUED', db.conversations.get(C).state);
  check('no caller observed or caused an illegal state',
    ['AI_ACTIVE', 'QUEUED'].includes(db.conversations.get(C).state));
  check('all three escalations are recorded (nothing is lost)',
    db.escalations.length === 3);
}

console.log('\n=== 6. A HUMAN IN PROGRESS IS NEVER CLOBBERED ===');
for (const [label, start] of [
  ['HUMAN_ACTIVE', 'HUMAN_ACTIVE'],
  ['ASSIGNED', 'ASSIGNED'],
  ['RESOLVED', 'RESOLVED']
]) {
  const db = makeDb({ state: start });
  await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'r' }, { db });
  check(`a ${label} conversation is left in ${label} (not reset to QUEUED)`,
    db.conversations.get(C).state === start, `got ${db.conversations.get(C).state}`);
  check(`the escalation is still recorded while the ${label} state stands`, db.escalations.length === 1);
}

console.log('\n=== 7. EXISTING ESCALATIONS ARE NEVER MUTATED ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  // Pre-existing open escalation from an earlier event.
  const pre = {
    id: 'esc-existing', tenant_id: T, conversation_id: C,
    category: 'reservation', reason: 'original reason', summary: 'orig',
    priority: 'high', status: 'in_progress', resolved_at: null
  };
  db.escalations.push(pre);

  await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'new reason' }, { db });

  check('the pre-existing escalation is unchanged (category, reason, priority, status)',
    pre.category === 'reservation' && pre.reason === 'original reason'
    && pre.priority === 'high' && pre.status === 'in_progress', JSON.stringify(pre));
  check('the pre-existing escalation was not resolved', pre.resolved_at === null);
  check('a new row was added alongside it, not in place of it', db.escalations.length === 2);
  check('the writer issued no UPDATE or DELETE against escalations',
    !db.log.some((l) => /UPDATE escalations|DELETE FROM escalations/.test(l.sql)));
}

console.log('\n=== 8. TENANT ISOLATION ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });
  // Another tenant targets a conversation it does not own.
  await createEscalationRecord({ tenantId: T, conversationId: C_OTHER, category: 'x', reason: 'r' }, { db });
  check('a foreign tenant cannot transition another company conversation',
    db.conversations.get(C_OTHER).state === 'AI_ACTIVE', db.conversations.get(C_OTHER).state);
  check('the foreign escalation row is still attributed to the caller-supplied tenant',
    db.escalations[0].tenant_id === T);

  const db2 = makeDb({ state: 'AI_ACTIVE' });
  await createEscalationRecord({ tenantId: T2, conversationId: C, category: 'x', reason: 'r' }, { db: db2 });
  check('the reverse direction is refused too',
    db2.conversations.get(C).state === 'AI_ACTIVE', db2.conversations.get(C).state);
}

console.log('\n=== 9. MISSING CONTEXT FAILS SAFE ===');
{
  const db = makeDb();
  const a = await createEscalationRecord({ conversationId: C, category: 'x', reason: 'r' }, { db });
  check('no tenantId -> refused, nothing written', a.recorded === false && db.escalations.length === 0);
  const b = await createEscalationRecord({ tenantId: T, category: 'x', reason: 'r' }, { db });
  check('no conversationId -> refused, nothing written', b.recorded === false && db.escalations.length === 0);
  check('no statement was executed at all', db.log.length === 0);
}

console.log('\n=== 10. THE AI GATE REALLY DOES SUPPRESS AFTERWARDS ===');
{
  const db = makeDb({ state: 'AI_ACTIVE' });

  const before = await evaluateAiGate({ tenantId: T, conversationId: C, db });
  check('before: the AI is allowed (state AI_ACTIVE)', before.suppressed === false, JSON.stringify(before));

  await createEscalationRecord({ tenantId: T, conversationId: C, category: 'complaint', reason: 'r' }, { db });

  const after = await evaluateAiGate({ tenantId: T, conversationId: C, db });
  check('after: the AI is SUPPRESSED', after.suppressed === true, JSON.stringify(after));
  check('after: the gate reports the QUEUED state', after.state === 'QUEUED', String(after.state));

  // Re-evaluated on every event, so the next inbound message is blocked too.
  const next = await evaluateAiGate({ tenantId: T, conversationId: C, db });
  check('the suppression persists on the next event (state is re-read, not cached)',
    next.suppressed === true);
}

console.log('\n=== 11. BOTH WRITERS LAND IN THE SAME STATE ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/services/conversations.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function createEscalationRecord'));
  const scoped = body.slice(0, body.indexOf('\n}\n'));

  check('it transitions through HUMAN_REQUIRED like requestHandoff does',
    /SET state = 'HUMAN_REQUIRED'/.test(scoped) && /SET state = 'QUEUED'/.test(scoped));
  check('every transition is state-guarded (the database is the concurrency lock)',
    (scoped.match(/AND state = '\w+'/g) || []).length >= 2);
  check('it runs inside an explicit transaction', /BEGIN/.test(scoped) && /COMMIT/.test(scoped) && /ROLLBACK/.test(scoped));
  check('it refuses to run without tenant + conversation context',
    /if \(!tenantId \|\| !conversationId\)/.test(scoped));
  check('it does not bypass the pool with a bare pool.query (it uses deps.db)',
    /deps\.db \?\? pool/.test(scoped));
  check('unrelated AI behaviour is untouched: no import of the agent/analyze path',
    !/analyzeAndDraft|aiAgent/.test(scoped));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
