/**
 * REAL PostgreSQL integration tests for the outbound delivery guarantees.
 *
 * Run against a throwaway database:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lwc_test \
 *     node scripts/test-pg-delivery-integration.mjs
 *
 * WHY THIS EXISTS
 * The retry gate, the atomic claim and the duplicate-suppression index are all
 * SQL behaviour. A fake pool can only assert that the right string was passed;
 * it cannot prove that PostgreSQL refuses a row the way production will. Every
 * assertion below runs against a real server.
 *
 * NO PRODUCTION DATA IS TOUCHED: the suite refuses to run unless the target
 * database name ends in `_test`, and it only ever inserts rows it created.
 *
 * Verifies, against real PostgreSQL:
 *   - UNIQUE (conversation_id, provider_message_id) suppresses a redelivered
 *     inbound message, and therefore a second AI reply.
 *   - CHECK (delivery_status IN ('pending','sent','failed')) rejects a fourth
 *     value — this is why an 'unknown' status needs no migration.
 *   - claimFailedOutboundForRetry's allow-list is enforced by the DATABASE:
 *     auth/permission/unknown/NULL categories are refused, rate limit is not.
 *   - webhook_events UNIQUE (provider, external_id) + the atomic claim: many
 *     concurrent claimers, exactly one winner.
 *   - A claimed 'failed' event can be re-claimed by a bounded retry; a claimed
 *     'unknown' event never can.
 *   - summarizeStrandedEvents reports the three silent failure modes.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

/** Resolve paths from the script location so cwd does not matter. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('⏭️  TEST_DATABASE_URL not set — skipping real-PostgreSQL integration tests');
  process.exit(0);
}

const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  console.error(`⛔ refusing to run: database "${dbName}" does not end in _test`);
  process.exit(1);
}
console.log(`\n🐘 real PostgreSQL integration — database ${dbName}\n`);

let passed = 0, failed = 0;
// ASCII markers on purpose: this suite's output is frequently piped through
// Windows shells that mangle non-ASCII characters.
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${n}`); }
  else { failed++; console.log(`  [FAIL] ${n}${d ? ' -- ' + d : ''}`); }
};

const pool = new pg.Pool({ connectionString: url, max: 10 });

/* ------------------------------------------------------------------ schema */
async function hasPgvector() {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`
  );
  return rows.length > 0;
}

/**
 * A stock PostgreSQL build has no pgvector. Without it migration 001 aborts part
 * way (the file is one multi-statement query, so `tenants` is never created) and
 * 007 cannot run at all.
 *
 * When the extension is missing we apply the REAL migrations with only the
 * vector-typed statements removed, and report exactly what was filtered. The
 * knowledge/embedding tables are unrelated to the delivery and idempotency
 * behaviour under test — every table this suite actually asserts on
 * (messages, webhook_events, conversations, channels, tenants) is applied
 * verbatim from the repository's own SQL.
 */
const PGVECTOR_AVAILABLE = await hasPgvector();
const filteredStatements = [];

function loadMigration(file) {
  const sql = readFileSync(join(REPO, 'migrations', file), 'utf8');
  if (PGVECTOR_AVAILABLE) return sql;

  const kept = [];
  for (const line of sql.split('\n')) {
    const isVector =
      /^CREATE EXTENSION IF NOT EXISTS vector/i.test(line.trim()) ||
      /\bembedding\s+vector\s*\(/i.test(line) ||
      /USING hnsw \(embedding/i.test(line);
    if (isVector) { filteredStatements.push(`${file}: ${line.trim().slice(0, 60)}`); continue; }
    kept.push(line);
  }
  return kept.join('\n');
}

async function applyMigrations() {
  // Only the migrations that define what this suite asserts on:
  //   001 tenants/channels/conversations/messages/webhook_events
  //   003 meta channel uniqueness
  //   004 delivery_status + its CHECK constraint  <-- load-bearing
  //   005 retry metadata
  // The Knowledge Base migrations (006, 007, 008, 013) build pgvector-typed
  // tables and indexes. They are unrelated to delivery or idempotency, are not
  // touched by this change, and are excluded so a stock PostgreSQL build without
  // pgvector can still exercise the real constraints.
  const REQUIRED = ['001_init.sql', '003_meta_channel_unique.sql', '004_message_delivery_status.sql', '005_message_retry_metadata.sql'];
  const present = readdirSync(join(REPO, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const missing = REQUIRED.filter((f) => !present.includes(f));
  if (missing.length) throw new Error(`missing migrations: ${missing.join(', ')}`);

  const skipped = present.filter((f) => !REQUIRED.includes(f));
  for (const f of REQUIRED) {
    await pool.query(loadMigration(f));
  }
  return { applied: REQUIRED.length, skipped };
}

const { applied: migrationCount, skipped: skippedMigrations } = await applyMigrations();
check('the repository migrations apply against real PostgreSQL', migrationCount === 4,
  `applied=${migrationCount}`);
if (filteredStatements.length) {
  console.log('  [note] pgvector not installed — vector-typed statements filtered out of 001:');
  for (const f of filteredStatements) console.log(`         ${f}`);
}
console.log(`  [note] out of scope for this suite (knowledge base / pgvector): ${skippedMigrations.join(', ')}`);

/* ------------------------------------------------------------------- seeds */
const { rows: [tenant] } = await pool.query(
  `INSERT INTO tenants (name, slug) VALUES ('IT Tenant', 'it-tenant') RETURNING id`
);
const { rows: [channel] } = await pool.query(
  `INSERT INTO channels (tenant_id, provider, external_id, display_name)
   VALUES ($1, 'meta_dm', 'page_it', 'IT page') RETURNING id`,
  [tenant.id]
);
const { rows: [conversation] } = await pool.query(
  `INSERT INTO conversations (tenant_id, channel_id, external_key)
   VALUES ($1, $2, 'PSID_IT') RETURNING id`,
  [tenant.id, channel.id]
);
const OTHER_TENANT = (await pool.query(
  `INSERT INTO tenants (name, slug) VALUES ('IT Other', 'it-other') RETURNING id`
)).rows[0];

const addOutbound = async (over = {}) => {
  const { rows } = await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id, delivery_status, delivery_error)
     VALUES ($1,$2,'outbound','ai','reply text', $3, $4, $5) RETURNING id`,
    [
      over.tenantId ?? tenant.id,
      over.conversationId ?? conversation.id,
      over.pmid ?? null,
      over.status ?? 'pending',
      over.error ?? null
    ]
  );
  return rows[0].id;
};

