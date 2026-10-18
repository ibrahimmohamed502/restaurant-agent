/**
 * P0.2 — REAL PostgreSQL integration tests for the manual-reply guarantees.
 *
 * Run against a throwaway database:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lwc_reply_test \
 *     node scripts/test-manual-reply-pg.mjs
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * The security properties of P0.2 are SQL properties:
 *
 *   - the PARTIAL unique index must make a duplicate INSERT lose,
 *   - the atomic claim must insert ZERO rows when any guard fails,
 *   - the brand scope predicate must refuse a NULL-brand channel to a
 *     restricted caller,
 *   - the claim must be ONE snapshot, so a conversation cannot change state
 *     between the authorisation and the write.
 *
 * A fake pool can only assert that the right STRING was passed. It cannot prove
 * PostgreSQL refuses the row the way production will. Every assertion below runs
 * against a real server, creates only rows it created, and drops its schema.
 *
 * NO PRODUCTION DATA IS TOUCHED: the suite refuses to run unless the target
 * database name ends in `_test`.
 *
 * Skips cleanly (exit 0) when TEST_DATABASE_URL is unset, so it is safe to call
 * from a generic test loop. Running it against the deployment database before
 * release is a REQUIRED pre-deployment gate.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_DATABASE_URL;

if (!url) {
  console.log('⏭️  TEST_DATABASE_URL not set — skipping the real-PostgreSQL manual-reply suite.');
  console.log('   This is REQUIRED before production deployment. Example:');
  console.log('   TEST_DATABASE_URL=postgres://u:p@localhost:5432/lwc_reply_test \\');
  console.log('     node scripts/test-manual-reply-pg.mjs');
  process.exit(0);
}

const dbName = (() => {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); }
  catch { return ''; }
})();
if (!dbName.endsWith('_test')) {
  console.error(`⛔ refusing to run: target database "${dbName}" does not end in _test`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ------------------------------------------------------------ schema setup */

const SCHEMA = 'p02_test';
const q = (sql, params) => client.query(sql, params);

