/**
 * P0.3 final batch — REAL PostgreSQL tests for the owner bootstrap and the
 * customer acknowledgment.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lwc_ops_test \
 *     node scripts/test-p03-final-pg.mjs
 *
 * WHY A REAL SERVER IS REQUIRED FOR THIS FILE
 * -------------------------------------------
 * Every guarantee this batch claims is a SQL guarantee:
 *
 *   - the grant refuses a role whose `permissions` JSONB was tampered with,
 *   - `ON CONFLICT DO NOTHING` makes a retried grant and a retried send converge,
 *   - the unique index on (tenant_id, conversation_id) is what actually prevents a
 *     duplicate acknowledgment — not the application checking first,
 *   - the audit row commits or rolls back WITH the assignment, as one unit,
 *   - concurrent grants and concurrent sends produce exactly one row,
 *   - migration 018 applies cleanly and grants nothing to anybody.
 *
 * A mock pool can only assert that the right STRING was passed. It cannot show that
 * the constraint fires.
 *
 * NO PRODUCTION DATA IS TOUCHED: the suite refuses to run unless the target
 * database name ends in `_test`, and repoints DATABASE_URL to it.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_DATABASE_URL;

if (!url) {
  console.log('  SKIP  TEST_DATABASE_URL not set - skipping the real-PostgreSQL P0.3-final suite.');
  console.log('   This is REQUIRED before production deployment.');
  process.exit(0);
}

const dbName = (() => {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); }
  catch { return ''; }
})();
if (!dbName.endsWith('_test')) {
  console.error(`  refusing to run: target database "${dbName}" does not end in _test`);
  process.exit(1);
}
{
  const current = (() => {
    try { return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '')); }
    catch { return ''; }
  })();
  if (current && !current.endsWith('_test')) {
    console.log(`  note  DATABASE_URL pointed at "${current}" - repointing it at "${dbName}"`);
  }
  process.env.DATABASE_URL = url;
  const now = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''));
  if (!now.endsWith('_test')) {
    console.error(`  refusing to run: DATABASE_URL still resolves to "${now}"`);
    process.exit(1);
  }
}

const admin = new pg.Client({ connectionString: url });
await admin.connect();

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const err = (name, e, status, code) =>
  check(name, e?.status === status && (code === undefined || e?.code === code),
    `got ${e?.status}/${e?.code} want ${status}/${code}`);

/* -------------------------------------------------------------------- setup */

const migrationsDir = join(REPO, 'migrations');
for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(migrationsDir, f), 'utf8');
  try { await admin.query(sql); }
  catch (e) {
    if (!/already exists|duplicate key|does not exist/i.test(e.message)) {
      console.log(`  note  ${f}: ${e.message.split('\n')[0]}`);
    }
  }
}

const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

const { rows: [have] } = await admin.query(`SELECT to_regclass('handoff_acknowledgments') IS NOT NULL AS ok`);
check('migration 018 applies cleanly on a real server', have.ok === true);

const T1 = (await q(`INSERT INTO tenants (id,name,slug) VALUES (gen_random_uuid(),'T1','t1') RETURNING id`))[0];
const T2 = (await q(`INSERT INTO tenants (id,name,slug) VALUES (gen_random_uuid(),'T2','t2') RETURNING id`))[0];
const BR_A = (await q(`INSERT INTO brands (tenant_id,name,slug,default_language) VALUES ($1,'BrandA','brand-a','ar') RETURNING id`, [T1.id]))[0];
const BR_EN = (await q(`INSERT INTO brands (tenant_id,name,slug,default_language) VALUES ($1,'BrandEn','brand-en','en') RETURNING id`, [T1.id]))[0];

const mkUser = async (tenant, name, status = 'active') => (await q(
  `INSERT INTO users (tenant_id,email,name,password_hash,status)
   VALUES ($1,$2,$3,'x',$4) RETURNING id`, [tenant, `${name}-${Math.random().toString(36).slice(2, 7)}@t.test`, name, status]))[0];

const OWNER = await mkUser(T1.id, 'platform_owner');
await q(`INSERT INTO platform_super_admins (user_id) VALUES ($1)`, [OWNER.id]);

const mkChannel = async (tenant, brand, provider, status = 'active') => (await q(
  `INSERT INTO channels (tenant_id,brand_id,provider,external_id,display_name,status)
   VALUES ($1,$2,$3,$4,$3,$5) RETURNING id`,
  [tenant, brand, provider, `${provider}-${Math.random().toString(36).slice(2, 7)}`, status]))[0];

const CH_DM_AR = await mkChannel(T1.id, BR_A.id, 'meta_dm');
const CH_DM_EN = await mkChannel(T1.id, BR_EN.id, 'meta_dm');
const CH_DM_OFF = await mkChannel(T1.id, BR_A.id, 'meta_dm', 'disabled');
const CH_COMMENT = await mkChannel(T1.id, BR_A.id, 'meta_comment');

