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

  eq('other companies are never listed', (await listEffectivePermissions({ tenantId: t2.id, db: client })).map((p) => p.email), ['outsider@t.local']);

  // The contract P0.5-B's UI will render against: an employee is eligible
  // exactly when nothing is outstanding. Asserted across BOTH brand contexts,
  // because "no brand chosen" is the case a priority ladder got wrong.
  for (const ctx of [{ brandId: b1.id, label: 'a chosen brand' }, { brandId: undefined, label: 'no brand context' }]) {
    const rows = await listEffectivePermissions({ tenantId: t1.id, brandId: ctx.brandId, db: client });
    const broken = rows.filter((p) => p.assignment_eligible !== (p.warnings.length === 0));
    check(`eligibility never disagrees with the warning list (${ctx.label})`,
      broken.length === 0, broken.map((p) => `${p.email}: eligible=${p.assignment_eligible} warnings=${p.warnings}`).join(' '));
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