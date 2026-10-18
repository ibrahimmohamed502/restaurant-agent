/**
 * Migration 020 SAFETY REVIEW - applied to a database built from the EXACT
 * production migration set, with data that already exists when 020 runs.
 *
 * This is the check that matters: 020 is additive on paper, but the backfill of
 * team_members.tenant_id writes to existing rows, and the new composite
 * foreign keys can only be added if every existing row already satisfies them.
 * A test that applies 020 to an empty schema proves none of that.
 *
 * READ-ONLY against production. Runs on a throwaway database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const REPO = process.env.REPO_DIR || join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_DATABASE_URL;
const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
if (!dbName.endsWith('_test')) { console.error('refusing: not a _test database'); process.exit(1); }
process.env.DATABASE_URL = url;

let pass = 0; const failures = [];
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { failures.push(n); console.log(`  FAIL  ${n}  ${d}`); } };

// EXACTLY the 17 migrations in the production ledger, in order.
const PRODUCTION_SET = ['001_init.sql', '002_auth.sql', '003_meta_channel_unique.sql',
  '004_message_delivery_status.sql', '005_message_retry_metadata.sql', '006_knowledge_drafts_versions.sql',
  '007_knowledge_vector_index.sql', '008_reply_sources.sql', '009_handoff.sql',
  '010_platform_super_admin.sql', '011_fix_company_admin_wildcard.sql', '012_add_brand_default_language.sql',
  '013_backfill_knowledge_sources.sql', '015_brand_access_grants.sql', '016_manual_reply_idempotency.sql',
  '017_escalation_resolve_ability.sql', '018_handoff_acknowledgment.sql'];

const c = new pg.Client({ connectionString: url });
await c.connect();
const q = (s, p) => c.query(s, p);

try {
  console.log('\n=== A. build the production schema (001-018, the real ledger) ===');
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await q(`CREATE EXTENSION IF NOT EXISTS vector`);
  for (const f of PRODUCTION_SET) await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  check(`all ${PRODUCTION_SET.length} production migrations applied`, true);

  console.log('\n=== B. inventory BEFORE 020 ===');
  const before = (await q(
    `SELECT table_name, count(*)::int cols FROM information_schema.columns
      WHERE table_schema='public' GROUP BY 1 ORDER BY 1`)).rows;
  const beforeCols = before.reduce((n, t) => n + t.cols, 0);
  const beforeIdx = (await q(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public'`)).rows[0].n;
  const beforeFK = (await q(`SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`)).rows[0].n;
  console.log(`  tables=${before.length} columns=${beforeCols} indexes=${beforeIdx} fks=${beforeFK}`);

  console.log('\n=== C. seed data that ALREADY EXISTS when 020 runs ===');
  const { rows: [t1] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T','mig020') RETURNING id`);
  const { rows: [br] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B','mig020-b') RETURNING id`, [t1.id]);
  const { rows: [u1] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'a@t.local','A','x') RETURNING id`, [t1.id]);
  const { rows: [u2] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'b@t.local','B','x') RETURNING id`, [t1.id]);
  const { rows: [tm1] } = await q(`INSERT INTO teams (tenant_id,name) VALUES ($1,'Customer Service') RETURNING id`, [t1.id]);
  await q(`INSERT INTO team_members (team_id,user_id,role_in_team) VALUES ($1,$2,'lead'),($1,$3,'agent')`, [tm1.id, u1.id, u2.id]);
  const { rows: [ch] } = await q(`INSERT INTO channels (tenant_id,brand_id,provider) VALUES ($1,$2,'meta_dm') RETURNING id`, [t1.id, br.id]);
  await q(`INSERT INTO conversations (tenant_id,channel_id,external_key,state) VALUES ($1,$2,'ek','QUEUED')`, [t1.id, ch.id]);
  console.log('  seeded: 1 tenant, 1 brand, 2 users, 1 team, 2 members, 1 conversation');

  // The EXACT team rows production holds today, so section D is a rehearsal of
  // the real deployment rather than a tidy fiction.
  //
  // This is the single most important input to the whole review: 020 creates
  // teams_tenant_name_lower_uniq, and if these 8 rows could not produce that
  // index, the migration would FAIL against production and take the API down.
  // Production has three names repeated ACROSS its two companies, which is why
  // the index is scoped by tenant_id - and no case collisions within either
  // company, which is why it can be built at all.
  const { rows: [pt1] } = await q(`INSERT INTO tenants (name,slug) VALUES ('ProdCo1','mig020-prod-1') RETURNING id`);
  const { rows: [pt2] } = await q(`INSERT INTO tenants (name,slug) VALUES ('ProdCo2','mig020-prod-2') RETURNING id`);
  const PROD_TEAMS = [
    [pt1.id, 'Customer Service'], [pt1.id, 'IT'], [pt1.id, 'Management'],
    [pt1.id, 'Marketing'], [pt1.id, 'Purchasing'],
    [pt2.id, 'Customer Service'], [pt2.id, 'Management'], [pt2.id, 'Marketing'],
  ];
  for (const [tid, name] of PROD_TEAMS) {
    await q(`INSERT INTO teams (tenant_id,name) VALUES ($1,$2)`, [tid, name]);
  }
  console.log(`  seeded the REAL production shape: ${PROD_TEAMS.length} teams across 2 companies`);

  // Precondition, asserted so a failure below is unambiguous: this dataset must
  // be case-clean inside each company, and must repeat names across companies.
  const collide = await q(
    `SELECT tenant_id, lower(name) l FROM teams
      WHERE tenant_id IN ($1,$2) GROUP BY 1,2 HAVING count(*) > 1`, [pt1.id, pt2.id]);
  check('the production team set has NO case collision inside a company', collide.rows.length === 0,
    JSON.stringify(collide.rows));
  const repeated = await q(
    `SELECT lower(name) l, count(DISTINCT tenant_id) n FROM teams
      WHERE tenant_id IN ($1,$2) GROUP BY 1 HAVING count(DISTINCT tenant_id) > 1`, [pt1.id, pt2.id]);
  check('and DOES repeat names across the two companies', repeated.rows.length === 3,
    JSON.stringify(repeated.rows));

  console.log('\n=== D. apply 020 to a database that already has data ===');
  // Captured BEFORE 020, so "did 020 add anything unvalidated" is answerable
  // without being confused by pre-existing state from 001.
  const UNVALIDATED_BEFORE = (await q(
    `SELECT c.conname || '@' || c.conrelid::regclass::text AS k
       FROM pg_constraint c
      WHERE NOT c.convalidated AND c.connamespace='public'::regnamespace
      ORDER BY 1`)).rows.map((r) => r.k);
  await q(readFileSync(join(REPO, 'migrations/020_team_lifecycle.sql'), 'utf8'));
  check('020 applies cleanly over existing data', true);

  // The decisive one. If CREATE UNIQUE INDEX had thrown, the statement above
  // would already have failed the review; this states the outcome explicitly so
  // a future edit that weakens the index cannot pass unnoticed.
  const caseIdx = await q(
    `SELECT indexdef FROM pg_indexes WHERE indexname='teams_tenant_name_lower_uniq'`);
  check('the case-insensitive index WAS created over the real production teams',
    caseIdx.rows.length === 1, JSON.stringify(caseIdx.rows));
  check('and it is UNIQUE and scoped by company',
    /UNIQUE/i.test(caseIdx.rows[0]?.indexdef ?? '') && /tenant_id/i.test(caseIdx.rows[0]?.indexdef ?? ''),
    caseIdx.rows[0]?.indexdef ?? '');
  check('all 8 production teams survived 020',
    (await q(`SELECT count(*)::int n FROM teams WHERE tenant_id IN ($1,$2)`, [pt1.id, pt2.id])).rows[0].n === 8);

  console.log('\n=== E. the backfill actually populated tenant_id ===');
  const { rows: back } = await q(
    `SELECT tm.user_id, tm.tenant_id, t.tenant_id AS team_tenant
       FROM team_members tm JOIN teams t ON t.id = tm.team_id ORDER BY tm.user_id`);
  check('every membership got its company', back.length === 2 && back.every((r) => r.tenant_id === r.team_tenant),
    JSON.stringify(back));
  check('and the company is the right one', back.every((r) => r.tenant_id === t1.id));

  console.log('\n=== F. no existing row was lost or altered ===');
  const afterCols = (await q(
    `SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public'`)).rows[0].n;
  check(`columns only INCREASED (${beforeCols} -> ${afterCols})`, afterCols > beforeCols);
  // teams is 1 seeded + the 8 real production rows from section C.
  for (const [t, n] of [['users', 2], ['teams', 9], ['conversations', 1], ['channels', 1], ['tenants', 3]]) {
    const got = (await q(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
    check(`${t} row count unchanged (${n})`, got === n, `got ${got}`);
  }
  const { rows: [tmRow] } = await q(`SELECT role_in_team FROM team_members WHERE user_id=$1`, [u1.id]);
  eq_role(tmRow?.role_in_team);
  function eq_role(v) { check('the pre-existing role_in_team value is untouched', v === 'lead', String(v)); }
  const { rows: [conv] } = await q(`SELECT state FROM conversations LIMIT 1`);
  check('the pre-existing conversation state is untouched', conv.state === 'QUEUED', conv.state);

  console.log('\n=== G. new constraints are VALID, not merely present ===');
  for (const name of ['teams_status_check', 'team_members_tenant_fk', 'teams_brand_tenant_fk',
    'team_members_live_tenant_required', 'teams_id_tenant_key', 'teams_brand_tenant_fk']) {
    const { rows } = await q(
      `SELECT convalidated FROM pg_constraint WHERE conname=$1 AND connamespace='public'::regnamespace`, [name]);
    check(`constraint ${name} exists and is VALID`, rows.length === 1 && rows[0].convalidated === true);
  }
  const unvalidatedAfter = (await q(
    `SELECT c.conname || '@' || c.conrelid::regclass::text AS k
       FROM pg_constraint c
      WHERE NOT c.convalidated AND c.connamespace='public'::regnamespace
      ORDER BY 1`)).rows.map((r) => r.k).sort();
  // Compare against the pre-020 baseline rather than against zero. Production
  // already carries two unvalidated CHECK constraints from 001
  // (conversations_state_check, messages_sender_type_check); asserting zero
  // would blame 020 for pre-existing state. What matters is that it ADDS none.
  const introduced = unvalidatedAfter.filter((k) => !UNVALIDATED_BEFORE.includes(k));
  check('020 introduces NO new unvalidated constraint', introduced.length === 0, introduced.join(' '));
  console.log(`    [info] pre-existing unvalidated (unchanged): ${UNVALIDATED_BEFORE.length}`
    + (UNVALIDATED_BEFORE.length ? ` -> ${UNVALIDATED_BEFORE.join(', ')}` : ''));
  console.log(`    [info] total unvalidated after 020: ${unvalidatedAfter.length}`);

  console.log('\n=== H. the primary key was NOT dropped or recreated ===');
  const { rows: [pk] } = await q(
    `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='team_members'::regclass AND contype='p'`);
  check('team_members still has exactly its original PK',
    /PRIMARY KEY \(team_id, user_id\)/.test(pk.d), pk.d);
  const pkIdx = (await q(
    `SELECT indexname FROM pg_indexes WHERE tablename='team_members' AND indexdef LIKE '%UNIQUE%'`)).rows.map((r) => r.indexname);
  check('and its backing index still exists', pkIdx.includes('team_members_pkey'), pkIdx.join(','));

  console.log('\n=== I. cross-company membership is now impossible ===');
  const { rows: [t2] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T2','mig020-x') RETURNING id`);
  let blocked = false;
  try {
    await q(`INSERT INTO team_members (team_id,user_id,tenant_id,role_in_team) VALUES ($1,$2,$3,'agent')`,
      [tm1.id, (await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'x@t2.local','X','x') RETURNING id`, [t2.id])).rows[0].id, t2.id]);
  } catch (e) { blocked = /foreign key|violates/i.test(e.message); }
  check('a membership pairing another company\'s user is REJECTED by the database', blocked);

  console.log('\n=== J. 020 is re-runnable and additive-only ===');
  await q(readFileSync(join(REPO, 'migrations/020_team_lifecycle.sql'), 'utf8'));
  check('020 applies a second time without error', true);
  const src = readFileSync(join(REPO, 'migrations/020_team_lifecycle.sql'), 'utf8');
  const destructive = src.match(/^\s*(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|ALTER\s+COLUMN)/gim);
  check('contains no DROP TABLE / DROP COLUMN / TRUNCATE / ALTER COLUMN',
    !destructive, (destructive ?? []).join(' '));
  check('contains no DELETE of existing rows', !/^\s*DELETE\s+FROM/mi.test(src));
  const alters = [...src.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
  check('every column change is ADD COLUMN IF NOT EXISTS (6 expected)',
    alters.length === 6, `${alters.length}: ${alters.join(', ')}`);
  // team_members.tenant_id must have NO default: a default would rewrite every
  // existing row at ALTER time instead of through the explicit, auditable
  // backfill below it.
  const tenantColLine = src.split('\n').find((l) => l.includes('team_members ADD COLUMN IF NOT EXISTS tenant_id'));
  check('team_members.tenant_id is added WITHOUT a default (no silent rewrite)',
    tenantColLine !== undefined && !/DEFAULT/.test(tenantColLine), tenantColLine);
} catch (e) {
  failures.push(`fatal: ${e.code} ${e.message}`);
  console.error('\nfatal:', e.code, e.message);
} finally {
  await c.end().catch(() => {});
}

console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);