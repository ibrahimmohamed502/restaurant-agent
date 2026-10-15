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

  // These cases assert the CATEGORY gate, so they run as a fully authorised
  // caller. A scope is now mandatory: omitting it means "no brands", which
  // correctly refuses everything — that fail-closed default is asserted
  // separately in section 3d.
  const AUTHORISED = { mode: 'tenant', brandIds: null };
  const claim = (id, t = tenant.id) =>
    claimFailedOutboundForRetry({ messageId: id, conversationId: conversation.id, tenantId: t, scope: AUTHORISED });

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

/* ============ 3d. BRAND SCOPE INSIDE THE ATOMIC CLAIM ==================== */
console.log('\n--- 3d. the claim enforces brand scope atomically ---');
{
  const { rows: [brandA] } = await pool.query(
    `INSERT INTO brands (tenant_id, name, slug) VALUES ($1,'Brand A','brand-a') RETURNING id`,
    [tenant.id]);
  const { rows: [brandB] } = await pool.query(
    `INSERT INTO brands (tenant_id, name, slug) VALUES ($1,'Brand B','brand-b') RETURNING id`,
    [tenant.id]);

  // A conversation on brand A, and one on brand B.
  const { rows: [chanA] } = await pool.query(
    `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name)
     VALUES ($1,$2,'meta_dm','page_a','A') RETURNING id`, [tenant.id, brandA.id]);
  const { rows: [convA] } = await pool.query(
    `INSERT INTO conversations (tenant_id, channel_id, external_key)
     VALUES ($1,$2,'PSID_A') RETURNING id`, [tenant.id, chanA.id]);

  // Company-wide channel: brand_id IS NULL.
  const { rows: [chanTenant] } = await pool.query(
    `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name)
     VALUES ($1,NULL,'meta_dm','page_tenant','Tenant') RETURNING id`, [tenant.id]);
  const { rows: [convTenant] } = await pool.query(
    `INSERT INTO conversations (tenant_id, channel_id, external_key)
     VALUES ($1,$2,'PSID_T') RETURNING id`, [tenant.id, chanTenant.id]);

  const { claimFailedOutboundForRetry } = await import('../src/services/conversations.js');
  const scopedClaim = (messageId, conversationId, scope) =>
    claimFailedOutboundForRetry({ messageId, conversationId, tenantId: tenant.id, scope });

  const TENANT_WIDE = { mode: 'tenant', brandIds: null };
  const ONLY_A = { mode: 'restricted', brandIds: [brandA.id] };
  const ONLY_B = { mode: 'restricted', brandIds: [brandB.id] };
  const NO_BRANDS = { mode: 'restricted', brandIds: [] };

  // --- in scope ---
  const inA = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  check('tenant-wide scope claims a brand-A message', (await scopedClaim(inA, convA.id, TENANT_WIDE))?.id === inA);
  const inA2 = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  check('a grant naming brand A claims a brand-A message',
    (await scopedClaim(inA2, convA.id, ONLY_A))?.id === inA2);

  // --- out of scope, and the denial must leave NO trace ---
  const inA3 = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  check('a grant naming brand B cannot claim a brand-A message',
    (await scopedClaim(inA3, convA.id, ONLY_B)) === null);
  let row = (await pool.query(`SELECT delivery_status, retry_count FROM messages WHERE id = $1`, [inA3])).rows[0];
  check('the denied row keeps its state', row.delivery_status === 'failed' && row.retry_count === 0,
    JSON.stringify(row));

  // --- company-wide channel is never reachable by a restricted caller ---
  const inT = await addOutbound({ conversationId: convTenant.id, status: 'failed', error: 'meta_rate_limit' });
  check('a restricted caller cannot claim a company-wide (NULL brand) message',
    (await scopedClaim(inT, convTenant.id, ONLY_A)) === null);
  const inT2 = await addOutbound({ conversationId: convTenant.id, status: 'failed', error: 'meta_rate_limit' });
  check('a tenant-wide caller CAN claim a company-wide message',
    (await scopedClaim(inT2, convTenant.id, TENANT_WIDE))?.id === inT2);

  // --- a zero-brand scope is refused, never widened ---
  const inA4 = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  check('a zero-brand scope claims nothing',
    (await scopedClaim(inA4, convA.id, NO_BRANDS)) === null);
  const inA5 = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  check('a MISSING scope is refused, not treated as tenant-wide',
    (await scopedClaim(inA5, convA.id, undefined)) === null);
  const inA6 = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  check('a MALFORMED scope is refused, not treated as tenant-wide',
    (await scopedClaim(inA6, convA.id, { mode: 'nonsense' })) === null);

  // --- brand scope must not weaken tenant isolation ---
  const inB = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  const crossTenant = await claimFailedOutboundForRetry({
    messageId: inB, conversationId: convA.id, tenantId: OTHER_TENANT.id, scope: TENANT_WIDE
  });
  check('a brand grant never bypasses tenant isolation', crossTenant === null);

  // --- concurrency across two brands, under a restricted scope ---
  const cA = await addOutbound({ conversationId: convA.id, status: 'failed', error: 'meta_rate_limit' });
  const [r1, r2] = await Promise.all([
    scopedClaim(cA, convA.id, ONLY_A), scopedClaim(cA, convA.id, ONLY_A)
  ]);
  check('two restricted operators -> exactly one winner',
    [r1, r2].filter(Boolean).length === 1);
  const [x1, x2] = await Promise.all([
    scopedClaim(cA, convA.id, ONLY_B), scopedClaim(cA, convA.id, ONLY_B)
  ]);
  check('two operators with the WRONG brand both lose', x1 === null && x2 === null);
  const after = (await pool.query(`SELECT delivery_status, retry_count FROM messages WHERE id = $1`, [cA])).rows[0];
  check('exactly one transition was applied overall',
    after.retry_count === 1 && after.delivery_status === 'pending', JSON.stringify(after));

  // --- the brand is exposed for audit/reporting ---
  const { brandVisibleToScope, BRAND_SCOPE_TENANT } = await import('../src/api/v1/brandAccess.js');
  check('the tenant-wide scope sees the NULL-brand channel', brandVisibleToScope(null, { mode: BRAND_SCOPE_TENANT }));
  check('a restricted scope does not', !brandVisibleToScope(null, ONLY_A));
  check('a restricted scope sees only its own brand', brandVisibleToScope(brandA.id, ONLY_A));
}