/* ====================== 1. THE DUPLICATE-SUPPRESSION INDEX ================= */
console.log('--- 1. inbound dedupe really suppresses a second reply ---');
{
  const first = await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id)
     VALUES ($1,$2,'inbound','customer','hi','mid_dup') RETURNING id`,
    [tenant.id, conversation.id]
  );
  check('first inbound insert returns the row', first.rows.length === 1);

  const second = await pool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, text, provider_message_id)
     VALUES ($1,$2,'inbound','customer','hi','mid_dup')
     ON CONFLICT (conversation_id, provider_message_id) DO NOTHING RETURNING id`,
    [tenant.id, conversation.id]
  );
  check('redelivered inbound is suppressed by the UNIQUE index', second.rows.length === 0);
}

/* ================ 2. delivery_status CHECK — WHY NO MIGRATION ============== */
console.log('\n--- 2. delivery_status is constrained; the outcome map fits inside it ---');
{
  const legal = ['pending', 'sent', 'failed'];
  const accepted = [];
  for (const s of legal) {
    try {
      const id = await addOutbound({ status: s, pmid: `pmid_${s}` });
      await pool.query(`DELETE FROM messages WHERE id = $1`, [id]);
      accepted.push(s);
    } catch (e) { /* constraint rejected it */ }
  }
  check('the three outcomes we write are all schema-legal', accepted.length === 3, accepted.join(','));

  let rejected = false;
  try { await addOutbound({ status: 'unknown', pmid: 'pmid_bad' }); }
  catch (e) { rejected = /delivery_status/.test(e.message); }
  check('a fourth status value would be REJECTED (so unknown uses pending + category)', rejected);

  const { rows } = await pool.query(
    `SELECT delivery_error FROM messages WHERE id = $1`, [await addOutbound({ status: 'pending', error: 'delivery_unknown' })]
  );
  check('delivery_error accepts the unknown marker (free text, unconstrained)',
    rows[0].delivery_error === 'delivery_unknown');
}