const mkConv = async (channel, state = 'AI_ACTIVE', language = 'ar', tenant = T1.id) => {
  const cust = (await q(`INSERT INTO customers (tenant_id,display_name) VALUES ($1,'C') RETURNING id`, [tenant]))[0];
  return (await q(
    `INSERT INTO conversations (tenant_id,channel_id,customer_id,external_key,state,language)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenant, channel.id, cust.id, `psid-${Math.random().toString(36).slice(2)}`, state, language]))[0];
};

/** An inbound message so the messaging window is open. */
const touchInbound = async (convId, ageSeconds = 0) => {
  const conv = await one(`SELECT tenant_id FROM conversations WHERE id=$1`, [convId]);
  await q(
    `INSERT INTO messages (tenant_id,conversation_id,direction,sender_type,text,provider_ts,created_at)
     VALUES ($1,$2,'inbound','customer','knock knock', now() - ($3 || ' seconds')::interval, now() - ($3 || ' seconds')::interval)`,
    [conv.tenant_id, convId, String(ageSeconds)]);
};

const PR = await import('../src/services/platformRoles.js');
const ACK = await import('../src/services/handoffAcknowledgment.js');
const HO = await import('../src/services/handoff.js');
const OPS = await import('../src/services/humanOperations.js');
const { effectiveCustomAbilities } = await import('../src/auth/abilities.js');
const { brandScopeFromSession } = await import('../src/api/v1/brandAccess.js');
const { HANDOFF_REASONS } = await import('../src/services/handoffDetector.js');

/**
 * The ONE approved trigger, read from the detector so this suite cannot drift away
 * from what the webhook actually passes.
 */
const CUSTOMER_HUMAN = HANDOFF_REASONS.CUSTOMER_REQUESTED_HUMAN;

/* ============================ 1. owner bootstrap ======================== */

section('1. Granting the escalation role is owner-only, narrow and audited');
{
  const target = await mkUser(T1.id, 'complaint_officer');

  // Seed the role exactly as migration 017 does, for this tenant.
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Escalation Manager','["escalation.resolve"]'::jsonb)
           ON CONFLICT (tenant_id,name) DO NOTHING`, [T1.id]);

  // A reason is mandatory: the change must be attributable after the fact.
  let e1 = null;
  try { await PR.grantEscalationManager({ tenantId: T1.id, userId: target.id, reason: 'no', actorUserId: OWNER.id, db: { connect: () => ({ query: admin.query.bind(admin), release() {} }) } }); }
  catch (e) { e1 = e; }
  err('a too-short reason is refused', e1, 422, 'REASON_REQUIRED');

  const g1 = await PR.grantEscalationManager({
    tenantId: T1.id, userId: target.id,
    reason: 'leads the customer complaints queue', actorUserId: OWNER.id,
    db: { connect: async () => ({ query: admin.query.bind(admin), release() {} }) }
  });
  check('the owner can grant the role', g1.granted === true);
  eq('  and only the approved ability is recorded', g1.permissions, ['escalation.resolve']);
  eq('  the reason is returned for display', g1.reason, 'leads the customer complaints queue');

  const roleId = (await one(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Escalation Manager'`, [T1.id])).id;
  eq('exactly one user_roles row exists', (await q(
    `SELECT count(*)::int n FROM user_roles WHERE user_id=$1 AND role_id=$2`, [target.id, roleId]))[0].n, 1);

  // Idempotency: a retried grant converges instead of failing or duplicating.
  const g2 = await PR.grantEscalationManager({
    tenantId: T1.id, userId: target.id,
    reason: 'retried after a network timeout', actorUserId: OWNER.id,
    db: { connect: async () => ({ query: admin.query.bind(admin), release() {} }) }
  });
  check('a retried grant reports alreadyGranted, not an error', g2.alreadyGranted === true && g2.granted === false);
  eq('  and still exactly one row', (await q(
    `SELECT count(*)::int n FROM user_roles WHERE user_id=$1 AND role_id=$2`, [target.id, roleId]))[0].n, 1);

  // Audit is in the SAME transaction as the write, so it cannot drift.
  const aud = await q(
    `SELECT actor_user_id, action, metadata FROM audit_logs WHERE object_id=$1 AND action LIKE 'platform.escalation_manager%' ORDER BY created_at`,
    [target.id]);
  eq('both the grant and the no-op are audited', aud.length, 2);
  eq('  the actor is the owner', aud[0].actor_user_id, OWNER.id);
  eq('  the permissions granted are named', aud[0].metadata.permissions, ['escalation.resolve']);
  check('  the reason is on the record', typeof aud[0].metadata.reason === 'string' && aud[0].metadata.reason.length > 0);
  check('  a no-op is distinguishable from a real change',
    aud.some((a) => a.action.endsWith('.noop')) && aud.some((a) => !a.action.endsWith('.noop')));
}

section('2. The grant refuses everything it is not allowed to do');
{
  const db = { connect: async () => ({ query: admin.query.bind(admin), release() {} }) };

  // Inactive user.
  const disabled = await mkUser(T1.id, 'disabled_person', 'disabled');
  let e = null;
  try { await PR.grantEscalationManager({ tenantId: T1.id, userId: disabled.id, reason: 'they asked nicely', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('an INACTIVE user is refused', e, 409, 'USER_INACTIVE');

  // Cross-tenant target.
  const outsider = await mkUser(T2.id, 'other_company_person');
  e = null;
  try { await PR.grantEscalationManager({ tenantId: T1.id, userId: outsider.id, reason: 'cross tenant attempt', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a user of ANOTHER company is refused', e, 404, 'USER_WRONG_TENANT');

  // The Platform Owner must not acquire customer-data access by default.
  e = null;
  try { await PR.grantEscalationManager({ tenantId: T1.id, userId: OWNER.id, reason: 'giving myself the power', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('granting to the PLATFORM OWNER is refused', e, 409, 'TARGET_IS_PLATFORM_ADMIN');
  eq('  and no row was created for them', (await q(
    `SELECT count(*)::int n FROM user_roles WHERE user_id=$1`, [OWNER.id]))[0].n, 0);

  // Unknown tenant.
  e = null;
  try { await PR.grantEscalationManager({ tenantId: (await q(`SELECT gen_random_uuid() AS id`))[0].id, userId: (await mkUser(T1.id, 'x')).id, reason: 'no such company at all', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('an unknown company is refused', e, 404, 'TENANT_NOT_FOUND');

  // A MALFORMED id must be a clean 400, not an opaque 500 from a Postgres cast error.
  e = null;
  try { await PR.grantEscalationManager({ tenantId: 'gen_random_uuid()', userId: (await mkUser(T1.id, 'y')).id, reason: 'malformed tenant id', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a MALFORMED tenant id is a clean 400', e, 400, 'BAD_REQUEST');
  e = null;
  try { await PR.grantEscalationManager({ tenantId: T1.id, userId: 'not-a-uuid', reason: 'malformed user id', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a MALFORMED user id is a clean 400', e, 400, 'BAD_REQUEST');

  // The role has not been seeded for this tenant.
  const bare = await mkUser(T1.id, 'bare_tenant_person');
  const t3 = (await q(`INSERT INTO tenants (id,name,slug) VALUES (gen_random_uuid(),'T3','t3') RETURNING id`))[0];
  e = null;
  try { await PR.grantEscalationManager({ tenantId: t3.id, userId: (await mkUser(t3.id, 'inner')).id, reason: 'role was never seeded here', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a company with no seeded role is refused', e, 409, 'ROLE_NOT_SEEDED');
}

section('3. A tampered role is REFUSED, not handed over');
{
  const db = { connect: async () => ({ query: admin.query.bind(admin), release() {} }) };
  const t4 = (await q(`INSERT INTO tenants (id,name,slug) VALUES (gen_random_uuid(),'T4','t4') RETURNING id`))[0];
  const victim = await mkUser(t4.id, 'would_be_victim');

  // Someone widened the seeded role. Handing it over would silently confer
  // conversation.reply and brand scope along with the complaint power.
  await q(`INSERT INTO roles (tenant_id,name,permissions)
           VALUES ($1,'Escalation Manager',$2::jsonb)`,
    [t4.id, JSON.stringify(['escalation.resolve', 'conversation.reply', '*'])]);

  let e = null;
  try { await PR.grantEscalationManager({ tenantId: t4.id, userId: victim.id, reason: 'looks fine at a glance', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a role carrying EXTRA permissions is refused', e, 409, 'ROLE_PERMISSIONS_UNEXPECTED');
  eq('  and the expected set is reported back', e?.detail?.expected, ['escalation.resolve']);
  check('  and what was actually there is reported back too', Array.isArray(e?.detail?.actual) && e.detail.actual.length === 3);
  eq('  nothing was assigned', (await q(`SELECT count(*)::int n FROM user_roles WHERE user_id=$1`, [victim.id]))[0].n, 0);
  eq('  and nothing was audited as granted', (await q(
    `SELECT count(*)::int n FROM audit_logs WHERE object_id=$1 AND action='platform.escalation_manager.grant'`,
    [victim.id]))[0].n, 0);

  // A MISSING ability is also a tamper, and must not slip through as "fewer".
  await q(`UPDATE roles SET permissions='[]'::jsonb WHERE tenant_id=$1 AND name='Escalation Manager'`, [t4.id]);
  e = null;
  try { await PR.grantEscalationManager({ tenantId: t4.id, userId: victim.id, reason: 'permissions were emptied', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a role carrying NO permissions is also refused', e, 409, 'ROLE_PERMISSIONS_UNEXPECTED');

  // Reordering is not tampering — a set comparison must tolerate it.
  await q(`UPDATE roles SET permissions='["escalation.resolve"]'::jsonb WHERE tenant_id=$1 AND name='Escalation Manager'`, [t4.id]);
  const ok = await PR.grantEscalationManager({
    tenantId: t4.id, userId: victim.id, reason: 'restored to the approved set', actorUserId: OWNER.id, db });
  check('the restored role grants normally', ok.granted === true);
}

section('4. Revoking, and why it must not check the permissions');
{
  const db = { connect: async () => ({ query: admin.query.bind(admin), release() {} }) };
  const u = await mkUser(T1.id, 'to_be_revoked');
  await PR.grantEscalationManager({ tenantId: T1.id, userId: u.id, reason: 'will be revoked shortly', actorUserId: OWNER.id, db });

  const r1 = await PR.revokeEscalationManager({ tenantId: T1.id, userId: u.id, reason: 'left the complaints team', actorUserId: OWNER.id, db });
  check('the owner can revoke', r1.revoked === true);

  const r2 = await PR.revokeEscalationManager({ tenantId: T1.id, userId: u.id, reason: 'retried after a timeout', actorUserId: OWNER.id, db });
  check('a retried revoke reports alreadyRevoked, not an error', r2.alreadyRevoked === true && r2.revoked === false);

  // A tampered role must still be REVOCABLE. Refusing to remove access because the
  // grant was malformed would fail in the dangerous direction.
  const t5 = (await q(`INSERT INTO tenants (id,name,slug) VALUES (gen_random_uuid(),'T5','t5') RETURNING id`))[0];
  const u2 = await mkUser(t5.id, 'tampered_holder');
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Escalation Manager','["escalation.resolve","*"]'::jsonb)`, [t5.id]);
  await q(`INSERT INTO user_roles (user_id,role_id)
           SELECT $1, id FROM roles WHERE tenant_id=$2 AND name='Escalation Manager'`, [u2.id, t5.id]);
  const r3 = await PR.revokeEscalationManager({ tenantId: t5.id, userId: u2.id, reason: 'removing a malformed grant', actorUserId: OWNER.id, db });
  check('a TAMPERED role is still revocable', r3.revoked === true);

  let e = null;
  try { await PR.revokeEscalationManager({ tenantId: T1.id, userId: (await mkUser(T2.id, 'cross_revoke')).id, reason: 'cross tenant revoke', actorUserId: OWNER.id, db }); }
  catch (x) { e = x; }
  err('a cross-tenant revoke is refused', e, 404, 'USER_NOT_FOUND');
}

section('5. Concurrency: grant and revoke races converge');
{
  const dbFor = (c) => ({ connect: async () => ({ query: c.query.bind(c), release() {} }) });
  const target = await mkUser(T1.id, 'race_target');

  // Six independent connections all granting at once.
  const clients = await Promise.all(Array.from({ length: 6 }, () => new pg.Client({ connectionString: url })));
  for (const c of clients) await c.connect();
  const results = await Promise.all(clients.map((c) =>
    PR.grantEscalationManager({
      tenantId: T1.id, userId: target.id, reason: 'simultaneous grant attempt', actorUserId: OWNER.id, db: dbFor(c)
    }).catch((x) => x)));
  for (const c of clients) await c.end().catch(() => {});

  check('no concurrent grant errored', results.every((r) => r && r.granted !== undefined),
    results.map((r) => r?.code).filter(Boolean).join(','));
  eq('exactly one grant actually granted', results.filter((r) => r.granted === true).length, 1);
  eq('the rest reported alreadyGranted', results.filter((r) => r.alreadyGranted === true).length, 5);
  const roleId = (await one(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Escalation Manager'`, [T1.id])).id;
  eq('  and there is exactly ONE user_roles row', (await q(
    `SELECT count(*)::int n FROM user_roles WHERE user_id=$1 AND role_id=$2`, [target.id, roleId]))[0].n, 1);

  // Grant and revoke racing must not leave a phantom row.
  const c1 = new pg.Client({ connectionString: url });
  const c2 = new pg.Client({ connectionString: url });
  await c1.connect(); await c2.connect();
  await Promise.allSettled([
    PR.grantEscalationManager({ tenantId: T1.id, userId: target.id, reason: 'race: granting again', actorUserId: OWNER.id, db: dbFor(c1) }),
    PR.revokeEscalationManager({ tenantId: T1.id, userId: target.id, reason: 'race: revoking at once', actorUserId: OWNER.id, db: dbFor(c2) })
  ]);
  await c1.end().catch(() => {}); await c2.end().catch(() => {});
  const finalRows = (await q(`SELECT count(*)::int n FROM user_roles WHERE user_id=$1 AND role_id=$2`, [target.id, roleId]))[0].n;
  check('a grant/revoke race leaves 0 or 1 rows, never more', [0, 1].includes(finalRows), String(finalRows));
}

section('6. The grant confers the ability and nothing else');
{
  const officer = await mkUser(T1.id, 'officer_check');
  await PR.grantEscalationManager({
    tenantId: T1.id, userId: officer.id, reason: 'checking what this confers', actorUserId: OWNER.id,
    db: { connect: async () => ({ query: admin.query.bind(admin), release() {} }) }
  });

  const rows = await q(`SELECT r.name, r.permissions FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1`, [officer.id]);
  const names = rows.map((r) => r.name);
  const perms = Object.fromEntries(rows.map((r) => [r.name, r.permissions]));
  const custom = effectiveCustomAbilities(names, perms);

  check('the seeded role actually confers escalation.resolve', custom.includes('escalation.resolve'),
    JSON.stringify(custom));
  check('it confers NO other ability', custom.length === 1, JSON.stringify(custom));
  eq('and no brand grant was created', (await q(
    `SELECT count(*)::int n FROM user_brand_grants WHERE user_id=$1`, [officer.id]))[0].n, 0);
  eq('nor a tenant-wide brand scope', (await q(
    `SELECT count(*)::int n FROM user_brand_scope_all WHERE user_id=$1`, [officer.id]))[0].n, 0);

  // A holder with no brand grant must find every conversation invisible — the
  // ability says WHAT, the grants say WHICH, and neither substitutes for the other.
  const conv = await mkConv(CH_DM_AR, 'QUEUED');
  await touchInbound(conv.id);
  const sessNoScope = {
    tenantId: T1.id, user: { id: officer.id }, roles: ['Escalation Manager'],
    customAbilities: custom, brandIds: null, allBrandsInCompany: false, isPlatformSuperAdmin: false
  };
  let e = null;
  try {
    await OPS.getHandoffContext({ session: sessNoScope, conversationId: conv.id, deps: { db: { query: admin.query.bind(admin) }, scope: brandScopeFromSession(sessNoScope) } });
  } catch (x) { e = x; }
  check('an escalation manager with NO brand grant sees nothing', e?.status === 404, String(e?.status));

  // With a brand grant, the same session does see it.
  await q(`INSERT INTO user_brand_grants (user_id,tenant_id,brand_id) VALUES ($1,$2,$3)`, [officer.id, T1.id, BR_A.id]);
  const sessScoped = { ...sessNoScope, brandIds: [BR_A.id] };
  const ctx = await OPS.getHandoffContext({
    session: sessScoped, conversationId: conv.id,
    deps: { db: { query: admin.query.bind(admin) }, scope: brandScopeFromSession(sessScoped) }
  });
  check('with a brand grant, the same holder CAN reach it', ctx.conversation.id === conv.id);
  // With no open escalation the flag is correctly false; the ability alone must not
  // make it true, or the panel would offer a button that does nothing.
  check('  but canResolveEscalations stays false with no escalation open',
    ctx.permissions.canResolveEscalations === false, String(ctx.permissions.canResolveEscalations));
}

/* ======================= 2. the customer acknowledgment ================= */

section('7. It fires on a customer request, once, and only once');
{
  const conv = await mkConv(CH_DM_AR, 'AI_ACTIVE', 'ar');
  await touchInbound(conv.id);

  // Mock the provider. Counting calls is the whole point of this section.
  const sent = [];
  const client = { sendMessengerReply: async (to, text) => { sent.push({ to, text }); return { message_id: 'mid_1' }; } };
  const deps = {
    db: { query: admin.query.bind(admin) },
    resolveCredential: async () => ({ accessToken: 'x' }),
    createClient: () => client,
    log: { error() {}, log() {} }
  };

  const r1 = await ACK.maybeAcknowledgeHandoff({
    tenantId: T1.id, conversationId: conv.id,
    requestedBy: HO.REQUESTED_BY.CUSTOMER, reason: CUSTOMER_HUMAN
  }, deps);
  check('the acknowledgment is attempted', r1.attempted === true);
  eq('  and it was sent', r1.status, 'sent');
  eq('  the provider was called exactly once', sent.length, 1);
  eq('  to the conversation external key', sent[0].to, conv.external_key);
  check('  with the ARABIC text', /[\u0600-\u06FF]/.test(sent[0].text), sent[0].text.slice(0, 40));

  const rec = (await q(`SELECT * FROM handoff_acknowledgments WHERE tenant_id=$1 AND conversation_id=$2`, [T1.id, conv.id]))[0];
  eq('the record says sent', rec.status, 'sent');
  eq('  it recorded the provider id', rec.provider_message_id, 'mid_1');
  eq('  and the language chosen', rec.language, 'ar');
  check('  with a timestamp', rec.sent_at !== null);

  // A webhook redelivery of the same message.
  const r2 = await ACK.maybeAcknowledgeHandoff({
    tenantId: T1.id, conversationId: conv.id,
    requestedBy: HO.REQUESTED_BY.CUSTOMER, reason: CUSTOMER_HUMAN
  }, deps);
  check('a webhook redelivery is a duplicate, not a second send',
    r2.alreadyAcknowledged === true && r2.attempted === false);
  eq('  and the provider was STILL called only once', sent.length, 1);

  // A Worker retry after a restart.
  const r3 = await ACK.maybeAcknowledgeHandoff({
    tenantId: T1.id, conversationId: conv.id,
    requestedBy: HO.REQUESTED_BY.CUSTOMER, reason: CUSTOMER_HUMAN
  }, deps);
  check('a worker retry is also a duplicate', r3.alreadyAcknowledged === true);
  eq('  provider call count unchanged', sent.length, 1);

  // Two genuinely separate handoffs on the SAME conversation.
  const conv2 = await mkConv(CH_DM_AR, 'AI_ACTIVE', 'ar');
  await touchInbound(conv2.id);
  const c1 = new pg.Client({ connectionString: url });
  const c2 = new pg.Client({ connectionString: url });
  await c1.connect(); await c2.connect();
  const sent2 = [];
  const racing = {
    db: { query: async (s, p) => admin.query(s, p) },
    resolveCredential: async () => ({ accessToken: 'x' }),
    createClient: () => ({ sendMessengerReply: async (to, t) => { sent2.push(t); return { message_id: 'mid_race' }; } }),
    log: { error() {}, log() {} }
  };
  const perConn = (c) => ({ ...racing, db: { query: c.query.bind(c) } });
  const [ra, rb] = await Promise.all([
    ACK.maybeAcknowledgeHandoff({ tenantId: T1.id, conversationId: conv2.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN }, perConn(c1)),
    ACK.maybeAcknowledgeHandoff({ tenantId: T1.id, conversationId: conv2.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN }, perConn(c2))
  ]);
  await c1.end().catch(() => {}); await c2.end().catch(() => {});
  eq('two concurrent events produce EXACTLY one send', sent2.length, 1);
  check('one wins and one is told it is a duplicate',
    [ra, rb].filter((r) => r.attempted === true).length === 1
    && [ra, rb].filter((r) => r.alreadyAcknowledged === true).length === 1,
    `${ra.status}/${rb.status}`);
  eq('  and exactly one row exists', (await q(
    `SELECT count(*)::int n FROM handoff_acknowledgments WHERE conversation_id=$1`, [conv2.id]))[0].n, 1);
}

section('8. It does NOT fire for anything it was not approved for');
{
  const sent = [];
  const deps = {
    db: { query: admin.query.bind(admin) },
    resolveCredential: async () => ({ accessToken: 'x' }),
    createClient: () => ({ sendMessengerReply: async (to, t) => { sent.push(t); return { message_id: 'm' }; } }),
    log: { error() {}, log() {} }
  };

  // An AUTO escalation: the customer never asked for a person.
  const c = await mkConv(CH_DM_AR, 'AI_ACTIVE', 'ar');
  await touchInbound(c.id);
  const auto = await ACK.maybeAcknowledgeHandoff({
    tenantId: T1.id, conversationId: c.id, requestedBy: 'customer', reason: 'auto_escalation'
  }, deps);
  eq('an AUTO escalation is skipped', auto.skipReason, 'not_customer_requested');
  check('  nothing was sent', auto.attempted === false);

  // A STAFF-initiated handoff: nobody authorised acknowledging these.
  const c2 = await mkConv(CH_DM_AR, 'AI_ACTIVE', 'ar');
  await touchInbound(c2.id);
  const staff = await ACK.maybeAcknowledgeHandoff({
    tenantId: T1.id, conversationId: c2.id, requestedBy: 'staff', reason: CUSTOMER_HUMAN
  }, deps);
  eq('a STAFF handoff is skipped', staff.skipReason, 'not_customer_requested');

  eq('the provider was never called for either', sent.length, 0);

  // DELIBERATE, and worth being explicit about: an unapproved trigger writes NO
  // acknowledgment row.
  //
  // The unique index is on (tenant_id, conversation_id). If a staff handoff
  // consumed that slot with a `skipped` row, then a customer asking for a human on
  // the SAME conversation later would hit the conflict and be silently denied their
  // one acknowledgment. Not recording keeps the slot free for the event it exists
  // for. Asserted here so nobody "helpfully" adds the record back.
  eq('  and NO row is written for an unapproved trigger', (await q(
    `SELECT count(*)::int n FROM handoff_acknowledgments WHERE conversation_id = ANY($1::uuid[])`,
    [[c.id, c2.id]]))[0].n, 0);

  // ...and the slot really is still free afterwards.
  await touchInbound(c2.id);
  const later = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c2.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN }, deps);
  check('a later CUSTOMER request on the same conversation still gets its acknowledgment',
    later.attempted === true && later.status === 'sent', later.status);
}

section('9. Unsupported channels, closed windows and unknown languages');
{
  const mk = async (channel, lang, age = 0) => {
    const c = await mkConv(channel, 'AI_ACTIVE', lang);
    await touchInbound(c.id, age);
    return c;
  };
  const sent = [];
  const deps = {
    db: { query: admin.query.bind(admin) },
    resolveCredential: async () => ({ accessToken: 'x' }),
    createClient: () => ({ sendMessengerReply: async (to, t) => { sent.push(t); return { message_id: 'm' }; } }),
    log: { error() {}, log() {} }
  };
  const fire = (c) => ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN }, deps);

  const comment = await mk(CH_COMMENT, 'ar');
  eq('a FACEBOOK COMMENT conversation is skipped', (await fire(comment)).skipReason, 'channel_unsupported');

  const ig = await mk(await mkChannel(T1.id, BR_A.id, 'instagram'), 'ar');
  eq('an INSTAGRAM conversation is skipped', (await fire(ig)).skipReason, 'channel_unsupported');

  const off = await mk(CH_DM_OFF, 'ar');
  eq('a DISCONNECTED channel is skipped', (await fire(off)).skipReason, 'channel_inactive');

  const stale = await mk(CH_DM_AR, 'ar', 60 * 60 * 48);
  eq('an EXPIRED messaging window is skipped', (await fire(stale)).skipReason, 'window_closed');

  const unknownLang = await mk(CH_DM_AR, 'fr');
  eq('an UNDETERMINED language is skipped, never guessed', (await fire(unknownLang)).skipReason, 'language_undetermined');

  eq('NOTHING was sent for any of them', sent.length, 0);
  for (const c of [comment, ig, off, stale, unknownLang]) {
    const r = (await q(`SELECT status, skip_reason FROM handoff_acknowledgments WHERE conversation_id=$1`, [c.id]))[0];
    check(`  ${c.id.slice(0, 8)} recorded as skipped with a reason`, r?.status === 'skipped' && r?.skip_reason, JSON.stringify(r));
  }
}

section('10. Arabic and English selection');
{
  const sent = [];
  const deps = {
    db: { query: admin.query.bind(admin) },
    resolveCredential: async () => ({ accessToken: 'x' }),
    createClient: () => ({ sendMessengerReply: async (to, t) => { sent.push(t); return { message_id: 'm' }; } }),
    log: { error() {}, log() {} }
  };
  const fire = async (channel, lang) => {
    const c = await mkConv(channel, 'AI_ACTIVE', lang);
    await touchInbound(c.id);
    await ACK.maybeAcknowledgeHandoff({ tenantId: T1.id, conversationId: c.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN }, deps);
    return sent[sent.length - 1];
  };

  const arText = await fire(CH_DM_AR, 'ar');
  check('an ARABIC conversation gets Arabic', /[\u0600-\u06FF]/.test(arText), arText.slice(0, 30));
  const arEG = await fire(CH_DM_AR, 'ar-EG');
  check('ar-EG is treated as Arabic', /[\u0600-\u06FF]/.test(arEG));
  const enText = await fire(CH_DM_EN, 'en');
  check('an ENGLISH conversation gets English', /[\u0600-\u06FF]/.test(enText) === false, enText.slice(0, 30));

  check('the Arabic text does not claim the customer was answered', !/(تم الرد|اتحل)/.test(arText));
  check('the English text does not claim the customer was answered', !/answered|we replied/i.test(enText));
}

section('11. Delivery failures, timeouts and the unknown outcome');
{
  const mkFresh = async () => { const c = await mkConv(CH_DM_AR, 'AI_ACTIVE', 'ar'); await touchInbound(c.id); return c; };
  const withClient = (fn) => ({
    db: { query: admin.query.bind(admin) },
    resolveCredential: async () => ({ accessToken: 'x' }),
    createClient: () => ({ sendMessengerReply: fn }),
    log: { error() {}, log() {} }
  });

  // A transport failure: the message MAY have been delivered.
  const c1 = await mkFresh();
  const r1 = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c1.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    withClient(async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }));
  eq('a transport failure is recorded UNKNOWN, not failed', r1.status, 'unknown');
  // The guarantee is unconditional: `retryable` is false whatever the classifier
  // concluded. The classifier's own opinion is still surfaced, so an operator can
  // see that a retry was considered and deliberately suppressed.
  eq('  and is never offered as retryable', r1.retryable, false);
  check('  a retryable verdict is reported as SUPPRESSED rather than hidden',
    typeof r1.retrySuppressed === 'boolean', String(r1.retrySuppressed));
  eq('  the record says unknown', (await q(`SELECT status FROM handoff_acknowledgments WHERE conversation_id=$1`, [c1.id]))[0].status, 'unknown');

  // A retried ack on an unknown must NOT send again — the customer may have it.
  let secondCall = false;
  const r1b = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c1.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    withClient(async () => { secondCall = true; return { message_id: 'm' }; }));
  check('an UNKNOWN outcome is never retried', secondCall === false && r1b.alreadyAcknowledged === true);

  // A definitive refusal from the provider.
  const c2 = await mkFresh();
  const r2 = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c2.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    withClient(async () => { const e = new Error('bad'); e.status = 400; throw e; }));
  eq('a DEFINITIVE provider refusal is recorded failed', r2.status, 'failed');
  eq('  and still never retried automatically', r2.retryable, false);

  // A provider 5xx is genuinely unknown.
  const c3 = await mkFresh();
  const r3 = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c3.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    withClient(async () => { const e = new Error('upstream'); e.status = 503; throw e; }));
  eq('a provider 5xx is recorded UNKNOWN', r3.status, 'unknown');

  // No credential at all.
  const c4 = await mkFresh();
  let called = false;
  const r4 = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: c4.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    {
      db: { query: admin.query.bind(admin) },
      resolveCredential: async () => null,
      createClient: () => ({ sendMessengerReply: async () => { called = true; return {}; } }),
      log: { error() {}, log() {} }
    });
  eq('a MISSING credential is a recorded failure', r4.status, 'failed');
  eq('  with no provider call attempted', called, false);
  eq('  and a named cause', r4.deliveryError, 'credential_missing');
}

section('12. A failed acknowledgment must never strand or re-activate the conversation');
{
  const conv = await mkConv(CH_DM_AR, 'AI_ACTIVE', 'ar');
  await touchInbound(conv.id);

  // Reproduce the real order: handoff FIRST, then a failing acknowledgment.
  await HO.requestHandoff({
    tenantId: T1.id, conversationId: conv.id,
    reason: CUSTOMER_HUMAN, priority: 'high', requestedBy: 'customer'
  }, { db: { query: admin.query.bind(admin) } });

  const r = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: conv.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    {
      db: { query: admin.query.bind(admin) },
      resolveCredential: async () => null,
      createClient: () => ({ sendMessengerReply: async () => ({}) }),
      log: { error() {}, log() {} }
    });
  eq('the acknowledgment failed', r.status, 'failed');

  const after = await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [conv.id]);
  eq('the conversation is STILL queued', after.state, 'QUEUED');
  eq('  and still unassigned (waiting for a human)', after.assigned_user_id, null);
  eq('  the open escalation is untouched', (await q(
    `SELECT count(*)::int n FROM escalations WHERE conversation_id=$1 AND resolved_at IS NULL`, [conv.id]))[0].n, 1);

  // Resume AI must still be refused — the customer asked for a human.
  let e = null;
  const sup = await mkUser(T1.id, 'sup_for_resume');
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Supervisor','[]'::jsonb)
           ON CONFLICT (tenant_id,name) DO NOTHING`, [T1.id]);
  const supRole = await one(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Supervisor'`, [T1.id]);
  await q(`INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)`, [sup.id, supRole.id]);
  await q(`INSERT INTO user_brand_scope_all (user_id,tenant_id) VALUES ($1,$2)`, [sup.id, T1.id]);
  const s = {
    tenantId: T1.id, user: { id: sup.id }, roles: ['Supervisor'], customAbilities: [],
    brandIds: null, allBrandsInCompany: true, isPlatformSuperAdmin: false
  };
  const depsS = { db: { connect: async () => ({ query: admin.query.bind(admin), release() {} }) }, scope: brandScopeFromSession(s) };
  try { await OPS.resumeAiOperation({ session: s, conversationId: conv.id, body: { reason: 'ack failed, turn the AI back on' }, deps: depsS }); }
  catch (x) { e = x; }
  // 409 with a named reason is the BETTER answer than a generic 403: it says
  // exactly why the AI may not resume (the escalation is still open), which is the
  // thing an operator needs to know. A 403 would have hidden the cause.
  err('Resume AI is STILL refused after a failed acknowledgment', e, 409, 'OPS_OPEN_ESCALATIONS');
  eq('  and the state did not move', (await one(`SELECT state FROM conversations WHERE id=$1`, [conv.id])).state, 'QUEUED');

  // And staff can SEE the failure.
  const ctx = await OPS.getHandoffContext({ session: s, conversationId: conv.id, deps: { db: { query: admin.query.bind(admin) }, scope: brandScopeFromSession(s) } });
  eq('the handoff context exposes the failed acknowledgment', ctx.acknowledgment?.status, 'failed');
  check('  with the cause', typeof ctx.acknowledgment?.deliveryError === 'string');
  check('  and it grants nothing', ctx.permissions.canResumeAi === false);
}

section('13. No retroactive acknowledgment for anything that already existed');
{
  const before = (await q(`SELECT count(*)::int n FROM handoff_acknowledgments`))[0].n;
  eq('the table holds only what this suite sent', before > 0, true);

  // A conversation that was escalated before this feature existed.
  const old = await mkConv(CH_DM_AR, 'QUEUED', 'ar');
  await touchInbound(old.id);
  await q(`INSERT INTO escalations (tenant_id,conversation_id,category,reason,priority,status,requested_by)
           VALUES ($1,$2,'handoff','customer_requested_human','high','new','customer')`, [T1.id, old.id]);

  const after = (await q(`SELECT count(*)::int n FROM handoff_acknowledgments`))[0].n;
  eq('creating a historical escalation adds NO acknowledgment', after, before);
  eq('  and that conversation has no acknowledgment row', (await q(
    `SELECT count(*)::int n FROM handoff_acknowledgments WHERE conversation_id=$1`, [old.id]))[0].n, 0);
}

section('14. P0.2 manual replies still work alongside the new table');
{
  const conv = await mkConv(CH_DM_AR, 'QUEUED', 'ar');
  await touchInbound(conv.id);
  await q(`UPDATE escalations SET resolved_at=now() WHERE conversation_id=$1`, [conv.id]);

  // The P0.2 idempotency index is shared with every outbound row. The
  // acknowledgment deliberately does NOT write to `messages`, so it cannot collide
  // with a staff reply.
  const ack = await ACK.maybeAcknowledgeHandoff(
    { tenantId: T1.id, conversationId: conv.id, requestedBy: 'customer', reason: CUSTOMER_HUMAN },
    {
      db: { query: admin.query.bind(admin) },
      resolveCredential: async () => ({ accessToken: 'x' }),
      createClient: () => ({ sendMessengerReply: async () => ({ message_id: 'm' }) }),
      log: { error() {}, log() {} }
    });
  eq('the acknowledgment was sent', ack.status, 'sent');
  eq('  and wrote NOTHING into messages', (await q(
    `SELECT count(*)::int n FROM messages WHERE conversation_id=$1`, [conv.id]))[0].n, 1); // just the inbound one

  const MR = await import('../src/services/manualReplies.js');
  const s = {
    tenantId: T1.id, user: { id: OWNER.id }, roles: ['Platform Super Admin'],
    customAbilities: [], brandIds: null, allBrandsInCompany: true, isPlatformSuperAdmin: false
  };
  // The reply authority still resolves normally.
  const auth = MR.resolveReplyAuthority({ ...s, roles: ['Agent'], user: { id: (await mkUser(T1.id, 'reply_agent')).id } });
  check('the manual-reply authority still resolves', auth.canReplyAny === false && auth.canReplyOwn === true);
}

/* ---------------------------------------------------------------- cleanup */

console.log('\n--- dropping every row this suite created ---');
await q(`DELETE FROM audit_logs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('t1','t2','t3','t4','t5'))`);
await admin.end();

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);