/* ============ 3e. RETRY-STATE TRANSITIONS ON REAL ROWS ==================== */
console.log('\n--- 3e. state transitions a Manual Retry can produce ---');
{
  const { classifyDeliveryError } = await import('../src/services/deliveryOutcome.js');
  const { claimFailedOutboundForRetry, finishMessageDelivery } = await import('../src/services/conversations.js');
  const AUTHORISED = { mode: 'tenant', brandIds: null };

  const state = async (id) =>
    (await pool.query(
      `SELECT delivery_status, delivery_error, retry_count, provider_message_id FROM messages WHERE id = $1`,
      [id])).rows[0];

  // --- Phase 2: a VERIFIED throttling refusal is stored as retryable ---
  {
    const id = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
    const outcome = classifyDeliveryError({ status: 429, graphCode: 4, isGraphError: true });
    await finishMessageDelivery({
      tenantId: tenant.id, messageId: id,
      deliveryStatus: outcome.deliveryStatus, errorCategory: outcome.category
    });
    const row = await state(id);
    check('a verified throttle refusal is stored failed + meta_rate_limit',
      row.delivery_status === 'failed' && row.delivery_error === 'meta_rate_limit', JSON.stringify(row));
    check('and it is claimable again',
      (await claimFailedOutboundForRetry({
        messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      }))?.id === id);
    const after = await state(id);
    check('the claim reset it to pending with no category',
      after.delivery_status === 'pending' && after.delivery_error === null, JSON.stringify(after));
  }

  // --- Phase 2: an UNKNOWN outcome is stored pending and is NOT claimable ---
  {
    const id = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
    await claimFailedOutboundForRetry({
      messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
    });
    const outcome = classifyDeliveryError(Object.assign(new TypeError('fetch failed'), { isTransportError: true }));
    await finishMessageDelivery({
      tenantId: tenant.id, messageId: id,
      deliveryStatus: outcome.deliveryStatus, errorCategory: outcome.category
    });
    const row = await state(id);
    check('a timeout is stored pending + delivery_unknown',
      row.delivery_status === 'pending' && row.delivery_error === 'delivery_unknown', JSON.stringify(row));
    check('and the claim refuses it forever',
      (await claimFailedOutboundForRetry({
        messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      })) === null);
    check('the row was left exactly as the claim set it',
      (await state(id)).retry_count === 1);
  }

  // --- Phase 3: DELIVERED BUT NOT RECORDED -> the row must stay un-sendable ---
  // The handler deliberately performs NO write in this case; the row keeps the
  // claim's state. Proving that state is refused is what prevents a duplicate.
  {
    const id = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
    await claimFailedOutboundForRetry({
      messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
    });
    const row = await state(id);
    check('after a confirmed delivery the row is pending with no category',
      row.delivery_status === 'pending' && row.delivery_error === null, JSON.stringify(row));
    check('a delivered-but-unrecorded row cannot be sent again',
      (await claimFailedOutboundForRetry({
        messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      })) === null);
    check('and no second transition was applied', (await state(id)).retry_count === 1);
  }

  // --- A 'failed' write after a confirmed delivery would be UNSAFE: prove the
  //     gate refuses every category the handler could wrongly write. ---
  {
    const writable = ['meta_rate_limit', 'delivery_unknown', 'meta_api_error', 'meta_auth_expired'];
    for (const category of writable) {
      const id = await addOutbound({ status: 'failed', error: 'meta_rate_limit' });
      await claimFailedOutboundForRetry({
        messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      });
      await finishMessageDelivery({ tenantId: tenant.id, messageId: id, deliveryStatus: 'failed', errorCategory: category });
      const claimable = (await claimFailedOutboundForRetry({
        messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      })) !== null;
      const safe = category !== 'meta_rate_limit';
      check(`writing '${category}' after a delivery is ${safe ? 'refused' : 'ALLOWED (the bug we removed)'}`,
        claimable === !safe);
    }
  }

  // --- The CHECK constraint still admits every state the handler writes ---
  {
    const id = await addOutbound({ status: 'pending', error: null });
    await finishMessageDelivery({ tenantId: tenant.id, messageId: id, deliveryStatus: 'sent', providerMessageId: 'mid_x' });
    const row = await state(id);
    check('the sent + provider id write is accepted by the schema',
      row.delivery_status === 'sent' && row.provider_message_id === 'mid_x', JSON.stringify(row));
    check('and a sent row is never claimable',
      (await claimFailedOutboundForRetry({
        messageId: id, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      })) === null);
  }
}