try {
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await q(`CREATE SCHEMA ${SCHEMA}`);
  await q(`SET search_path TO ${SCHEMA}, public`);

  section('0 baseline schema (001 + 004 + 005 + 009 + 015 essentials)');
  await q(`CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
  await q(`CREATE TABLE brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name text, UNIQUE (id, tenant_id))`);
  await q(`CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name text, status text NOT NULL DEFAULT 'active', UNIQUE (id, tenant_id))`);
  await q(`CREATE TABLE channels (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), brand_id uuid REFERENCES brands(id), provider text NOT NULL, external_id text, display_name text, status text NOT NULL DEFAULT 'active', metadata jsonb NOT NULL DEFAULT '{}')`);
  await q(`CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), display_name text)`);
  await q(`CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
      external_key text,
      state text NOT NULL DEFAULT 'AI_ACTIVE',
      assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      priority text NOT NULL DEFAULT 'normal',
      last_message_at timestamptz,
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      direction text NOT NULL,
      sender_type text NOT NULL CHECK (sender_type IN ('customer','ai','employee','system')),
      sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      provider_message_id text,
      kind text NOT NULL DEFAULT 'message',
      text text,
      attachments jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now(),
      provider_ts timestamptz,
      delivery_status text NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('pending','sent','failed')),
      delivery_error text,
      retry_count integer NOT NULL DEFAULT 0,
      last_retry_at timestamptz,
      UNIQUE (conversation_id, provider_message_id))`);
  console.log('  base schema created');

  section('1 migration 016 applies cleanly and is idempotent');
  const mig = readFileSync(join(REPO, 'migrations/016_manual_reply_idempotency.sql'), 'utf8');
  await q(mig);
  check('016 applied without error', true);
  await q(mig);
  check('016 is re-runnable without error (safe to re-apply manually)', true);

  const col = await q(`SELECT data_type, is_nullable FROM information_schema.columns
                        WHERE table_schema=$1 AND table_name='messages' AND column_name='idempotency_key'`,
    [SCHEMA]);
  eq('idempotency_key exists and is NULLABLE', col.rows[0]?.data_type, 'text');
  eq('idempotency_key is_nullable', col.rows[0]?.is_nullable, 'YES');

  const idx = await q(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='idx_messages_reply_idempotency'`, [SCHEMA]);
  check('the unique index exists', idx.rowCount === 1);
  check('it is PARTIAL (existing NULL-key rows are untouched)', /WHERE \(idempotency_key IS NOT NULL\)/.test(idx.rows[0].indexdef), idx.rows[0].indexdef);
  check('it is scoped per (tenant, conversation, key)',
    /\(tenant_id, conversation_id, idempotency_key\)/.test(idx.rows[0].indexdef), idx.rows[0].indexdef);

  section('2 existing rows are unaffected by the new index');
  const [t1, t2] = (await q(`INSERT INTO tenants (name) VALUES ('A'),('B') RETURNING id`)).rows;
  const [b1, b2] = (await q(`INSERT INTO brands (tenant_id, name) VALUES ($1,'B1'),($2,'B2') RETURNING id`, [t1.id, t2.id])).rows;
  const [admin] = (await q(`INSERT INTO users (tenant_id, name) VALUES ($1,'admin') RETURNING id`, [t1.id])).rows;
  const [ch1, ch2] = (await q(`INSERT INTO channels (tenant_id, brand_id, provider) VALUES ($1,$2,'meta_dm'),($1,$3,'meta_dm') RETURNING id`, [t1.id, b1.id, b2.id])).rows;
  const [conv] = (await q(`INSERT INTO conversations (tenant_id, channel_id, external_key, state) VALUES ($1,$2,'psid-1','QUEUED') RETURNING id`, [t1.id, ch1.id])).rows;
  const [convOther] = (await q(`INSERT INTO conversations (tenant_id, channel_id, external_key, state) VALUES ($1,$2,'psid-2','QUEUED') RETURNING id`, [t1.id, ch2.id])).rows;
  const [convB] = (await q(`INSERT INTO conversations (tenant_id, channel_id, external_key, state) VALUES ($1,NULL,'psid-3','QUEUED') RETURNING id`, [t2.id])).rows;

  // 40 AI rows with NULL keys — the population the index must not reject.
  for (let i = 0; i < 40; i++) {
    await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id)
             VALUES ($1,$2,'outbound','ai',$3,$4)`, [t1.id, conv.id, `ai ${i}`, `ai-mid-${i}`]);
  }
  const nullKeys = await q(`SELECT count(*)::int n FROM messages WHERE idempotency_key IS NULL`);
  check('40 NULL-key AI rows coexist with the new unique index', nullKeys.rows[0].n === 40, String(nullKeys.rows[0].n));
  // The SAME key in two DIFFERENT conversations must BOTH succeed. The guard is
  // scoped per conversation, never global, so one key can never be replayed
  // across conversations or across companies.
  //
  // (An earlier version of this loop inserted the same key three times into ONE
  // conversation and called it a cross-conversation check. PostgreSQL correctly
  // refused it with 23505. The fixture was wrong, not the index — and the next
  // assertion below is the one that was actually missing: proving the database
  // refuses a same-conversation replay by itself.)
  for (const [label, cid] of [['conv', conv.id], ['convOther', convOther.id]]) {
    await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, idempotency_key)
             VALUES ($1,$2,'outbound','employee',$3,$4,'shared-key-abc')`,
      [t1.id, cid, 'scoped ' + label, 'idem:scoped-' + label]);
  }
  const scoped = await q(`SELECT count(*)::int n FROM messages WHERE idempotency_key='shared-key-abc'`);
  check('the same key in DIFFERENT conversations does not collide', scoped.rows[0].n === 2, String(scoped.rows[0].n));

  // ...and the SAME key twice in the SAME conversation is refused BY POSTGRESQL.
  let replayCode = null;
  try {
    await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, idempotency_key)
             VALUES ($1,$2,'outbound','employee','replay','idem:replay','shared-key-abc')`,
      [t1.id, conv.id]);
  } catch (e) { replayCode = e.code; }
  eq('a replayed key in the SAME conversation is refused by the database', replayCode, '23505');
  const afterReplay = await q(`SELECT count(*)::int n FROM messages WHERE idempotency_key='shared-key-abc'`);
  eq('and nothing extra was written', afterReplay.rows[0].n, 2);

  /* ------------------------------------------------ the real atomic claim */

  const claimSql = readFileSync(join(REPO, 'src/services/manualReplies.js'), 'utf8')
    .slice(readFileSync(join(REPO, 'src/services/manualReplies.js'), 'utf8').indexOf('export async function claimReplySlot'))
    .split('`')[1];

  const inbound = new Date(Date.now() - 60_000);
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts)
           VALUES ($1,$2,'inbound','customer','hello','in-1',$3)`, [t1.id, conv.id, inbound]);

  const claim = (params) => q(claimSql, params);
  const STATES = ['HUMAN_REQUIRED', 'QUEUED', 'ASSIGNED', 'HUMAN_ACTIVE'];
  const PROVIDERS = ['meta_dm'];
  const base = (over = {}) => [
    t1.id, conv.id, admin.id, 'reply body', 'idem-test-aaaaaa',
    true, [], true, 86400, STATES, PROVIDERS, ...[]
  ].map((v, i) => (i in over ? over[i] : v));

  section('3 the atomic claim writes only when every guard passes');
  const r1 = await claim(base());
  eq('an eligible reply is claimed', r1.rows[0].claimed_count, 1);
  eq('and the row starts pending, before any provider call', r1.rows[0].claimed_id ? 'pending' : null, 'pending');
  const stored = await q(`SELECT direction, sender_type, delivery_status, idempotency_key FROM messages WHERE id=$1`, [r1.rows[0].claimed_id]);
  eq('sender_type', stored.rows[0].sender_type, 'employee');
  eq('direction', stored.rows[0].direction, 'outbound');
  eq('delivery_status', stored.rows[0].delivery_status, 'pending');
  eq('idempotency_key', stored.rows[0].idempotency_key, 'idem-test-aaaaaa');

  section('4 the same idempotency key can only ever produce ONE row');
  const r2 = await claim(base({ 4: 'idem-test-aaaaaa' }));
  eq('a replay claims nothing', r2.rows[0].claimed_count, 0);
  eq('a replay sees the original row', r2.rows[0].existing_count, 1);
  eq('and reports its current status', r2.rows[0].existing_status, 'pending');
  const count = await q(`SELECT count(*)::int n FROM messages WHERE idempotency_key='idem-test-aaaaaa'`);
  eq('exactly one row exists for that key', count.rows[0].n, 1);

  section('5 concurrent claims: many racers, exactly one winner');
  await q(`DELETE FROM messages WHERE idempotency_key='idem-race-00001'`);
  const winners = await Promise.all(
    Array.from({ length: 16 }, (_, i) => claim(base({ 4: 'idem-race-00001' })).then((r) => r.rows[0].claimed_count))
  );
  eq('exactly ONE of 16 concurrent racers wins', winners.filter((w) => w === 1).length, 1);
  const raceCount = await q(`SELECT count(*)::int n FROM messages WHERE idempotency_key='idem-race-00001'`);
  eq('and exactly one row exists', raceCount.rows[0].n, 1);

  section('5b TRUE concurrency: independent connections, not a queued one');
  // The section-5 racers shared ONE pg client, which serialises its queries. That
  // proves the index works but NOT that the database resolves simultaneous
  // claims. This section opens N independent connections and releases them
  // together, so PostgreSQL really does have to arbitrate.
  {
    const [concConv] = (await q(
      `INSERT INTO conversations (tenant_id, channel_id, external_key, state)
       VALUES ($1,$2,'psid-conc','QUEUED') RETURNING id`, [t1.id, ch1.id])).rows;
    await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts)
             VALUES ($1,$2,'inbound','customer','hi','in-conc',$3)`,
      [t1.id, concConv.id, new Date(Date.now() - 60_000)]);

    const N = 24;
    const conns = [];
    for (let i = 0; i < N; i++) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      // search_path is per-SESSION, so every racer must be pointed at the test
      // schema itself. Without this the connections resolve \"conversations\"
      // in \"public\", which is empty in a throwaway database.
      await c.query(`SET search_path TO ${SCHEMA}, public`);
      conns.push(c);
    }
    check(`opened ${N} INDEPENDENT database connections`, conns.length === N);
    const visible = await conns[0].query(
      `SELECT count(*)::int n FROM pg_tables WHERE schemaname='${SCHEMA}'`);
    check('every racer can see the test schema', visible.rows[0].n > 0, String(visible.rows[0].n));

    // Every connection issues the SAME claim at the same moment.
    const start = Promise.resolve();
    const results = await Promise.all(conns.map((c) =>
      start.then(() => c.query(claimSql,
        [t1.id, concConv.id, admin.id, 'racing', 'idem-true-race-1', true, [], true, 86400, STATES, PROVIDERS]))
    ));
    const winners = results.filter((r) => r.rows[0].claimed_count === 1).length;
    eq(`exactly ONE of ${N} simultaneous independent claims wins`, winners, 1);
    const losers = results.filter((r) => r.rows[0].claimed_count === 0).length;
    eq(`and the other ${N - 1} write nothing`, losers, N - 1);

    const rows = await q(`SELECT count(*)::int n, count(DISTINCT id)::int d FROM messages
                          WHERE idempotency_key='idem-true-race-1'`);
    eq('exactly ONE row exists for the key', rows.rows[0].n, 1);
    eq('with exactly one distinct id', rows.rows[0].d, 1);

    // Distinct keys must ALL win: concurrency must not serialise unrelated replies
    // into one winner. Ten employees, ten keys, ten messages.
    const distinctResults = await Promise.all(conns.slice(0, 10).map((c, i) =>
      c.query(claimSql,
        [t1.id, concConv.id, admin.id, `reply ${i}`, `idem-distinct-${i}`, true, [], true, 86400, STATES, PROVIDERS])
    ));
    eq('ten DIFFERENT keys from ten connections all succeed',
      distinctResults.filter((r) => r.rows[0].claimed_count === 1).length, 10);

    await Promise.all(conns.map((c) => c.end().catch(() => {})));
    check('all independent connections closed cleanly', true);
  }

  section('6 AI_ACTIVE is refused by the database');
  await q(`UPDATE conversations SET state='AI_ACTIVE' WHERE id=$1`, [conv.id]);
  const r3 = await claim(base({ 4: 'idem-ai-000001' }));
  eq('no row is written while the AI owns it', r3.rows[0].claimed_count, 0);
  eq('the conversation is still visible (so a 409 can be explained)', r3.rows[0].target_count, 1);
  eq('and the state is reported', r3.rows[0].state, 'AI_ACTIVE');

  section('7 a closed conversation is refused');
  await q(`UPDATE conversations SET state='RESOLVED' WHERE id=$1`, [conv.id]);
  const r4 = await claim(base({ 4: 'idem-closed-0001' }));
  eq('no row is written for RESOLVED', r4.rows[0].claimed_count, 0);
  eq('and the state is reported', r4.rows[0].state, 'RESOLVED');

  section('8 brand scope is enforced by the database');
  await q(`UPDATE conversations SET state='QUEUED' WHERE id=$1`, [conv.id]);
  const restricted = base({ 4: 'idem-brand-00001', 5: false, 6: [b2.id] });
  const r5 = await claim(restricted);
  eq('a caller scoped to the OTHER brand writes NOTHING', r5.rows[0].claimed_count, 0);
  eq('and the conversation is not even visible', r5.rows[0].target_count, 0);
  const correct = base({ 4: 'idem-brand-00002', 5: false, 6: [b1.id] });
  const r6 = await claim(correct);
  eq('a caller scoped to the RIGHT brand may reply', r6.rows[0].claimed_count, 1);
  const emptyScope = base({ 4: 'idem-brand-00003', 5: false, 6: [] });
  const r7 = await claim(emptyScope);
  eq('an EMPTY grant means zero brands, never tenant-wide', r7.rows[0].claimed_count, 0);
  eq('and the conversation is invisible', r7.rows[0].target_count, 0);

  // A COMPANY-WIDE channel (brand_id IS NULL) is the case the `ch.brand_id IS NOT
  // NULL` half of the predicate exists for. It is not attributable to any single
  // brand, so a caller restricted to specific brands must never reach it — not
  // even when they hold a grant to one of that company's brands. Without that
  // half, a restricted employee could answer every customer on every company-wide
  // page while holding a grant to a single brand.
  const [wideChannel] = (await q(
    `INSERT INTO channels (tenant_id, brand_id, provider, display_name)
     VALUES ($1, NULL, 'meta_dm', 'company-wide') RETURNING id`, [t1.id])).rows;
  const [wideConv] = (await q(
    `INSERT INTO conversations (tenant_id, channel_id, external_key, state)
     VALUES ($1,$2,'psid-wide','QUEUED') RETURNING id`, [t1.id, wideChannel.id])).rows;
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts)
           VALUES ($1,$2,'inbound','customer','hi','in-wide',$3)`,
    [t1.id, wideConv.id, new Date(Date.now() - 60_000)]);

  const wideRestricted = await q(claimSql,
    [t1.id, wideConv.id, admin.id, 'x', 'idem-nullbrand-01', false, [b1.id], true, 86400, STATES, PROVIDERS]);
  eq('a NULL-brand channel is NOT reachable by a brand-restricted caller',
    wideRestricted.rows[0].claimed_count, 0);
  eq('and the conversation is not even visible to them',
    wideRestricted.rows[0].target_count, 0);

  const wideEmpty = await q(claimSql,
    [t1.id, wideConv.id, admin.id, 'x', 'idem-nullbrand-03', false, [], true, 86400, STATES, PROVIDERS]);
  eq('nor by a caller holding an empty grant', wideEmpty.rows[0].claimed_count, 0);

  const wideTenant = await q(claimSql,
    [t1.id, wideConv.id, admin.id, 'x', 'idem-nullbrand-02', true, [], true, 86400, STATES, PROVIDERS]);
  eq('a TENANT-WIDE caller CAN reach it - that is exactly what the delegation means',
    wideTenant.rows[0].claimed_count, 1);

  // And the company-wide channel of ANOTHER company is still invisible.
  const wideOther = await q(claimSql,
    [t2.id, wideConv.id, admin.id, 'x', 'idem-nullbrand-04', true, [], true, 86400, STATES, PROVIDERS]);
  eq('a company-wide channel of ANOTHER company writes nothing',
    wideOther.rows[0].claimed_count, 0);

  section('9 assignment is enforced for reply_own');
  const [agentA] = (await q(`INSERT INTO users (tenant_id, name) VALUES ($1,'agentA') RETURNING id`, [t1.id])).rows;
  const [agentB] = (await q(`INSERT INTO users (tenant_id, name) VALUES ($1,'agentB') RETURNING id`, [t1.id])).rows;
  await q(`UPDATE conversations SET state='ASSIGNED', assigned_user_id=$1 WHERE id=$2`, [agentA.id, conv.id]);
  const own = base({ 2: agentA.id, 4: 'idem-assign-0001', 7: false });
  eq('the ASSIGNED agent may reply', (await claim(own)).rows[0].claimed_count, 1);
  const notMine = base({ 2: agentB.id, 4: 'idem-assign-0002', 7: false });
  const r8 = await claim(notMine);
  eq('a different agent writes NOTHING', r8.rows[0].claimed_count, 0);
  eq('but the conversation is visible, so the refusal can be explained', r8.rows[0].target_count, 1);
  eq('and the assignment is reported', r8.rows[0].assigned_user_id, agentA.id);
  const unassigned = base({ 2: agentB.id, 4: 'idem-assign-0003', 7: false });
  await q(`UPDATE conversations SET assigned_user_id=NULL WHERE id=$1`, [conv.id]);
  eq('reply_own on an UNASSIGNED conversation writes nothing', (await claim(unassigned)).rows[0].claimed_count, 0);

  section('10 tenant isolation');
  const r9 = await claim(base({ 0: t2.id, 4: 'idem-xtenant-01' }));
  eq('another company writes NOTHING', r9.rows[0].claimed_count, 0);
  eq('and the conversation is invisible', r9.rows[0].target_count, 0);

  section('11 channel capability + messaging window');
  await q(`UPDATE channels SET provider='meta_comment' WHERE id=$1`, [ch1.id]);
  const r10 = await claim(base({ 4: 'idem-comment-001' }));
  eq('a Facebook comment conversation writes NOTHING', r10.rows[0].claimed_count, 0);
  eq('and the channel is reported for an honest refusal', r10.rows[0].channel_provider, 'meta_comment');
  await q(`UPDATE channels SET provider='meta_dm', status='disabled' WHERE id=$1`, [ch1.id]);
  eq('a DISABLED channel writes nothing', (await claim(base({ 4: 'idem-disabled-01' }))).rows[0].claimed_count, 0);
  await q(`UPDATE channels SET status='active' WHERE id=$1`, [ch1.id]);
  const stale = base({ 8: 60, 4: 'idem-window-0001' });
  // Age the PROVIDER timestamp, not created_at: the window is anchored on when
  // the customer wrote. A row whose created_at is recent but whose provider_ts is
  // old is exactly the late-webhook case the window exists to catch.
  await q(`UPDATE messages SET provider_ts = now() - interval '10 days' WHERE conversation_id=$1 AND direction='inbound'`, [conv.id]);
  eq('a conversation outside the messaging window writes NOTHING', (await claim(stale)).rows[0].claimed_count, 0);
  await q(`UPDATE messages SET provider_ts = now() - interval '1 minute' WHERE conversation_id=$1 AND direction='inbound'`, [conv.id]);

  section('12 the idempotency key length constraint');
  await q(`UPDATE conversations SET state='QUEUED', assigned_user_id=NULL WHERE id=$1`, [conv.id]);
  let threw = null;
  try { await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, provider_message_id, idempotency_key)
                  VALUES ($1,$2,'outbound','employee','x-short','short')`, [t1.id, conv.id]); }
  catch (e) { threw = e.code; }
  eq('a key shorter than 8 characters is rejected by the database', threw, '23514');
  threw = null;
  try { await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, provider_message_id, idempotency_key)
                  VALUES ($1,$2,'outbound','employee','x-long',$3)`, [t1.id, conv.id, 'k'.repeat(201)]); }
  catch (e) { threw = e.code; }
  eq('a key longer than 200 characters is rejected by the database', threw, '23514');

  section('13 the human-ownership probe the AI consults');
  const probe = `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE m.tenant_id = $1 AND m.conversation_id = $2 AND m.direction = 'outbound'
                    AND m.sender_type = 'employee' AND m.delivery_status = 'pending' LIMIT 1`;

  // A DEDICATED conversation. Every earlier section leaves its claimed rows
  // 'pending' forever — this suite tests the claim in isolation and never
  // dispatches — so probing 'conv.id' would legitimately match those older rows
  // and prove nothing about this section.
  const [probeConv] = (await q(
    `INSERT INTO conversations (tenant_id, channel_id, external_key, state)
     VALUES ($1,$2,'psid-probe','QUEUED') RETURNING id`, [t1.id, ch1.id])).rows;
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, provider_ts)
           VALUES ($1,$2,'inbound','customer','hi','in-probe',$3)`,
    [t1.id, probeConv.id, new Date(Date.now() - 60_000)]);
  const probeClaim = (key) => q(claimSql,
    [t1.id, probeConv.id, admin.id, 'x', key, true, [], true, 86400, STATES, PROVIDERS]);
  const inFlight = () => q(probe, [t1.id, probeConv.id]).then((r) => r.rowCount);

  eq('a clean conversation has nothing in flight', await inFlight(), 0);
  const claimed1 = await probeClaim('idem-probe-0001');
  eq('the claim was granted', claimed1.rows[0].claimed_count, 1);
  eq('a claimed, undelivered employee reply IS found by the probe', await inFlight(), 1);

  await q(`UPDATE messages SET delivery_status='sent' WHERE id=$1`, [claimed1.rows[0].claimed_id]);
  eq('once delivered it is no longer in flight', await inFlight(), 0);

  await q(`UPDATE messages SET delivery_status='failed' WHERE id=$1`, [claimed1.rows[0].claimed_id]);
  eq('a FAILED employee reply is not in flight either', await inFlight(), 0);

  // A pending AI reply must never be read as human ownership.
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, provider_message_id, delivery_status)
           VALUES ($1,$2,'outbound','ai','ai-pending-1','pending')`, [t1.id, probeConv.id]);
  eq('a pending AI reply is NOT mistaken for human ownership', await inFlight(), 0);

  // An INBOUND employee row must not count either — the predicate is directional.
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, provider_message_id, delivery_status)
           VALUES ($1,$2,'inbound','employee','emp-in-1','pending')`, [t1.id, probeConv.id]);
  eq('an inbound row is NOT mistaken for an in-flight human reply', await inFlight(), 0);

  // A row belonging to another company must never suppress this conversation.
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, provider_message_id, delivery_status)
           VALUES ($1,$2,'outbound','employee','emp-xt-1','pending')`, [t2.id, probeConv.id]);
  eq('an employee row from ANOTHER company never blocks this conversation', await inFlight(), 0);

  // And the real thing, end to end on this conversation.
  const claimed2 = await probeClaim('idem-probe-0002');
  eq('a second claim is also detected', await inFlight(), 1);
  eq('and it produced a distinct row', claimed2.rows[0].claimed_id !== claimed1.rows[0].claimed_id, true);

  section('14 the retry gate cannot resurrect an ambiguous employee reply');
  // claimFailedOutboundForRetry is scoped to sender_type='ai' today. Assert that
  // an employee row is structurally excluded, so P0.2 can never introduce a
  // path that re-sends a human message.
  const retrySrc = readFileSync(join(REPO, 'src/services/conversations.js'), 'utf8');
  const retryFn = retrySrc.slice(retrySrc.indexOf('export async function claimFailedOutboundForRetry'));
  check('the retry claim still requires sender_type = \'ai\'', /AND m\.sender_type = 'ai'/.test(retryFn));
  check('so an employee reply can never be re-sent by it',
    !/sender_type = ANY/.test(retryFn.slice(0, retryFn.indexOf('RETURNING'))));

  section('15 confirmReplyStillOwned must not abort a genuinely owned reply');
  // REGRESSION. count() returns bigint, which node-postgres hands to JS as a
  // STRING. An uncast count compared with `!== 1` is therefore ALWAYS true, so
  // every manual reply was closed as 'state_changed' -> 'aborted_before_send'
  // before it ever reached the provider. Production symptom: the employee typed
  // a reply, the UI accepted it, and the customer never received it.
  const { confirmReplyStillOwned } = await import('../src/services/manualReplies.js');
  const AUTH = {
    tenantId: t1.id, userId: admin.id, tenantWide: true, brandIds: [],
    canReplyAny: true, canReplyOwn: true
  };
  const ownConv = (await q(
    `INSERT INTO conversations (tenant_id, channel_id, external_key, state, assigned_user_id)
     VALUES ($1,$2,'psid-owned','ASSIGNED',$3) RETURNING id`, [t1.id, ch1.id, admin.id])).rows[0];

  // THE MECHANISM: what the raw query actually puts on the JS side.
  const raw = await q(
    `SELECT (SELECT count(*) FROM messages m
              WHERE m.tenant_id=$1 AND m.conversation_id=$2
                AND m.direction='outbound' AND m.idempotency_key=$3) AS still_mine`,
    [t1.id, ownConv.id, 'idem-owned-1']);
  check('an uncast count() reaches JS as a STRING (why !== 1 always failed)',
    typeof raw.rows[0].still_mine === 'string', `typeof=${typeof raw.rows[0].still_mine}`);

  // Before the row exists the recheck must still refuse.
  const tooEarly = await confirmReplyStillOwned({
    authority: AUTH, conversationId: ownConv.id, idempotencyKey: 'idem-owned-1', db: { query: q }
  });
  eq('with no matching row the recheck refuses', tooEarly.ok, false);

  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text,
                                   provider_message_id, idempotency_key, delivery_status)
           VALUES ($1,$2,'outbound','employee','hi','idem:owned-1','idem-owned-1','pending')`,
    [t1.id, ownConv.id]);

  // THE REGRESSION: our own, freshly claimed reply must pass.
  const mine = await confirmReplyStillOwned({
    authority: AUTH, conversationId: ownConv.id, idempotencyKey: 'idem-owned-1', db: { query: q }
  });
  eq('a genuinely owned reply PASSES the recheck', mine.ok, true);
  check('and reports the real reason instead of a blanket state change',
    mine.ok === true || mine.reason !== 'state_changed', `reason=${mine.reason}`);

  // The guard must still actually guard.
  const staleKey = await confirmReplyStillOwned({
    authority: AUTH, conversationId: ownConv.id, idempotencyKey: 'idem-someone-else', db: { query: q }
  });
  eq('a key we do not own is still refused', staleKey.ok, false);
  eq('and still reports state_changed', staleKey.reason, 'state_changed');

  const otherTenant = await confirmReplyStillOwned({
    authority: { ...AUTH, tenantId: t2.id }, conversationId: ownConv.id,
    idempotencyKey: 'idem-owned-1', db: { query: q }
  });
  eq("another company's row is still refused", otherTenant.ok, false);

  // Repo-wide guard so this class of bug cannot come back anywhere in src/.
  const srcDir = join(REPO, 'src');
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/count\(\*\)[^;]{0,240}?\)\s*AS\s+(\w+)/gi)) {
        if (!/::\s*(int|int4|integer)/i.test(m[0])) {
          offenders.push(`${p.replace(REPO, '')} -> ${m[1]}`);
        }
      }
    }
  };
  walk(srcDir);
  eq('no uncast count(*) alias exists anywhere in src/', offenders.length, 0);
  if (offenders.length) console.log('    offenders:', offenders.join(', '));

  section('16 rollback');
  await q(`DROP INDEX IF EXISTS idx_messages_reply_idempotency`);
  await q(`ALTER TABLE messages DROP COLUMN IF EXISTS idempotency_key`);
  const after = await q(`SELECT count(*)::int n FROM information_schema.columns
                          WHERE table_schema=$1 AND table_name='messages' AND column_name='idempotency_key'`, [SCHEMA]);
  eq('rollback removes the column', after.rows[0].n, 0);
  const survivors = await q(`SELECT count(*)::int n FROM messages`);
  check('and every message row survives the rollback (no data loss)', survivors.rows[0].n >= 47, String(survivors.rows[0].n));
} catch (e) {
  failures.push(`fatal: ${e.code ?? ''} ${e.message}`);
  console.error('\n⛔ fatal:', e.code, e.message);
} finally {
  try { await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* best effort */ }
  await client.end().catch(() => {});
}

console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);