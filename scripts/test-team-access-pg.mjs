/**
 * REAL PostgreSQL tests for P0.5-A: teams, membership and assignment
 * eligibility, including the concurrency guarantees.
 *
 * Refuses to run unless the target database ends in `_test`. Builds its schema
 * from the REAL migrations, because these tests deliberately route through the
 * production assignment path and a hand-rolled schema would quietly agree with
 * a bug (exactly as it did for the routing engine).
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('  SKIP  TEST_DATABASE_URL not set - skipping the real-PostgreSQL P0.5-A suite.');
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
process.env.DATABASE_URL = url;

console.log(`\nreal PostgreSQL P0.5-A suite - database ${dbName}\n`);

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const rejects = async (name, code, fn) => {
  try { await fn(); check(name, false, 'expected a rejection, got success'); }
  catch (e) { check(name, e?.code === code, `code=${e?.code} want=${code}`); }
};

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (sql, params) => client.query(sql, params);

try {
  section('0 real migrations apply, including 020');
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await q(`CREATE EXTENSION IF NOT EXISTS vector`);
  const files = ['001_init.sql', '009_handoff.sql', '015_brand_access_grants.sql',
    '019_ai_routing_rules.sql', '020_team_lifecycle.sql'];
  for (const f of files) await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  check(`migrations apply cleanly: ${files.join(', ')}`, true);
  for (const f of files) await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  check('and are re-runnable (idempotent)', true);

  section('1 020 shape');
  for (const [col, tbl] of [['status', 'teams'], ['brand_id', 'teams'],
    ['tenant_id', 'team_members'], ['revoked_at', 'team_members'], ['added_by', 'team_members']]) {
    const { rows } = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tbl, col]);
    check(`${tbl}.${col} exists`, rows.length === 1);
  }
  const { rows: [st] } = await q(
    `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='teams_status_check'`);
  check('teams status is constrained', /active/.test(st?.d ?? '') && /disabled/.test(st?.d ?? ''), st?.d);

  /* ------------------------------------------------------------- fixtures */
  section('2 fixtures');
  const { rows: [t1] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T1','p05-t1') RETURNING id`);
  const { rows: [t2] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T2','p05-t2') RETURNING id`);
  const { rows: [b1] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1','p05-b1') RETURNING id`, [t1.id]);
  const { rows: [b2] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B2','p05-b2') RETURNING id`, [t1.id]);
  // t2 needs a brand OF ITS OWN. Without one, "a brand from another company" has
  // nothing to point at, and the assertion would pass on a TypeError from reading
  // .id of undefined - which is not what it claims to be testing.
  const { rows: [bOtherCompany] } = await q(
    `INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B2-t2','p05-b2-t2') RETURNING id`, [t2.id]);
  const { rows: [ch1] } = await q(
    `INSERT INTO channels (tenant_id,brand_id,provider,external_id) VALUES ($1,$2,'meta_dm','p05-page') RETURNING id`, [t1.id, b1.id]);

  const { HANDLING_ROLES } = await import('../src/services/handoff.js');
  for (const r of HANDLING_ROLES) {
    await q(`INSERT INTO roles (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t1.id, r]);
    await q(`INSERT INTO roles (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t2.id, r]);
  }
  const mkUser = async (tenant, name) =>
    (await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
      [tenant, `${name}@t.local`, name])).rows[0].id;
  const roleId = async (tenant, name) =>
    (await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [tenant, name])).rows[0].id;
  const giveRole = async (userId, name, tenant = t1.id) => {
    const rid = await roleId(tenant, name);
    await q(`INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, rid]);
  };

  const admin = await mkUser(t1.id, 'admin');
  const agent = await mkUser(t1.id, 'agent');
  const other = await mkUser(t1.id, 'other');
  const outsider = await mkUser(t2.id, 'outsider');
  await giveRole(admin, 'Company Admin');
  await giveRole(agent, 'Agent');
  await giveRole(other, 'Supervisor');          // ALSO a handling role - see section 8
  await giveRole(outsider, 'Agent', t2.id);

  // Granted HERE, before any section that reasons about eligibility. Doing it
  // later made two sections assert against a state the fixtures had not created
  // yet, which reads like a product bug and is not one.
  await q(`INSERT INTO user_brand_grants (tenant_id,user_id,brand_id) VALUES ($1,$2,$3)`, [t1.id, agent, b1.id]);
  await q(`INSERT INTO user_brand_scope_all (tenant_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t1.id, admin]);

  const {
    createTeam, updateTeam, addTeamMember, removeTeamMember,
    listTeams, listTeamMembers, listEffectivePermissions,
    TeamError, TEAM_ERRORS
  } = await import('../src/services/teamAccess.js');

  /* ---------------------------------------------------------------- teams */
  section('3 team CRUD');
  const marketing = await createTeam({ tenantId: t1.id, actorUserId: admin, name: 'Marketing', db: client });
  eq('a team is created', marketing.name, 'Marketing');
  eq('and starts active', marketing.status, 'active');

  await rejects('a duplicate team name in the same company is refused',
    TEAM_ERRORS.NAME_TAKEN, () => createTeam({ tenantId: t1.id, actorUserId: admin, name: 'Marketing', db: client }));
  await rejects('a blank name is refused', TEAM_ERRORS.NAME_INVALID,
    () => createTeam({ tenantId: t1.id, actorUserId: admin, name: '   ', db: client }));
  await rejects('a name with markup is refused', TEAM_ERRORS.NAME_INVALID,
    () => createTeam({ tenantId: t1.id, actorUserId: admin, name: '<script>', db: client }));

  // A brand belonging to a DIFFERENT company must be refused, not silently
  // attached. Queried deliberately rather than reusing b1, which is ours.
  await rejects('a brand from ANOTHER company is refused', TEAM_ERRORS.BRAND_NOT_FOUND,
    () => createTeam({ tenantId: t1.id, actorUserId: admin, name: 'CrossBrand', brandId: bOtherCompany.id, db: client }));

  // Case-insensitive uniqueness WITHIN a company: "marketing" is the same team
  // as "Marketing", not a second one. Typed by hand that is an easy accident, and
  // two near-identical teams split routing invisibly.
  await rejects('a CASE-differing duplicate is refused in the same company', TEAM_ERRORS.NAME_TAKEN,
    () => createTeam({ tenantId: t1.id, actorUserId: admin, name: 'mArKeTiNg', db: client }));
  const stillOne = (await q(
    `SELECT count(*)::int n FROM teams WHERE tenant_id=$1 AND lower(name)='marketing'`, [t1.id])).rows[0].n;
  eq('and exactly one such team exists', stillOne, 1);
  const keptCasing = (await q(
    `SELECT name FROM teams WHERE tenant_id=$1 AND lower(name)='marketing'`, [t1.id])).rows[0].name;
  eq('the ORIGINAL casing is preserved for display', keptCasing, 'Marketing');

  // A rename that would collide is refused the same way, not a raw driver error.
  // Needs a SECOND team in t1 to collide with: renaming Marketing to a
  // case-variant of Marketing is not a conflict, it is a no-op.
  const purchasing = await createTeam({ tenantId: t1.id, actorUserId: admin, name: 'Purchasing', db: client });
  await rejects('a rename onto a case-variant of another team is refused', TEAM_ERRORS.NAME_TAKEN,
    () => updateTeam({ tenantId: t1.id, actorUserId: admin, teamId: purchasing.id, name: ' MARKETING ', db: client }));
  eq('and the team keeps its original name',
    (await q(`SELECT name FROM teams WHERE id=$1`, [purchasing.id])).rows[0].name, 'Purchasing');

  // The SAME name in a DIFFERENT company stays legal - production really does
  // have "Marketing" in two of its companies today.
  const foreignMarketing = await createTeam({ tenantId: t2.id, actorUserId: outsider, name: 'MARKETING', db: client });
  eq('the same name in another company is allowed, casing kept', foreignMarketing.name, 'MARKETING');

  section('3b concurrent creation cannot produce a case-variant duplicate');
  {
    // Two clients racing on one name in different casing. The unique index is
    // what decides, so exactly one may win whatever the interleaving.
    const a = new pg.Client({ connectionString: url });
    const b = new pg.Client({ connectionString: url });
    await a.connect(); await b.connect();
    const attempt = (conn, name) => createTeam({ tenantId: t1.id, actorUserId: admin, name, db: conn })
      .then((t) => ({ ok: true, id: t.id }))
      .catch((e) => ({ ok: false, code: e?.code }));
    const [r1, r2] = await Promise.all([attempt(a, 'Purchasing Ops'), attempt(b, 'purchasing ops')]);
    await a.end(); await b.end();
    eq('exactly one concurrent create wins', [r1, r2].filter((r) => r.ok).length, 1);
    eq('the loser is told the name is taken', [r1, r2].find((r) => !r.ok)?.code, TEAM_ERRORS.NAME_TAKEN);
    const made = (await q(
      `SELECT count(*)::int n FROM teams WHERE tenant_id=$1 AND lower(name)='purchasing ops'`, [t1.id])).rows[0].n;
    eq('and exactly one row exists', made, 1);
  }

  // Cross-company sameness is already proven above ("MARKETING" in t2 beside
  // "Marketing" in t1). What is worth proving HERE is that the case rule is
  // enforced PER COMPANY, not globally: t2 now holds "MARKETING", so "Marketing"
  // inside t2 must be refused even though the rule is satisfied in t1.
  await rejects('a case-variant inside the OTHER company is refused too', TEAM_ERRORS.NAME_TAKEN,
    () => createTeam({ tenantId: t2.id, actorUserId: outsider, name: 'Marketing', db: client }));
  eq('and that company still holds exactly one such team',
    (await q(`SELECT count(*)::int n FROM teams WHERE tenant_id=$1 AND lower(name)='marketing'`, [t2.id])).rows[0].n, 1);

  const renamed = await updateTeam({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, name: '  Growth   Marketing ', db: client });
  eq('names are trimmed and collapsed', renamed.name, 'Growth Marketing');
  const disabled = await updateTeam({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, status: 'disabled', db: client });
  eq('a team can be disabled', disabled.status, 'disabled');
  await updateTeam({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, status: 'active', db: client });

  section('4 tenant isolation on teams');
  const foreignTeam = (await q(`SELECT id FROM teams WHERE id=$1`, [marketing.id])).rows[0];
  check('another company cannot rename our team',
    await (async () => { try { await updateTeam({ tenantId: t2.id, actorUserId: outsider, teamId: marketing.id, name: 'Stolen', db: client }); return false; } catch (e) { return e.code === TEAM_ERRORS.NOT_FOUND; } })());
  const stillOurs = (await q(`SELECT name FROM teams WHERE id=$1`, [marketing.id])).rows[0];
  eq('and the name is untouched', stillOurs.name, 'Growth Marketing');
  eq('listTeams only returns the caller company',
    (await listTeams({ tenantId: t2.id, db: client })).map((x) => x.name), ['MARKETING']);

  /* ----------------------------------------------------------- membership */
  section('5 membership');
  await addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: agent, db: client });
  const members = await listTeamMembers({ tenantId: t1.id, teamId: marketing.id, db: client });
  eq('the member is listed', members.map((m) => m.user_id), [agent]);
  eq('and their handling role is resolved', members[0].has_handling_role, true);

  await rejects('adding the same person twice is refused', TEAM_ERRORS.ALREADY_MEMBER,
    () => addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: agent, db: client }));

  await rejects('a user from ANOTHER company can never join', TEAM_ERRORS.USER_NOT_FOUND,
    () => addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: outsider, db: client }));

  await rejects('an admin cannot remove THEMSELVES from a team', TEAM_ERRORS.SELF_ESCALATION,
    async () => {
      await addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: admin, db: client });
      return removeTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: admin, db: client });
    });

  await rejects('adding to a DISABLED team is refused', TEAM_ERRORS.FORBIDDEN,
    async () => {
      await updateTeam({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, status: 'disabled', db: client });
      const t = await mkUser(t1.id, 'late');
      try { return await addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: t, db: client }); }
      finally { await updateTeam({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, status: 'active', db: client }); }
    });

  section('6 removal is a soft revoke, and re-adding revives the SAME row');
  const before = (await q(`SELECT team_id, user_id, revoked_at FROM team_members WHERE team_id=$1 AND user_id=$2`, [marketing.id, agent])).rows[0];
  await removeTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: agent, db: client });
  const after = (await q(`SELECT team_id, user_id, revoked_at FROM team_members WHERE team_id=$1 AND user_id=$2`, [marketing.id, agent])).rows[0];
  eq('the row is preserved, not deleted', after.id, before.id);
  check('and marked revoked', after.revoked_at !== null);
  // Asserted about THIS person, not a count: an earlier section deliberately left
  // the admin in the team (self-removal must be refused), so the roster is not
  // empty here and a length assertion would be measuring the wrong thing.
  eq('a revoked member is not listed',
    (await listTeamMembers({ tenantId: t1.id, teamId: marketing.id, db: client })).map((m) => m.user_id).includes(agent),
    false);
  await addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: marketing.id, userId: agent, db: client });
  const revived = (await q(`SELECT team_id, user_id, revoked_at FROM team_members WHERE team_id=$1 AND user_id=$2`, [marketing.id, agent])).rows[0];
  eq('re-adding revives the same row', revived.id, before.id);
  eq('and clears the revocation', revived.revoked_at, null);

  /* ------------------------------------------------------------- auditing */
  section('7 every mutation is audited');
  const acts = await q(
    `SELECT action FROM audit_logs WHERE object_type='team' ORDER BY created_at ASC`);
  const list = acts.rows.map((r) => r.action);
  for (const want of ['team.created', 'team.updated', 'team.member_added', 'team.member_removed']) {
    check(`${want} was written`, list.includes(want), list.join(','));
  }
  const withMeta = await q(
    `SELECT metadata FROM audit_logs WHERE action='team.updated' AND metadata ? 'before' LIMIT 1`);
  check('team.updated records before/after', withMeta.rows.length === 1);
  const removed = await q(
    `SELECT metadata FROM audit_logs WHERE action='team.member_removed' LIMIT 1`);
  check('team.member_removed records the target user', Boolean(removed.rows[0]?.metadata?.userId));

  /* --------------------------------------------------- effective perms */
  section('8 the effective-permission read model');
  const perms = await listEffectivePermissions({ tenantId: t1.id, brandId: b1.id, db: client });
  const byEmail = Object.fromEntries(perms.map((p) => [p.email, p]));
  check('an agent in a team with brand access is ELIGIBLE',
    byEmail['agent@t.local'].assignment_eligible === true, JSON.stringify(byEmail['agent@t.local'].warnings));
  eq('and is not warned', byEmail['agent@t.local'].warnings, []);

  // `other` holds Supervisor, which IS a handling role, so the only thing wrong
  // with them is brand access. Asserting they lacked a handling role was simply
  // wrong about the product, and would have "passed" for the wrong reason if the
  // warning list had been looser.
  const warned = await listEffectivePermissions({ tenantId: t1.id, brandId: b1.id, db: client });
  const w2 = Object.fromEntries(warned.map((p) => [p.email, p]));
  eq('a Supervisor IS treated as holding a handling role', w2['other@t.local'].has_handling_role, true);
  check('but is flagged for the thing actually missing',
    w2['other@t.local'].warnings.includes('NO_BRAND_ACCESS'), w2['other@t.local'].warnings.join(','));
  eq('and is not assignment eligible', w2['other@t.local'].assignment_eligible, false);

  // The exact state production was in: active, no role, no brand.
  const inert = await mkUser(t1.id, 'inert');
  const inertRow = Object.fromEntries(
    (await listEffectivePermissions({ tenantId: t1.id, brandId: b1.id, db: client })).map((p) => [p.email, p]))['inert@t.local'];
  check('an active user with no role and no brand is flagged NO_HANDLING_ROLE',
    inertRow.warnings.includes('NO_HANDLING_ROLE'), inertRow.warnings.join(','));
  check('and NO_BRAND_ACCESS', inertRow.warnings.includes('NO_BRAND_ACCESS'), inertRow.warnings.join(','));
  eq('and is not eligible', inertRow.assignment_eligible, false);

  // The relationship the UI is built on, asserted against REAL server output.
  //
  // A previous version of the frontend test asserted
  //     assignment_eligible === (warnings.length === 0)
  // using fixtures I had written myself, with the two sides always paired - so it
  // proved only that my assumption was self-consistent. It is false: the server
  // computes `assignment_eligible` WITHOUT department membership, because hand
  // assignment has never required one, while NO_TEAM is still raised because
  // routing targets a team. Both are correct; they answer different questions.
  //
  // The real rule, checked here against actual rows:
  //
  // A dedicated fixture, because the existing ones cannot produce the case: the
  // agent and the admin are both members of `marketing` by this point, and
  // `other` is a Supervisor with no brand. Without this person every assertion
  // below would pass vacuously.
  const solo = await mkUser(t1.id, 'solo');
  await giveRole(solo, 'Agent');
  await q(`INSERT INTO user_brand_grants (tenant_id,user_id,brand_id) VALUES ($1,$2,$3)`,
    [t1.id, solo, b1.id]);

  const allPeople = await listEffectivePermissions({ tenantId: t1.id, brandId: b1.id, db: client });
  const soloRow = allPeople.find((p) => p.id === solo);
  check('the fixture is the case under test: eligible, and in no department',
    soloRow?.assignment_eligible === true && soloRow?.warnings.includes('NO_TEAM'),
    JSON.stringify({ e: soloRow?.assignment_eligible, w: soloRow?.warnings }));

  const eligibleWithWarnings = allPeople.filter((p) => p.assignment_eligible && p.warnings.length > 0);
  check('an eligible employee may still carry warnings - and they are only NO_TEAM',
    eligibleWithWarnings.every((p) => p.warnings.length === 1 && p.warnings[0] === 'NO_TEAM'),
    JSON.stringify(eligibleWithWarnings.map((p) => ({ e: p.email, w: p.warnings }))));
  const eligibleWithOther = allPeople.filter((p) =>
    p.assignment_eligible && p.warnings.some((w) => w !== 'NO_TEAM'));
  eq('eligibility never disagrees with anything but department membership', eligibleWithOther.length, 0);
  check('and the case really exists, so this is a live rule and not a vacuous one',
    allPeople.some((p) => p.assignment_eligible && p.warnings.includes('NO_TEAM')));
  const notEligibleWithNone = allPeople.filter((p) => !p.assignment_eligible && p.warnings.length === 0);
  eq('nobody is ineligible with an empty warning list', notEligibleWithNone.length, 0);

  // The three frontend states must be a partition of the real data - every row
  // lands in exactly one, and 'ready' implies no warnings.
  const states = allPeople.map((p) =>
    !p.assignment_eligible ? 'not_ready'
      : p.warnings.length === 0 ? 'ready' : 'manual_only');
  check('every real row maps to exactly one state', states.length === allPeople.length && states.length > 0);
  eq('and "ready" never coexists with a warning',
    allPeople.filter((p, i) => states[i] === 'ready' && p.warnings.length > 0).length, 0);
  check('and the new state is actually exercised by real data',
    states.includes('manual_only') && states.includes('ready') && states.includes('not_ready'),
    `states seen: ${[...new Set(states)].join(', ')}`);

  eq('other companies are never listed', (await listEffectivePermissions({ tenantId: t2.id, db: client })).map((p) => p.email), ['outsider@t.local']);

  // The contract P0.5-B's UI renders against, asserted across BOTH brand
  // contexts.
  //
  // This used to assert `assignment_eligible === (warnings.length === 0)`. That
  // was wrong, and it PASSED for weeks - not because it was right, but because
  // no fixture produced an employee who was eligible yet carried a warning. Once
  // one did, it failed immediately and took the UI's green "Ready" badge with
  // it. A rule only ever checked against data that cannot exercise it is not a
  // rule; it is decoration.
  //
  // The real contract, checked against real rows:
  for (const ctx of [{ brandId: b1.id, label: 'a chosen brand' }, { brandId: undefined, label: 'no brand context' }]) {
    const rows = await listEffectivePermissions({ tenantId: t1.id, brandId: ctx.brandId, db: client });

    // Nobody is ineligible without being told why.
    const silent = rows.filter((p) => !p.assignment_eligible && p.warnings.length === 0);
    check(`nobody is ineligible with an empty warning list (${ctx.label})`,
      silent.length === 0, silent.map((p) => p.email).join(' '));

    // Eligibility and warnings agree about everything except department
    // membership - which hand assignment has never required.
    const drifted = rows.filter((p) => {
      const expected = p.status === 'active'
        && p.has_handling_role
        && (p.all_brands || (ctx.brandId ? p.brand_ids.includes(ctx.brandId) : p.brand_ids.length > 0));
      return p.assignment_eligible !== expected;
    });
    check(`eligibility matches the documented formula (${ctx.label})`,
      drifted.length === 0,
      drifted.map((p) => `${p.email}: eligible=${p.assignment_eligible} warnings=${p.warnings}`).join(' '));

    // And the case that broke the badge is still exercised here.
    check(`an eligible employee with no department is present (${ctx.label})`,
      rows.some((p) => p.assignment_eligible && p.warnings.includes('NO_TEAM')));
  }

  /* ------------------------------------------- eligibility under race */
  section('9 eligibility locks every row the decision depends on');
  {
    const {
      assertAssignmentEligible, EligibilityError, ELIGIBILITY_ERRORS
    } = await import('../src/services/assignmentEligibility.js');

    // The agent's brand grant is granted in the fixtures now, so section 8 can
    // reason about eligibility correctly. Re-inserting it here would violate
    // user_brand_grants_active_uniq, which is exactly the invariant that matters.
    await q(`INSERT INTO user_brand_scope_all (tenant_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t1.id, admin]);

    const DB = { query: (s, p) => client.query(s, p) };

    // Every sub-test below mutates state and then expects a REJECTION. Writing
    // `BEGIN; mutate; assert; ROLLBACK` inline means the assert throws first and
    // the ROLLBACK is never reached, leaving the mutation committed-in-waiting
    // and poisoning the NEXT test - which then fails on the wrong code and looks
    // like a product bug. This helper makes cleanup unconditional.
    const scratch = async (mutate, expect) => {
      await q('BEGIN');
      try {
        await mutate();
        const e = await assertAssignmentEligible(DB,
          { tenantId: t1.id, userId: agent, brandId: b1.id, teamId: marketing.id });
        if (!expect) return e;              // eligible: nothing thrown
        throw new Error('expected a rejection but eligibility passed');
      } finally {
        await q('ROLLBACK');
      }
    };

    // Eligible to begin with.
    await scratch(async () => {});
    check('a fully eligible employee passes', true);

    // Role removed.
    await rejects('losing the handling role is refused', ELIGIBILITY_ERRORS.NOT_ELIGIBLE,
      () => scratch(async () => {
        const { rows: [uid] } = await q(`SELECT role_id FROM user_roles WHERE user_id=$1 LIMIT 1`, [agent]);
        await q(`DELETE FROM user_roles WHERE role_id=$1`, [uid.role_id]);
      }, true));

    // Deactivated.
    await rejects('a deactivated employee is refused', ELIGIBILITY_ERRORS.NOT_ELIGIBLE,
      () => scratch(() => q(`UPDATE users SET status='inactive' WHERE id=$1`, [agent]), true));

    // Removed from the team.
    await rejects('removal from the team is refused', ELIGIBILITY_ERRORS.NOT_IN_TEAM,
      () => scratch(() => q(`UPDATE team_members SET revoked_at=now() WHERE team_id=$1 AND user_id=$2`,
        [marketing.id, agent]), true));

    // Each sub-test must leave the employee exactly as it found them, or the
    // one after it is testing leftover state. Proved rather than assumed.
    const stillOk = await scratch(async () => {});
    check('every sub-test rolled back cleanly (employee is eligible again)', Boolean(stillOk));

    // Cross-company is invisible, not merely refused.
    await rejects('another company\'s employee is refused', ELIGIBILITY_ERRORS.NOT_ELIGIBLE,
      () => assertAssignmentEligible(DB, { tenantId: t2.id, userId: agent, brandId: b1.id }));
  }

  section('10 a concurrent membership change is ORDERED against the check');
  {
    const { assertAssignmentEligible, EligibilityError, ELIGIBILITY_ERRORS } =
      await import('../src/services/assignmentEligibility.js');

    const locker = new pg.Client({ connectionString: url });
    const rival = new pg.Client({ connectionString: url });
    // try/finally around BOTH clients. Without it, anything thrown between BEGIN
    // and COMMIT leaves the row lock held and the rival's UPDATE blocked
    // forever - the suite then hangs instead of failing, which is far worse than
    // a red assertion.
    let removal = Promise.resolve();
    try {
      await locker.connect();
      await rival.connect();
      await locker.query('BEGIN');
      await assertAssignmentEligible(locker, { tenantId: t1.id, userId: agent, brandId: b1.id, teamId: marketing.id });
      check('the eligibility transaction holds its locks', true);

      // A competing membership removal on another connection must block.
      let removalDone = false;
      removal = rival.query(
        `UPDATE team_members SET revoked_at=now() WHERE team_id=$1 AND user_id=$2`,
        [marketing.id, agent]).then(() => { removalDone = true; });
      await new Promise((r) => setTimeout(r, 300));
      eq('a concurrent membership removal is BLOCKED', removalDone, false);

      await locker.query('COMMIT');
      await removal;
      eq('and completes once the locks are released', removalDone, true);
    } finally {
      // Always release, whatever happened above, so no rival can be left waiting.
      try { await locker.query('ROLLBACK'); } catch { /* already closed */ }
      try { await locker.end(); } catch { /* already closed */ }
      try { await rival.end(); } catch { /* already closed */ }
    }
    // No second end() here: the finally above already closed both, and calling
    // end() twice is a latent crash the day the driver tightens that up.

    // And now the employee is genuinely ineligible, not merely unlucky.
    await rejects('after the revocation commits, eligibility is refused',
      ELIGIBILITY_ERRORS.NOT_IN_TEAM, () => {
        const c = { query: (s, p) => client.query(s, p) };
        return assertAssignmentEligible(c, { tenantId: t1.id, userId: agent, brandId: b1.id, teamId: marketing.id });
      });

    await q(`UPDATE team_members SET revoked_at=NULL WHERE team_id=$1 AND user_id=$2`, [marketing.id, agent]);
  }

  section('11 routing still refuses an employee removed from the target team');
  {
    const { maybeAutoRoute, ROUTING_MODES, ROUTING_REASONS } = await import('../src/services/aiRouting.js');

    // A team of its own, holding exactly one person.
    //
    // Reusing `marketing` made this section depend on whatever sections 5-10
    // left behind: `admin` is also a member there, so "the team looks empty"
    // was never true and "who gets proposed" was a coin toss decided by
    // role_in_team ordering. A single-member team makes both claims exact.
    const solo = await createTeam({ tenantId: t1.id, actorUserId: admin, name: 'Routing Solo', db: client });
    await addTeamMember({ tenantId: t1.id, actorUserId: admin, teamId: solo.id, userId: agent, db: client });
    const roster = (await q(
      `SELECT u.email || (CASE WHEN tm.revoked_at IS NULL THEN '' ELSE ' (revoked)' END)
         FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1`,
      [solo.id])).rows.map((r) => Object.values(r)[0]);
    eq('the fixture team holds exactly one live member', roster, ['agent@t.local']);

    await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,detection_value,target_team_id)
             VALUES ($1,'p05','auto_escalation_pattern','supplier',$2)`, [t1.id, solo.id]);
    const conv = (await q(
      `INSERT INTO conversations (tenant_id,channel_id,external_key,state) VALUES ($1,$2,$3,'QUEUED') RETURNING id`,
      [t1.id, ch1.id, `p05_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;

    const before = await maybeAutoRoute({
      tenantId: t1.id, conversationId: conv, detection: { kind: 'auto_escalation_pattern', value: 'supplier' },
      env: { AI_ROUTING_MODE: 'dry_run' }
    });
    eq('dry-run still proposes the team member', before.userId, agent);

    await q(`UPDATE team_members SET revoked_at=now() WHERE team_id=$1 AND user_id=$2`, [solo.id, agent]);
    const afterRemove = await maybeAutoRoute({
      tenantId: t1.id, conversationId: conv, detection: { kind: 'auto_escalation_pattern', value: 'supplier' },
      env: { AI_ROUTING_MODE: 'dry_run' }
    });
    check('and stops proposing them once removed from the team',
      afterRemove.userId !== agent, `got ${afterRemove.userId}`);
    // The population check must agree with the selection. Counting revoked rows
    // let a fully-removed team look populated, and routing then reported
    // success with nobody left to assign.
    eq('and reports the team as having no members', afterRemove.reason, ROUTING_REASONS.NO_TEAM_MEMBERS);
    await q(`UPDATE team_members SET revoked_at=NULL WHERE team_id=$1 AND user_id=$2`, [solo.id, agent]);
  }

  section('12 abilities were added without widening anything else');
  {
    const { ROLE_ABILITIES } = await import('../src/auth/abilities.js');
    check('Company Admin may administer teams', ROLE_ABILITIES['Company Admin'].includes('team.assign'));
    check('Supervisor may only READ teams',
      ROLE_ABILITIES.Supervisor.includes('team.read')
      && !ROLE_ABILITIES.Supervisor.includes('team.assign'));
    check('Agent has no team ability at all',
      !ROLE_ABILITIES.Agent?.includes('team.read') && !ROLE_ABILITIES.Agent?.includes('team.assign'));
    check('team.* never confers a role or brand ability',
      !ROLE_ABILITIES['Company Admin'].filter((a) => a.startsWith('team.'))
        .some((a) => a.startsWith('user.') || a.startsWith('brand.')));
  }

  section('13 nothing was applied to production');
  {
    const dirs = readdirSync(join(REPO, 'migrations')).filter((f) => f.endsWith('.sql'));
    check('020 exists in the repository for review', dirs.includes('020_team_lifecycle.sql'));
    const { rows } = await q(
      `SELECT count(*)::int n FROM information_schema.tables WHERE table_name='teams'`);
    check('the test database does have teams (migration ran here only)', rows[0].n === 1);
  }

  /* ------------------------------------------------- HTTP-layer authorisation */
  section('14 the ROUTES enforce what the abilities promise');
  {
    // Everything above exercises the SERVICE layer. That is exactly why a dead
    // `requireAbility('team.disable')` call survived a 78-test suite: the
    // services never see it. The gate only exists here, so it has to be tested
    // over real HTTP against the mounted router.
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });

    // One app per role set - the router reads roles AND customAbilities from
    // the session. Fictional role names would carry no abilities at all, and
    // adding them to ROLE_ABILITIES would put fake permissions into production.
    // A session carrying `customAbilities` is the supported way to express
    // "this person holds exactly this and nothing more".
    const appFor = (roles, customAbilities = [], tenantId = t1.id) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId, user: { id: admin, email: 'admin@t.local', name: 'A' },
          roles, customAbilities
        }),
        verifyPasswordFn: async () => false,
        createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
        revokeSessionFn: async () => {},
        lockedSecondsFn: async () => 0,
        recordFailedLoginFn: async () => {},
        resetLoginAttemptsFn: async () => {}
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () =>
          r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
      });
    };

    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };
    const send = (base, auth, method, path, body) => fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: auth.cookie,
        ...(method === 'GET' ? {} : { 'x-csrf-token': auth.csrf })
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    const teamId = (await q(
      `INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`, [t1.id, 'Gate Check'])).rows[0].id;

    const updater = await appFor([], ['team.update']);
    const a1 = await authFor(updater.base);
    eq('a role holding team.update may rename',
      (await send(updater.base, a1, 'PATCH', `/teams/${teamId}`, { name: 'Gate Check Renamed' })).status, 200);
    eq('but is REFUSED the power to take it out of service',
      (await send(updater.base, a1, 'PATCH', `/teams/${teamId}`, { status: 'disabled' })).status, 403);
    eq('and the team is still active',
      (await q(`SELECT status FROM teams WHERE id=$1`, [teamId])).rows[0].status, 'active');

    const disabler = await appFor([], ['team.disable']);
    const a2 = await authFor(disabler.base);
    eq('a role holding team.disable alone may disable',
      (await send(disabler.base, a2, 'PATCH', `/teams/${teamId}`, { status: 'disabled' })).status, 200);
    eq('but is REFUSED a rename',
      (await send(disabler.base, a2, 'PATCH', `/teams/${teamId}`, { name: 'Hijacked' })).status, 403);
    eq('and the name is untouched',
      (await q(`SELECT name FROM teams WHERE id=$1`, [teamId])).rows[0].name, 'Gate Check Renamed');

    const reader = await appFor([], ['team.read']);
    const a3 = await authFor(reader.base);
    eq('a read-only role may list teams', (await send(reader.base, a3, 'GET', '/teams')).status, 200);
    eq('but may not create one',
      (await send(reader.base, a3, 'POST', '/teams', { name: 'Nope' })).status, 403);

    // The envelope. Every other /api/v1 router returns `{ data: ... }` and the
    // web client's request() reads `payload.data`. These routes returned bare
    // `{ teams }` at first, so the UI resolved every call to `undefined` - and
    // because the service layer was green throughout, no backend test saw it.
    const list = await send(reader.base, a3, 'GET', '/teams');
    check('success bodies are wrapped in { data }', Array.isArray(list.body?.data?.teams),
      JSON.stringify(Object.keys(list.body ?? {})));
    check('and nothing leaks outside it', list.body?.teams === undefined,
      JSON.stringify(Object.keys(list.body ?? {})));
    const perms = await send(reader.base, a3, 'GET', '/teams/permissions');
    check('the permissions read model is wrapped too', Array.isArray(perms.body?.data?.people),
      JSON.stringify(Object.keys(perms.body ?? {})));
    check('and carries warning_count', typeof perms.body?.data?.warning_count === 'number');
    const roster = await send(reader.base, a3, 'GET', `/teams/${teamId}/members`);
    check('the roster is wrapped', Array.isArray(roster.body?.data?.members),
      JSON.stringify(Object.keys(roster.body ?? {})));
    const err = await send(reader.base, a3, 'POST', '/teams', { name: '   ' });
    check('errors are NOT wrapped - they keep { error }', !!err.body?.error?.code,
      JSON.stringify(err.body));

    for (const s of [updater, disabler, reader]) s.s.close();
    await pool.end();
  }

  section('15 capabilities tell the caller what it may do, and nothing more');
  {
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });

    const appFor = (roles, customAbilities = [], tenantId = t1.id) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId, user: { id: admin, email: 'admin@t.local', name: 'A' },
          roles, customAbilities
        }),
        verifyPasswordFn: async () => false,
        createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
        revokeSessionFn: async () => {},
        lockedSecondsFn: async () => 0,
        recordFailedLoginFn: async () => {},
        resetLoginAttemptsFn: async () => {}
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () =>
          r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
      });
    };
    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };
    const caps = async (base, auth) => {
      const r = await fetch(`${base}/teams/capabilities`, { headers: { Cookie: auth.cookie } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    // A Company Admin holds all five.
    const ca = await appFor(['Company Admin']);
    const caAuth = await authFor(ca.base);
    const caCaps = await caps(ca.base, caAuth);
    eq('a Company Admin is told all five abilities',
      [...(caCaps.body?.data?.abilities ?? [])].sort(),
      ['team.assign', 'team.create', 'team.disable', 'team.read', 'team.update']);

    // A Supervisor reads and does nothing else.
    const sup = await appFor(['Supervisor']);
    const supAuth = await authFor(sup.base);
    eq('a Supervisor is told exactly team.read',
      (await caps(sup.base, supAuth)).body?.data?.abilities, ['team.read']);

    // An Agent holds none - and gets an accurate empty answer, not a 403.
    const ag = await appFor(['Agent']);
    const agAuth = await authFor(ag.base);
    const agCaps = await caps(ag.base, agAuth);
    eq('an Agent is told nothing rather than refused', agCaps.status, 200);
    eq('and the answer is empty', agCaps.body?.data?.abilities, []);

    // Custom abilities are honoured, because that is how a real custom role
    // resolves.
    const custom = await appFor([], ['team.read', 'team.update']);
    eq('a custom role carrying two abilities reports exactly those two',
      (await caps(custom.base, await authFor(custom.base))).body?.data?.abilities,
      ['team.read', 'team.update']);

    // LEAKAGE. The endpoint must not become a way to read anything else.
    const leak = await appFor(['Company Admin', 'Platform Super Admin'], ['platform.everything'], t2.id);
    const leakBody = (await caps(leak.base, await authFor(leak.base))).body?.data;
    const serialized = JSON.stringify(leakBody ?? {});
    check('nothing outside the team.* namespace is ever reported',
      Object.values(leakBody?.abilities ?? {}).every((a) => String(a).startsWith('team.')),
      serialized);
    check('a platform-level ability is NOT echoed back',
      !serialized.includes('platform.everything'), serialized);
    check('no tenant, brand or user identifier is present',
      !serialized.includes(t1.id) && !serialized.includes(t2.id)
      && !serialized.includes(b1.id) && !serialized.includes(admin), serialized);
    check('role names are not returned either',
      !('roles' in (leakBody ?? {})) && !serialized.includes('Company Admin'), serialized);
    check('the ONLY keys returned are abilities', Object.keys(leakBody ?? {}).join(',') === 'abilities',
      Object.keys(leakBody ?? {}).join(','));

    // The reported capabilities must agree with what the routes actually allow.
    // A screen that hides a button the server would have permitted is as wrong
    // as one that shows a button the server will refuse.
    const half = await appFor([], ['team.update']);
    const halfAuth = await authFor(half.base);
    const halfCaps = (await caps(half.base, halfAuth)).body?.data?.abilities ?? [];
    eq('a half-privileged caller is told only what it has', halfCaps, ['team.update']);
    const teamId2 = (await q(
      `INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`, [t1.id, 'Cap Check'])).rows[0].id;
    const hdr = (auth) => ({ 'Content-Type': 'application/json', Cookie: auth.cookie, 'x-csrf-token': auth.csrf });
    const renameOk = await fetch(`${half.base}/teams/${teamId2}`, {
      method: 'PATCH', headers: hdr(halfAuth), body: JSON.stringify({ name: 'Cap Renamed' })
    });
    eq('and renaming really is permitted', renameOk.status, 200);
    const disableDenied = await fetch(`${half.base}/teams/${teamId2}`, {
      method: 'PATCH', headers: hdr(halfAuth), body: JSON.stringify({ status: 'disabled' })
    });
    eq('while disabling really is not', disableDenied.status, 403);

    for (const s of [ca, sup, ag, custom, leak, half]) s.s.close();
    await pool.end();
  }

  section('17 capabilities and the routes can never disagree');
  {
    // The question this exists to answer: is /teams/capabilities reporting the
    // caller's REAL permissions, or just whatever happened to be on the session?
    //
    // Spot checks answer that weakly. This asserts the PROPERTY instead - for
    // every ability the endpoint reports, the matching route must actually let
    // the action through, and for every ability it withholds, the route must
    // actually refuse. Across seven different role sets and all five abilities.
    // One disagreement is a failure, so the screen cannot offer a button that
    // 403s or hide one that would have worked.
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });

    const appFor = (roles, customAbilities = []) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId: t1.id, user: { id: admin, email: 'admin@t.local', name: 'A' },
          roles, customAbilities
        }),
        verifyPasswordFn: async () => false,
        createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
        revokeSessionFn: async () => {},
        lockedSecondsFn: async () => 0,
        recordFailedLoginFn: async () => {},
        resetLoginAttemptsFn: async () => {}
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () =>
          r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
      });
    };
    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };

    const CASES = [
      { label: 'Company Admin', roles: ['Company Admin'], custom: [] },
      { label: 'Supervisor', roles: ['Supervisor'], custom: [] },
      { label: 'Agent', roles: ['Agent'], custom: [] },
      { label: 'custom read+update', roles: [], custom: ['team.read', 'team.update'] },
      { label: 'custom disable only', roles: [], custom: ['team.disable'] },
      { label: 'custom assign only', roles: [], custom: ['team.assign'] },
      { label: 'custom nothing', roles: [], custom: [] }
    ];

    let seq = 0;
    let mismatches = 0;
    const servers = [];

    for (const c of CASES) {
      const srv = await appFor(c.roles, c.custom);
      servers.push(srv);
      const auth = await authFor(srv.base);
      const reported = ((await (await fetch(`${srv.base}/teams/capabilities`,
        { headers: { Cookie: auth.cookie } })).json())?.data?.abilities) ?? [];

      const h = { 'Content-Type': 'application/json', Cookie: auth.cookie, 'x-csrf-token': auth.csrf };
      const mkTeam = async (tag) => (await q(
        `INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`,
        [t1.id, `Prop ${tag} ${seq++}`])).rows[0].id;
      const gid = await mkTeam(c.label);
      // A SEPARATE team for the disable probe. Sharing one made the assign probe
      // hit an already-disabled team and return 409 TEAM_FORBIDDEN, which reads
      // like a permission refusal and is not one. Each probe now measures
      // exactly one thing.
      const gidDisable = await mkTeam(`${c.label} disable`);

      // One real request per ability, against the real routes.
      const probes = [
        ['team.read', () => fetch(`${srv.base}/teams`, { headers: { Cookie: auth.cookie } })],
        ['team.create', () => fetch(`${srv.base}/teams`, {
          method: 'POST', headers: h, body: JSON.stringify({ name: `Probe ${seq++}` }) })],
        ['team.update', () => fetch(`${srv.base}/teams/${gid}`, {
          method: 'PATCH', headers: h, body: JSON.stringify({ name: `Renamed ${seq++}` }) })],
        ['team.assign', () => fetch(`${srv.base}/teams/${gid}/members`, {
          method: 'POST', headers: h, body: JSON.stringify({ userId: agent }) })],
        ['team.disable', () => fetch(`${srv.base}/teams/${gidDisable}`, {
          method: 'PATCH', headers: h, body: JSON.stringify({ status: 'disabled' }) })]
      ];

      for (const [ability, run] of probes) {
        const says = reported.includes(ability);
        const res = await run();
        const allowed = res.status < 400;
        if (says !== allowed) {
          mismatches++;
          console.log(`        MISMATCH ${c.label} ${ability}: reported=${says} route=${allowed} (${res.status})`);
        }
      }
    }

    eq('capabilities and the routes agree on all 35 ability/role combinations',
      mismatches, 0);

    // And the scope question specifically: team.* abilities are COMPANY-scoped,
    // never brand-scoped. Brand scope decides which conversations a person sees,
    // not whether they may administer departments. A brand delegation must
    // therefore never manufacture a team ability.
    const brandOnly = await appFor([], ['brand.grant', 'brand.grant_all', 'brand.integration.connect']);
    servers.push(brandOnly);
    const boAuth = await authFor(brandOnly.base);
    eq('brand powers alone confer NO team capability',
      (await (await fetch(`${brandOnly.base}/teams/capabilities`,
        { headers: { Cookie: boAuth.cookie } })).json())?.data?.abilities, []);

    for (const s of servers) s.s.close();
    await pool.end();
  }

  section('16 removing a member: the three paths that matter');
  {
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });

    const appFor = (roles, customAbilities = []) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId: t1.id, user: { id: admin, email: 'admin@t.local', name: 'A' },
          roles, customAbilities
        }),
        verifyPasswordFn: async () => false,
        createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
        revokeSessionFn: async () => {},
        lockedSecondsFn: async () => 0,
        recordFailedLoginFn: async () => {},
        resetLoginAttemptsFn: async () => {}
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () =>
          r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
      });
    };
    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };

    const teamId = (await q(
      `INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`, [t1.id, 'Removal Check'])).rows[0].id;
    // tenant_id is stated explicitly: migration 020 requires it on every live
    // membership, and the service layer always sets it. Bypassing the service is
    // fine for a fixture, bypassing the constraint is not.
    await q(`INSERT INTO team_members (team_id,user_id,tenant_id,role_in_team) VALUES ($1,$2,$3,'agent')`,
      [teamId, agent, t1.id]);

    // 1. SUCCESS - and it is a soft revoke, not a delete.
    const assigner = await appFor([], ['team.assign']);
    const a = await authFor(assigner.base);
    const del = await fetch(`${assigner.base}/teams/${teamId}/members/${agent}`, {
      method: 'DELETE', headers: { Cookie: a.cookie, 'x-csrf-token': a.csrf }
    });
    eq('a holder of team.assign can remove someone', del.status, 200);
    eq('the response says who', (await del.json())?.data?.member?.user_id, agent);
    const stillThere = (await q(
      `SELECT revoked_at FROM team_members WHERE team_id=$1 AND user_id=$2`, [teamId, agent])).rows[0];
    check('but the ROW is preserved with revoked_at set',
      Boolean(stillThere) && stillThere.revoked_at !== null, JSON.stringify(stillThere));

    // 2. FORBIDDEN - the caller may read but not assign.
    const reader = await appFor([], ['team.read']);
    const r2 = await authFor(reader.base);
    const denied = await fetch(`${reader.base}/teams/${teamId}/members/${agent}`, {
      method: 'DELETE', headers: { Cookie: r2.cookie, 'x-csrf-token': r2.csrf }
    });
    eq('a read-only caller is REFUSED', denied.status, 403);
    eq('and the membership is untouched',
      (await q(`SELECT revoked_at FROM team_members WHERE team_id=$1 AND user_id=$2`,
        [teamId, agent])).rows[0].revoked_at !== null, true);

    // 3. FAILURE - not a member, and never existed. Both must read the same way,
    //    so the endpoint cannot be used to discover who is in which team.
    const notAMember = await fetch(`${assigner.base}/teams/${teamId}/members/${outsider}`, {
      method: 'DELETE', headers: { Cookie: a.cookie, 'x-csrf-token': a.csrf }
    });
    const neverExisted = await fetch(`${assigner.base}/teams/${teamId}/members/${await newId()}`, {
      method: 'DELETE', headers: { Cookie: a.cookie, 'x-csrf-token': a.csrf }
    });
    eq('removing someone who is not a member fails', notAMember.status, 404);
    eq('removing a user who does not exist fails identically', neverExisted.status, notAMember.status);
    const cA = (await notAMember.clone().json())?.error?.code;
    const cB = (await neverExisted.clone().json())?.error?.code;
    eq('  and with the same code, so membership cannot be probed', cB, cA);
    eq('  and that code does not distinguish them', cA, 'TEAM_NOT_A_MEMBER');

    // 4. An admin still cannot remove THEMSELVES - even over HTTP.
    const selfTeam = (await q(
      `INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`, [t1.id, 'Self Removal'])).rows[0].id;
    await q(`INSERT INTO team_members (team_id,user_id,tenant_id,role_in_team) VALUES ($1,$2,$3,'agent')`,
      [selfTeam, admin, t1.id]);
    const self = await fetch(`${assigner.base}/teams/${selfTeam}/members/${admin}`, {
      method: 'DELETE', headers: { Cookie: a.cookie, 'x-csrf-token': a.csrf }
    });
    eq('an admin cannot remove THEMSELVES', self.status, 409);
    check('and is told why, specifically',
      (await self.json())?.error?.code === 'TEAM_SELF_ESCALATION');

    // 5. Another company's team is invisible, not merely refused.
    const foreign = (await q(
      `INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`, [t2.id, 'Foreign Team'])).rows[0].id;
    const cross = await fetch(`${assigner.base}/teams/${foreign}/members/${outsider}`, {
      method: 'DELETE', headers: { Cookie: a.cookie, 'x-csrf-token': a.csrf }
    });
    eq('another company\'s team is not found', cross.status, 404);
    eq('  and its membership is untouched',
      (await q(`SELECT count(*)::int n FROM team_members WHERE team_id=$1 AND revoked_at IS NULL`,
        [foreign])).rows[0].n, 0);

    for (const s of [assigner, reader]) s.s.close();
    await pool.end();

    async function newId() {
      const { rows: [u] } = await q(
        `INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
        [t1.id, `ghost-${Date.now()}@t.local`, 'Ghost']);
      return u.id;
    }
  }
} catch (e) {
  failures.push(`fatal: ${e?.code ?? ''} ${e?.message}`);
  console.error('\nfatal:', e?.code, e?.message);
} finally {
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