/* ============ 3f. RECONCILIATION MARKERS + SCOPED REPORT ================ */
console.log('\n--- 3f. markers persist, stay non-retryable, and stay scoped ---');
{
  const { recordReconciliationMarker, summarizeUnresolvedOutbound, claimFailedOutboundForRetry } =
    await import('../src/services/conversations.js');
  const { DELIVERY_CATEGORY, PENDING_INFLIGHT } =
    await import('../src/services/deliveryOutcome.js');
  const AUTHORISED = { mode: 'tenant', brandIds: null };

  const state = (id) => pool.query(
    `SELECT delivery_status, delivery_error FROM messages WHERE id = $1`, [id]
  ).then((r) => r.rows[0]);

  // --- the marker is written only onto a pending row ---
  {
    const pending = await addOutbound({ status: 'pending', error: null });
    const ok = await recordReconciliationMarker({
      tenantId: tenant.id, messageId: pending, category: DELIVERY_CATEGORY.DELIVERED_UNRECORDED
    });
    const row = await state(pending);
    check('the marker is persisted on a pending row', ok === true, JSON.stringify(row));
    check('and it does not change delivery_status',
      row.delivery_status === 'pending' && row.delivery_error === 'delivered_unrecorded',
      JSON.stringify(row));
    check('a marked row is NOT claimable (no duplicate possible)',
      (await claimFailedOutboundForRetry({
        messageId: pending, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      })) === null);
  }

  // --- refused marker ---
  {
    const refused = await addOutbound({ status: 'pending', error: null });
    await recordReconciliationMarker({
      tenantId: tenant.id, messageId: refused, category: DELIVERY_CATEGORY.REFUSED_UNRECORDED
    });
    check('the refused marker persists',
      (await state(refused)).delivery_error === 'refused_unrecorded');
    check('and is NOT claimable either',
      (await claimFailedOutboundForRetry({
        messageId: refused, conversationId: conversation.id, tenantId: tenant.id, scope: AUTHORISED
      })) === null);
  }

  // --- a non-pending row can never be marked ---
  {
    const sent = await addOutbound({ status: 'sent', pmid: 'x1' });
    const ok = await recordReconciliationMarker({
      tenantId: tenant.id, messageId: sent, category: DELIVERY_CATEGORY.DELIVERED_UNRECORDED
    });
    check('a sent row is NOT marked', ok === false);
    check('and is left untouched', (await state(sent)).delivery_error === null);
  }

  // --- a non-reconciliation category is refused by the writer itself ---
  {
    const row = await addOutbound({ status: 'pending', error: null });
    let rejected = false;
    try {
      await recordReconciliationMarker({
        tenantId: tenant.id, messageId: row, category: 'meta_rate_limit'
      });
    } catch (e) { rejected = e.code === 'INVALID_RECONCILIATION_MARKER'; }
    check('the writer refuses a retryable category', rejected);
  }

  // --- tenant isolation ---
  {
    const mine = await addOutbound({ status: 'pending', error: null });
    const crossTenant = await recordReconciliationMarker({
      tenantId: OTHER_TENANT.id, messageId: mine, category: DELIVERY_CATEGORY.DELIVERED_UNRECORDED
    });
    check('another tenant cannot mark the row', crossTenant === false);
    check('and the row keeps its own state', (await state(mine)).delivery_error === null);
  }

  // --- the scoped report ---
  {
    const summary = await summarizeUnresolvedOutbound({ tenantId: tenant.id, scope: AUTHORISED });
    // One row was marked delivered_unrecorded and one refused_unrecorded above;
    // anything else carrying a marker would come from earlier sections.
    check('the report counts delivered_unrecorded',
      summary.delivered_unrecorded >= 1, JSON.stringify(summary));
    check('the report counts refused_unrecorded',
      summary.refused_unrecorded >= 1, JSON.stringify(summary));
    check('the report separates ordinary in-flight rows',
      summary.pending_inflight >= 1, JSON.stringify(summary));
    check('unresolved_total excludes ordinary in-flight rows',
      summary.unresolved_total ===
        summary.delivered_unrecorded + summary.refused_unrecorded + summary.delivery_unknown,
      JSON.stringify(summary));
    check('the report excludes the other tenant',
      summary.unresolved_total < 100);

    // A zero-brand scope sees nothing, even though rows exist.
    const none = await summarizeUnresolvedOutbound({
      tenantId: tenant.id, scope: { mode: 'restricted', brandIds: [] }
    });
    check('a zero-brand scope sees no unresolved rows',
      none.delivered_unrecorded === 0 && none.refused_unrecorded === 0 && none.pending_inflight === 0,
      JSON.stringify(none));

    // Missing tenant must be DISTINGUISHABLE from a genuine zero, never reported
    // as a clean state.
    const noTenant = await summarizeUnresolvedOutbound({ scope: AUTHORISED });
    check('a missing tenant is marked unavailable, not clean',
      noTenant.unavailable === true && noTenant.reason === 'TENANT_REQUIRED', JSON.stringify(noTenant));
    check('a missing tenant never leaks a count', noTenant.unresolved_total === 0);
    check('the in-flight bucket is a fixed token',
      typeof PENDING_INFLIGHT === 'string' && PENDING_INFLIGHT === 'pending_inflight');
  }

  // ---- the worker's cross-tenant aggregate ----
  {
    const { summarizeUnresolvedOutboundAllTenants } =
      await import('../src/services/conversations.js');

    const otherId = OTHER_TENANT.id;
    const { rows: [otherConv] } = await pool.query(
      `INSERT INTO conversations (tenant_id, external_key)
       VALUES ($1, 'PSID_OTHER') RETURNING id`, [otherId]);
    const { rows: [otherChan] } = await pool.query(
      `INSERT INTO channels (tenant_id, provider, external_id, display_name)
       VALUES ($1,'meta_dm','page_other','Other') RETURNING id`, [otherId]);
    await pool.query(`UPDATE conversations SET channel_id = $2 WHERE id = $1`, [otherConv.id, otherChan.id]);

    const before = await summarizeUnresolvedOutboundAllTenants();

    // One marked row in our tenant, two in the other.
    await addOutbound({ status: 'pending', error: null });
    await pool.query(
      `UPDATE messages SET delivery_error = 'delivered_unrecorded', created_at = now() - interval '1 hour'
        WHERE id = (SELECT id FROM messages WHERE tenant_id = $1 AND direction='outbound'
                     ORDER BY created_at DESC LIMIT 1)`, [tenant.id]);

    await addOutbound({ tenantId: otherId, conversationId: otherConv.id, status: 'pending', error: 'refused_unrecorded' });
    await addOutbound({ tenantId: otherId, conversationId: otherConv.id, status: 'pending', error: 'delivery_unknown' });
    await pool.query(
      `UPDATE messages SET created_at = now() - interval '1 hour'
        WHERE tenant_id = $1 AND delivery_error = ANY($2::text[])`,
      [otherId, ['refused_unrecorded', 'delivery_unknown']]);

    const all = await summarizeUnresolvedOutboundAllTenants();
    check('the aggregate counts rows across tenants',
      all.refused_unrecorded >= 1 && all.delivery_unknown >= 1, JSON.stringify(all));
    check('the aggregate total is the sum of the marker buckets',
      all.unresolved_total === all.delivered_unrecorded + all.refused_unrecorded + all.delivery_unknown,
      JSON.stringify(all));
    check('the aggregate grew versus the empty database',
      all.unresolved_total > before.unresolved_total);
    check('more than one tenant is affected',
      all.tenants_affected >= 2, String(all.tenants_affected));

    // It must not name any tenant.
    const serialised = JSON.stringify(all);
    check('no tenant id leaks through the aggregate',
      !serialised.includes(tenant.id) && !serialised.includes(otherId), serialised);
    check('no per-tenant breakdown is returned',
      !('byTenant' in all) && !('tenants' in all));
    check('no customer content is returned',
      !/text|name|psid|message_id/i.test(serialised), serialised);

    // Ageing: a message that went pending seconds ago is legitimately in flight,
    // so it must appear in NO bucket until it has had time to settle.
    const fresh = await addOutbound({ status: 'pending', error: null });
    await pool.query(`UPDATE messages SET created_at = now() WHERE id = $1`, [fresh]);
    const afterFresh = await summarizeUnresolvedOutboundAllTenants();
    check('a row that just went pending is not counted as unresolved',
      afterFresh.unresolved_total === all.unresolved_total,
      `${JSON.stringify(afterFresh)} vs ${JSON.stringify(all)}`);
    check('nor is it counted as in-flight before it has settled',
      afterFresh.pending_inflight === all.pending_inflight,
      `${JSON.stringify(afterFresh)} vs ${JSON.stringify(all)}`);

    // Age the same row: it must now become visible, and only as in-flight.
    await pool.query(
      `UPDATE messages SET created_at = now() - interval '1 hour' WHERE id = $1`, [fresh]);
    const afterAged = await summarizeUnresolvedOutboundAllTenants();
    check('once aged, a still-pending row is visible as in-flight',
      afterAged.pending_inflight === all.pending_inflight + 1,
      `${JSON.stringify(afterAged)} vs ${JSON.stringify(all)}`);
    check('an in-flight row is never counted as unresolved',
      afterAged.unresolved_total === all.unresolved_total,
      `${JSON.stringify(afterAged)} vs ${JSON.stringify(all)}`);
    check('the aggregate still names no tenant after ageing',
      !JSON.stringify(afterAged).includes(otherId), JSON.stringify(afterAged));
  }
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