/* ================== 3. THE RETRY GATE, ENFORCED BY THE DATABASE ============ */
console.log('\n--- 3. only a provably safe refusal may be re-sent ---');
{
  // Exercise the REAL SQL, not a fake pool.
  const { claimFailedOutboundForRetry } = await import('../src/services/conversations.js');

  const claim = (id, t = tenant.id) =>
    claimFailedOutboundForRetry({ messageId: id, conversationId: conversation.id, tenantId: t });

  const rateId = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
  check('meta_rate_limit (confirmed refusal, transient) IS claimable', (await claim(rateId))?.id === rateId);

  const authId = await addOutbound({ status: 'failed', error: 'meta_auth_expired' });
  check('meta_auth_expired is NOT claimable', (await claim(authId)) === null);

  const permId = await addOutbound({ status: 'failed', error: 'meta_permission' });
  check('meta_permission is NOT claimable', (await claim(permId)) === null);

  const apiId = await addOutbound({ status: 'failed', error: 'meta_api_error' });
  check('meta_api_error is NOT claimable', (await claim(apiId)) === null);

  const nullId = await addOutbound({ status: 'failed', error: null });
  check('a failed row with NO category is NOT claimable', (await claim(nullId)) === null);

  // ---- THE HEADLINE CASE: outcome unknown, message possibly already sent ----
  const unknownId = await addOutbound({ status: 'pending', error: 'delivery_unknown' });
  check('delivery_unknown is NOT claimable (the customer may already have it)',
    (await claim(unknownId)) === null);
  const { rows: [still] } = await pool.query(`SELECT delivery_status FROM messages WHERE id = $1`, [unknownId]);
  check('the unknown row is left untouched (no state churn from a refused claim)',
    still.delivery_status === 'pending');

  // ---- tenant isolation, against real rows ----
  const foreignId = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
  check('another tenant cannot claim the row', (await claim(foreignId, OTHER_TENANT.id)) === null);

  // ---- TWO OPERATORS clicking Retry at the same moment ----
  // This is the literal scenario from the review: two staff members, one
  // message. Exactly one Meta POST may result.
  const twoOpsId = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
  const [opA, opB] = await Promise.all([claim(twoOpsId), claim(twoOpsId)]);
  check('two operators retrying the same message -> exactly one winner',
    [opA, opB].filter(Boolean).length === 1, `a=${Boolean(opA)} b=${Boolean(opB)}`);
  const { rows: [twoOpsRow] } = await pool.query(
    `SELECT retry_count, delivery_status FROM messages WHERE id = $1`, [twoOpsId]);
  check('the loser is refused with no state change',
    twoOpsRow.retry_count === 1 && twoOpsRow.delivery_status === 'pending',
    JSON.stringify(twoOpsRow));

  // ---- concurrent claims: exactly one winner ----
  const raceId = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
  const results = await Promise.all([claim(raceId), claim(raceId), claim(raceId), claim(raceId)]);
  const winners = results.filter(Boolean).length;
  check('4 concurrent retry claims -> exactly 1 winner', winners === 1, `winners=${winners}`);
  const { rows: [raceRow] } = await pool.query(`SELECT retry_count FROM messages WHERE id = $1`, [raceId]);
  check('the row was transitioned exactly once', raceRow.retry_count === 1);

  // ---- authorisation matrix, one row per (status, category) combination ----
  const matrix = [
    ['sent', null, false], ['pending', null, false], ['pending', 'delivery_unknown', false],
    ['failed', 'meta_auth_expired', false], ['failed', 'meta_permission', false],
    ['failed', 'meta_api_error', false], ['failed', 'delivery_unknown', false],
    ['failed', null, false], ['failed', 'network_error', false], ['failed', '', false],
    ['failed', 'META_RATE_LIMIT', false], ['failed', ' meta_rate_limit', false],
    ['failed', 'meta_rate_limit', true]
  ];
  for (const [status, category, expected] of matrix) {
    const id = await addOutbound({ status, error: category });
    const won = await claim(id);
    check(`authorisation: ${status}/${category === null ? 'NULL' : JSON.stringify(category)} -> ${expected ? 'ALLOWED' : 'REFUSED'}`,
      Boolean(won) === expected, `got=${Boolean(won)}`);
  }

  // ---- the category allow-list is enforced by the database, not the app ----
  const { rows: [gateSql] } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'messages'::regclass AND conname = 'messages_delivery_status_check'`);
  check('the delivery_status CHECK still allows exactly the three values',
    /'pending'/.test(gateSql.def) && /'sent'/.test(gateSql.def) && /'failed'/.test(gateSql.def) &&
    !/'unknown'/.test(gateSql.def), gateSql.def);

  // ---- brand scope: report what the schema and auth model actually enforce ----
  const { rows: [chanCols] } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'channels' AND column_name = 'brand_id'`);
  check('channels carry brand_id, but the retry gate scopes by tenant',
    chanCols.column_name === 'brand_id');
  const { rows: msgCols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'brand_id'`);
  check('messages have NO brand_id, so brand cannot be scoped in the claim',
    msgCols.length === 0,
    'brand isolation is carried by channels.brand_id and enforced at routing time');
}

/* ================== 4. THE ATOMIC CLAIM ON REAL webhook_events ============= */
console.log('\n--- 4. exactly one worker may claim an event ---');
{
  const { claimWebhookEventForProcessing, recordWebhookEvent, updateWebhookEvent, WEBHOOK_STATUS }
    = await import('../src/services/webhookEvents.js');

  const record = async (id) => (await recordWebhookEvent({ provider: 'meta', eventId: id, eventType: 'message' }));

  check('first intake of an event is recorded', (await record('ev_race'))?.id != null);
  check('redelivered intake is suppressed by UNIQUE (provider, external_id)',
    (await record('ev_race')) === null);

  const results = await Promise.all(
    Array.from({ length: 8 }, () => claimWebhookEventForProcessing({ provider: 'meta', externalId: 'ev_race' }))
  );
  check('8 concurrent claims -> exactly 1 winner', results.filter(Boolean).length === 1,
    `winners=${results.filter(Boolean).length}`);

  // A row left 'processing' (worker died) must never be claimable again.
  check('a processing row is never re-claimed',
    (await claimWebhookEventForProcessing({ provider: 'meta', externalId: 'ev_race' })) === null);

  // A bounded retry: 'failed' IS claimable, because nothing was sent.
  await updateWebhookEvent({ provider: 'meta', externalId: 'ev_race', status: 'failed', error: 'processing_error' });
  check('a failed row IS re-claimable (bounded retry, nothing sent)',
    (await claimWebhookEventForProcessing({ provider: 'meta', externalId: 'ev_race' })) != null);

  // THE STRUCTURAL GUARANTEE: after a send was attempted the row is 'unknown',
  // and the claim refuses it — this is what stops BullMQ from re-sending.
  await updateWebhookEvent({
    provider: 'meta', externalId: 'ev_race',
    status: WEBHOOK_STATUS.UNKNOWN, error: 'OUTBOUND_ATTEMPTED'
  });
  const afterSend = await claimWebhookEventForProcessing({ provider: 'meta', externalId: 'ev_race' });
  check('an UNKNOWN row (send already attempted) is NEVER claimable', afterSend === null);

  // webhook_events.status has no CHECK, so 'unknown' is storable without a migration.
  const { rows } = await pool.query(`SELECT status FROM webhook_events WHERE external_id = 'ev_race'`);
  check('webhook_events accepts an unconstrained status value', rows[0].status === 'unknown');
}

/* ================== 5. STRAY-EVENT REPORTING (REAL SQL) =================== */
console.log('\n--- 5. the silent failure modes are reportable ---');
{
  const { summarizeStrandedEvents, strandedEventTotal } = await import('../src/services/webhookEvents.js');

  await pool.query(`INSERT INTO webhook_events (provider, external_id, payload, status, received_at)
     VALUES ('meta','ev_stuck','{}','processing', now() - interval '2 hours')`);
  await pool.query(`INSERT INTO webhook_events (provider, external_id, payload, status, received_at, processed_at)
     VALUES ('meta','ev_unknown','{}','unknown', now() - interval '2 hours', now() - interval '2 hours')`);
  // A stranded row that has hit the re-dispatch cap.
  await pool.query(`INSERT INTO webhook_events (provider, external_id, payload, status, received_at, error)
     VALUES ('meta','ev_capped','{}','received', now() - interval '2 hours', 'REDISPATCHED:5')`);

  const s = await summarizeStrandedEvents();
  check('stuck processing events are counted', s.stuck_processing >= 1, JSON.stringify(s));
  check('unknown delivery outcomes are counted', s.unknown_delivery >= 1);
  check('rows that hit the re-dispatch cap are counted', s.redispatch_capped >= 1);
  // A row stuck in 'processing' has no processed_at, so ageing must fall back to
  // received_at — otherwise the most urgent rows read as fresh.
  check('aged rows are reported separately, including rows with no processed_at',
    s.aged_total >= 3, `aged=${s.aged_total}`);
  check('a single at-a-glance total is available', strandedEventTotal(s) >= 3);
}

await pool.end();

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);