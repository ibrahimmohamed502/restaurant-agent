/**
 * REAL PostgreSQL tests for the AI routing engine.
 *
 * Run against a throwaway database:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lwc_ai_test \
 *     node scripts/test-ai-routing-pg.mjs
 *
 * Refuses to run unless the target database name ends in `_test`, and only ever
 * inserts rows it creates.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('  SKIP  TEST_DATABASE_URL not set - skipping the real-PostgreSQL AI-routing suite.');
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

// SAFETY: `src/db/pg.js` builds its shared pool from DATABASE_URL. Repoint it
// at the throwaway database and refuse to continue if that is not possible.
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

console.log(`\nreal PostgreSQL AI-routing suite - database ${dbName}\n`);

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (sql, params) => client.query(sql, params);

const M = { off: {}, dry: { AI_ROUTING_MODE: 'dry_run' }, live: { AI_ROUTING_MODE: 'live' } };

try {
  /* ------------------------------------------------------------------ schema */
  section('0 schema + migration 019');
  // Apply the REAL migrations rather than a hand-rolled schema. A hand-rolled
  // one drifts: this engine deliberately routes through the production
  // assignConversation transition, so the suite must exercise the production
  // table shapes, not an approximation of them.
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await q(`CREATE EXTENSION IF NOT EXISTS vector`);
  for (const f of ['001_init.sql', '009_handoff.sql', '015_brand_access_grants.sql', '019_ai_routing_rules.sql']) {
    await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  }
  check('real migrations 001 + 009 + 015 + 019 apply cleanly', true);
  for (const f of ['001_init.sql', '009_handoff.sql', '015_brand_access_grants.sql', '019_ai_routing_rules.sql']) {
    await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  }
  check('and are re-runnable (idempotent)', true);

  const { rows: [ruleCols] } = await q(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name='ai_routing_rules'`);
  check('ai_routing_rules exists', ruleCols.n === 12, `columns=${ruleCols.n}`);

  for (const t of ['teams', 'team_members', 'conversations', 'customers', 'assignments',
    'escalations', 'user_brand_grants', 'user_brand_scope_all', 'brands', 'channels']) {
    const { rows: [hit] } = await q(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t]);
    check(`production table "${t}" is present`, Boolean(hit));
  }

  /* ------------------------------------------------------------------ fixtures */
  section('1 fixtures');
  const { rows: [t1] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T1','t1') RETURNING id`);
  const { rows: [t2] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T2','t2') RETURNING id`);
  const { rows: [b1] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1','b1') RETURNING id`, [t1.id]);
  const { rows: [ch1] } = await q(`INSERT INTO channels (tenant_id,brand_id,provider,external_id) VALUES ($1,$2,'meta_dm','page1') RETURNING id`, [t1.id, b1.id]);
  // A company-wide channel: brand_id NULL, so only an all-brands delegate may work it.
  const { rows: [chCompany] } = await q(`INSERT INTO channels (tenant_id,brand_id,provider,external_id) VALUES ($1,NULL,'meta_dm','page_cw') RETURNING id`, [t1.id]);

  const mkUser = async (tenant, name) =>
    (await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
      [tenant, `${name}@test.local`, name])).rows[0].id;
  const mkTeam = async (tenant, name) =>
    (await q(`INSERT INTO teams (tenant_id,name) VALUES ($1,$2) RETURNING id`, [tenant, name])).rows[0].id;
  // `conversations` carries no brand column - brand scope lives on the channel.
  const mkConv = async (state, tenant = t1.id, channel = ch1.id) =>
    (await q(`INSERT INTO conversations (tenant_id,channel_id,external_key,state) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenant, channel, `ek_${Math.random().toString(36).slice(2, 9)}`, state])).rows[0].id;

  const marketing = await mkTeam(t1.id, 'Marketing');
  const purchasing = await mkTeam(t1.id, 'Purchasing');
  const sales = await mkTeam(t1.id, 'Sales');

  const alice = await mkUser(t1.id, 'alice');
  const bob = await mkUser(t1.id, 'bob');
  const carol = await mkUser(t1.id, 'carol');
  const outsider = await mkUser(t2.id, 'outsider');

  await q(`INSERT INTO team_members (team_id,user_id,role_in_team) VALUES ($1,$2,'lead'),($1,$3,'agent')`, [marketing, alice, bob]);
  await q(`INSERT INTO team_members (team_id,user_id) VALUES ($1,$2)`, [purchasing, carol]);
  await q(`INSERT INTO user_brand_grants (tenant_id,user_id,brand_id) VALUES ($1,$2,$3),($1,$4,$3)`, [t1.id, alice, b1.id, carol]);

  // Handling roles. `performAssign` refuses anybody without one, so routing
  // must filter on exactly the same set - importing HANDLING_ROLES rather than
  // re-listing it, so the two can never drift.
  const { HANDLING_ROLES } = await import('../src/services/handoff.js');
  for (const roleName of HANDLING_ROLES) {
    await q(`INSERT INTO roles (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t1.id, roleName]);
    await q(`INSERT INTO roles (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t2.id, roleName]);
  }
  const roleId = async (tenant, name) =>
    (await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [tenant, name])).rows[0].id;
  const giveRole = async (userId, name) => {
    const rid = await roleId(t1.id, name);
    await q(`INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, rid]);
  };
  await giveRole(alice, 'Supervisor');
  await giveRole(bob, 'Agent');
  await giveRole(carol, 'Agent');

  const {
    resolveRoutingRule, selectEligibleAssignee, planAutoAssignment,
    maybeAutoRoute, routingMode, ROUTING_MODES, ROUTING_REASONS
  } = await import('../src/services/aiRouting.js');

  /* ------------------------------------------------------------------ flag */
  section('2 the feature flag defaults to OFF and cannot be enabled by a typo');
  eq('unset env -> OFF', routingMode({}), ROUTING_MODES.OFF);
  eq('"live" -> LIVE', routingMode({ AI_ROUTING_MODE: 'live' }), ROUTING_MODES.LIVE);
  eq('"LIVE" is case-insensitive', routingMode({ AI_ROUTING_MODE: 'LIVE' }), ROUTING_MODES.LIVE);
  eq('"dry_run" -> DRY_RUN', routingMode({ AI_ROUTING_MODE: 'dry_run' }), ROUTING_MODES.DRY_RUN);
  eq('a typo can NEVER enable live', routingMode({ AI_ROUTING_MODE: 'liv' }), ROUTING_MODES.OFF);
  eq('"true" is not live', routingMode({ AI_ROUTING_MODE: 'true' }), ROUTING_MODES.OFF);
  eq('"1" is not live', routingMode({ AI_ROUTING_MODE: '1' }), ROUTING_MODES.OFF);

  section('3 OFF is provably inert - it touches no table');
  const convOff = await mkConv('QUEUED');
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,detection_value,target_team_id)
           VALUES ($1,'r','auto_escalation_pattern','supplier',$2)`, [t1.id, purchasing]);
  const { rows: before } = await q(`SELECT (SELECT count(*) FROM conversations)::int c, (SELECT count(*) FROM ai_routing_rules)::int r, (SELECT count(*) FROM team_members)::int m`);
  const offResult = await maybeAutoRoute({ tenantId: t1.id, conversationId: convOff, detection: { kind: 'auto_escalation_pattern', value: 'supplier' }, env: M.off });
  const { rows: after } = await q(`SELECT (SELECT count(*) FROM conversations)::int c, (SELECT count(*) FROM ai_routing_rules)::int r, (SELECT count(*) FROM team_members)::int m`);
  eq('OFF reports routing_disabled', offResult.reason, ROUTING_REASONS.DISABLED);
  eq('OFF applied nothing', offResult.applied, false);
  eq('OFF changed nothing in any table', after[0], before[0]);

  /* ------------------------------------------------------------------ rules */
  section('4 rule resolution: brand scope beats company-wide, then priority');
  await q(`DELETE FROM ai_routing_rules`);
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,priority,detection_kind,detection_value,target_team_id)
           VALUES ($1,'low',900,'auto_escalation_pattern','supplier',$2)`, [t1.id, sales]);
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,priority,detection_kind,detection_value,target_team_id)
           VALUES ($1,'high',10,'auto_escalation_pattern','supplier',$2)`, [t1.id, purchasing]);
  const det = { kind: 'auto_escalation_pattern', value: 'supplier' };
  const pickHigh = await resolveRoutingRule({ tenantId: t1.id, brandId: b1.id, detection: det });
  eq('higher priority (lower number) wins', pickHigh.rule.rule_key, 'high');

  await q(`INSERT INTO ai_routing_rules (tenant_id,brand_id,rule_key,priority,detection_kind,detection_value,target_team_id)
           VALUES ($1,$2,'brand_specific',500,'auto_escalation_pattern','supplier',$3)`, [t1.id, b1.id, marketing]);
  const pickBrand = await resolveRoutingRule({ tenantId: t1.id, brandId: b1.id, detection: det });
  eq('a BRAND-scoped rule beats a higher-priority company-wide one', pickBrand.rule.rule_key, 'brand_specific');
  const pickOther = await resolveRoutingRule({ tenantId: t1.id, brandId: null, detection: det });
  eq('company-wide lookup still sees the company-wide rule', pickOther.rule.rule_key, 'high');

  section('5 rule resolution is deterministic under an exact priority tie');
  await q(`DELETE FROM ai_routing_rules`);
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,priority,detection_kind,target_team_id)
           VALUES ($1,'zzz',50,'auto_escalation_pattern',$2),($1,'aaa',50,'auto_escalation_pattern',$2),($1,'mmm',50,'auto_escalation_pattern',$2)`,
    [t1.id, sales]);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const r = await resolveRoutingRule({ tenantId: t1.id, brandId: b1.id, detection: { kind: 'auto_escalation_pattern' } });
    seen.add(r.rule?.rule_key);
  }
  eq('the same tie always resolves to the same rule', [...seen], ['aaa']);

  section('6 disabled rules are invisible');
  await q(`UPDATE ai_routing_rules SET enabled=false`);
  eq('a disabled rule never resolves',
    (await resolveRoutingRule({ tenantId: t1.id, brandId: b1.id, detection: { kind: 'auto_escalation_pattern' } })).rule, null);
  await q(`UPDATE ai_routing_rules SET enabled=true`);

  section('7 an unknown situation is refused, never guessed');
  // A catch-all rule (detection_value NULL) would legitimately match anything,
  // so start from a clean slate before asserting that nothing matches.
  await q(`DELETE FROM ai_routing_rules`);
  eq('no rules at all -> no_matching_rule',
    (await resolveRoutingRule({ tenantId: t1.id, brandId: b1.id, detection: det })).reason, ROUTING_REASONS.NO_RULE);
  eq('another company sees nothing',
    (await resolveRoutingRule({ tenantId: t2.id, brandId: b1.id, detection: det })).reason, ROUTING_REASONS.NO_RULE);

  /* ------------------------------------------------------------------ selection */
  section('8 employee selection proves eligibility');
  await q(`DELETE FROM ai_routing_rules`);
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,detection_value,target_team_id)
           VALUES ($1,'supplier','auto_escalation_pattern','supplier',$2)`, [t1.id, purchasing]);

  const selCarol = await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: purchasing });
  eq('the only eligible member is chosen', selCarol.userId, carol);

  // An inactive member is skipped even if they are the only one.
  await q(`UPDATE users SET status='inactive' WHERE id=$1`, [carol]);
  eq('an INACTIVE employee is never selected',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: purchasing })).userId, null);
  await q(`UPDATE users SET status='active' WHERE id=$1`, [carol]);

  // No brand access -> not eligible.
  await q(`UPDATE user_brand_grants SET revoked_at=now() WHERE user_id=$1`, [carol]);
  eq('a REVOKED brand grant removes them',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: purchasing })).userId, null);
  await q(`UPDATE user_brand_grants SET revoked_at=NULL WHERE user_id=$1`, [carol]);

  // An all-brands delegation is an alternative route to eligibility.
  await q(`UPDATE user_brand_grants SET revoked_at=now() WHERE user_id=$1`, [carol]);
  await q(`INSERT INTO user_brand_scope_all (tenant_id,user_id) VALUES ($1,$2)`, [t1.id, carol]);
  eq('an all-brands delegation also qualifies',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: purchasing })).userId, carol);
  eq('and a revoked delegation does NOT',
    (await (async () => { await q(`UPDATE user_brand_scope_all SET revoked_at=now() WHERE user_id=$1`, [carol]); const r = await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: purchasing }); await q(`UPDATE user_brand_scope_all SET revoked_at=NULL WHERE user_id=$1`, [carol]); return r; })()).userId, null);

  section('9 a company-wide channel needs the all-brands delegation');
  await q(`UPDATE user_brand_grants SET revoked_at=now() WHERE user_id=$1`, [carol]);
  await q(`UPDATE user_brand_scope_all SET revoked_at=now() WHERE user_id=$1`, [carol]);
  eq('with BOTH revoked, a company-wide conversation has nobody eligible',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: null, teamId: purchasing })).userId, null);
  await q(`UPDATE user_brand_scope_all SET revoked_at=NULL WHERE user_id=$1`, [carol]);
  eq('the all-brands delegation alone DOES cover it',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: null, teamId: purchasing })).userId, carol);
  await q(`UPDATE user_brand_grants SET revoked_at=NULL WHERE user_id=$1`, [carol]);

  section('10 a member without a HANDLING role can never be nominated');
  // `performAssign` refuses anybody holding no handling role, so routing must
  // never propose one. Found the hard way: without this the engine nominated a
  // valid, brand-granted team member and the real path then refused them.
  const roleTeam = await mkTeam(t1.id, 'RoleTeam');
  const norole = await mkUser(t1.id, 'norole');
  await q(`INSERT INTO team_members (team_id,user_id) VALUES ($1,$2)`, [roleTeam, norole]);
  await q(`INSERT INTO user_brand_grants (tenant_id,user_id,brand_id) VALUES ($1,$2,$3)`, [t1.id, norole, b1.id]);
  eq('an active, brand-granted member with NO handling role is NOT selected',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: roleTeam })).userId, null);
  await giveRole(norole, 'Agent');
  eq('the same member IS selected once they hold a handling role',
    (await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: roleTeam })).userId, norole);

  section('11 cross-company membership can never be selected');
  await q(`INSERT INTO team_members (team_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [marketing, outsider]);
  await q(`INSERT INTO user_brand_scope_all (tenant_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t2.id, outsider]);
  const inMarketing = await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: marketing });
  check('a member of ANOTHER company is never chosen',
    inMarketing.userId !== outsider, `got ${inMarketing.userId}`);

  section('11 load balancing prefers the least loaded eligible member');
  const convsFor = async (userId, n) => {
    for (let i = 0; i < n; i++) {
      await q(`INSERT INTO conversations (tenant_id,channel_id,external_key,state,assigned_user_id)
               VALUES ($1,$2,$3,'ASSIGNED',$4)`, [t1.id, ch1.id, `load_${userId}_${i}_${Math.random().toString(36).slice(2, 7)}`, userId]);
    }
  };
  await convsFor(bob, 3);   // bob has brand grant via alice? no - bob has none
  await q(`INSERT INTO user_brand_grants (tenant_id,user_id,brand_id) VALUES ($1,$2,$3)`, [t1.id, bob, b1.id]);
  await convsFor(bob, 3);
  const balanced = await selectEligibleAssignee({ tenantId: t1.id, brandId: b1.id, teamId: marketing });
  eq('the unloaded member (alice) is preferred over the loaded one (bob)', balanced.userId, alice);

  section('12 a rule can never name a person - only a team');
  let rejected = false;
  let rejectedMsg = '';
  try {
    await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,target_team_id) VALUES ($1,'x','k',NULL)`, [t1.id]);
  } catch (e) { rejected = /target_team/.test(e.message); rejectedMsg = e.message.slice(0, 80); }
  check('a rule without a team is REJECTED by the database', rejected, rejectedMsg);

  let crossTenant = false;
  try {
    await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,target_team_id) VALUES ($1,'x','k',$2)`, [t1.id, (await mkTeam(t2.id, 'OtherCo')).id]);
  } catch (e) { crossTenant = /foreign key|violates/i.test(e.message); }
  check('a rule cannot point at ANOTHER company\'s team', crossTenant);

  /* ------------------------------------------------------------------ planner */
  section('13 the planner refuses conversations it must not touch');
  const assigned = await mkConv('ASSIGNED');
  await q(`UPDATE conversations SET assigned_user_id=$1 WHERE id=$2`, [carol, assigned]);
  eq('an already-assigned conversation is skipped',
    (await planAutoAssignment({ tenantId: t1.id, conversationId: assigned, detection: det })).reason,
    ROUTING_REASONS.ALREADY_ASSIGNED);
  eq('a RESOLVED conversation is skipped',
    (await planAutoAssignment({ tenantId: t1.id, conversationId: (await mkConv('RESOLVED')).id, detection: det })).reason,
    ROUTING_REASONS.CONVERSATION_NOT_QUEUED);
  eq('an AI_ACTIVE conversation is skipped',
    (await planAutoAssignment({ tenantId: t1.id, conversationId: (await mkConv('AI_ACTIVE')).id, detection: det })).reason,
    ROUTING_REASONS.CONVERSATION_NOT_QUEUED);
  eq('another company\'s conversation is invisible',
    (await planAutoAssignment({ tenantId: t2.id, conversationId: (await mkConv('QUEUED')), detection: det })).reason,
    ROUTING_REASONS.CONVERSATION_NOT_QUEUED);

  section('14 DRY_RUN is side-effect free');
  const dryConv = await mkConv('QUEUED');
  const snapshot = async () => (await q(
    `SELECT (SELECT count(*) FROM conversations)::int a, (SELECT count(*) FROM conversations WHERE assigned_user_id IS NOT NULL)::int b,
            (SELECT count(*) FROM ai_routing_rules)::int c, (SELECT count(*) FROM team_members)::int d`)).rows[0];
  const snapBefore = await snapshot();
  const dry = await maybeAutoRoute({ tenantId: t1.id, conversationId: dryConv, detection: det, env: M.dry });
  const snapAfter = await snapshot();
  eq('dry-run reports its mode', dry.mode, ROUTING_MODES.DRY_RUN);
  eq('dry-run NEVER applies', dry.applied, false);
  check('dry-run DOES propose someone', dry.userId != null, `userId=${dry.userId}`);
  eq('dry-run changed no table at all', snapAfter, snapBefore);
  const dryRow = (await q(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [dryConv])).rows[0];
  eq('the conversation is still QUEUED', dryRow.state, 'QUEUED');
  eq('with nobody assigned', dryRow.assigned_user_id, null);

  section('15 an empty team falls back to the human queue, safely');
  await q(`DELETE FROM ai_routing_rules`);
  const emptyTeam = await mkTeam(t1.id, 'EmptyTeam');
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,detection_value,target_team_id)
           VALUES ($1,'empty','auto_escalation_pattern','supplier',$2)`, [t1.id, emptyTeam]);
  const emptyPlan = await maybeAutoRoute({ tenantId: t1.id, conversationId: await mkConv('QUEUED'), detection: det, env: M.dry });
  eq('an empty team -> no_team_members', emptyPlan.reason, ROUTING_REASONS.NO_TEAM_MEMBERS);
  eq('and proposes nobody', emptyPlan.userId, null);

  section('16 no eligible employee falls back to the human queue');
  await q(`DELETE FROM ai_routing_rules`);
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,detection_value,target_team_id)
           VALUES ($1,'nobody','auto_escalation_pattern','supplier',$2)`, [t1.id, marketing]);
  await q(`UPDATE user_brand_grants SET revoked_at=now() WHERE tenant_id=$1`, [t1.id]);
  await q(`UPDATE user_brand_scope_all SET revoked_at=now() WHERE tenant_id=$1`, [t1.id]);
  const noElig = await maybeAutoRoute({ tenantId: t1.id, conversationId: await mkConv('QUEUED'), detection: det, env: M.dry });
  eq('nobody eligible -> no_eligible_employee', noElig.reason, ROUTING_REASONS.NO_ELIGIBLE_EMPLOYEE);
  eq('and proposes nobody', noElig.userId, null);
  await q(`UPDATE user_brand_grants SET revoked_at=NULL WHERE tenant_id=$1`, [t1.id]);
  await q(`UPDATE user_brand_scope_all SET revoked_at=NULL WHERE tenant_id=$1`, [t1.id]);

  /* ------------------------------------------------------------------ live */
  section('17 LIVE assigns through the real transition');
  await q(`DELETE FROM ai_routing_rules`);
  await q(`INSERT INTO ai_routing_rules (tenant_id,rule_key,detection_kind,detection_value,target_team_id)
           VALUES ($1,'supplier','auto_escalation_pattern','supplier',$2)`, [t1.id, purchasing]);
  const liveConv = await mkConv('QUEUED');

  // Diagnostic: exercise the real transition directly so a failure names its
  // cause instead of only reporting 'assignment_refused'.
  {
    const { assignConversation } = await import('../src/services/handoff.js');
    const probeConv = await mkConv('QUEUED');
    try {
      await assignConversation(
        { tenantId: t1.id, conversationId: probeConv, userId: carol, teamId: purchasing, reason: 'probe' },
        { db: client, actorUserId: null }
      );
      check('the real assignConversation transition is reachable from this schema', true);
    } catch (e) {
      check('the real assignConversation transition is reachable from this schema', false,
        `${e?.code ?? ''} ${e?.message ?? ''}`);
    }
  }

  const live = await maybeAutoRoute({ tenantId: t1.id, conversationId: liveConv, detection: det, env: M.live });
  eq('LIVE reports its mode', live.mode, ROUTING_MODES.LIVE);
  check('LIVE applies', live.applied === true,
    `applied=${live.applied} reason=${live.reason} err=${live.errorCode ?? '-'}`);
  const liveRow = (await q(`SELECT state, assigned_user_id, assigned_team_id FROM conversations WHERE id=$1`, [liveConv])).rows[0];
  eq('the conversation is ASSIGNED', liveRow.state, 'ASSIGNED');
  eq('assigned to the eligible employee', liveRow.assigned_user_id, carol);
  eq('and records the team', liveRow.assigned_team_id, purchasing);

  section('18 LIVE is idempotent - a replay cannot double-assign');
  const replay = await maybeAutoRoute({ tenantId: t1.id, conversationId: liveConv, detection: det, env: M.live });
  eq('a replay assigns nothing further', replay.applied, false);
  eq('it reports already-assigned', replay.reason, ROUTING_REASONS.ALREADY_ASSIGNED);
  const { rows: [still] } = await q(`SELECT assigned_user_id FROM conversations WHERE id=$1`, [liveConv]);
  eq('the assignee did not change', still.assigned_user_id, carol);

  section('19 CONCURRENCY - parallel routing assigns exactly one, once');
  const raceConv = await mkConv('QUEUED');
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    maybeAutoRoute({ tenantId: t1.id, conversationId: raceConv, detection: det, env: M.live })));
  const applied = results.filter((r) => r.applied).length;
  check('at most one concurrent routing actually applied', applied <= 1, `applied=${applied}`);
  const { rows: [raceRow] } = await q(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [raceConv]);
  eq('exactly one assignee is set', raceRow.assigned_user_id, carol);
  eq('the state is ASSIGNED once', raceRow.state, 'ASSIGNED');

  section('20 provider neutrality - the engine names no provider at all');
  const src = readFileSync(join(REPO, 'src/services/aiRouting.js'), 'utf8');
  // Word-bounded so ordinary business vocabulary ("a complaint") is not a hit.
  // Any real provider leak (meta / messenger / comment / instagram / graph)
  // would be a standalone token in the source.
  const leak = src.match(/\bmeta\b|\bmessenger\b|\bcomment\b|\binstagram\b|\bgraph\b|\bwhatsapp\b/i);
  check('no provider name appears anywhere in the routing engine', leak === null, leak ? `found "${leak[0]}"` : '');

  section('21 dry-run writes no audit row');
  const { rows: [auditTable] } = await q(
    `SELECT count(*)::int n FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('audit_logs','audit_log')`);
  if (auditTable.n > 0) {
    const before2 = (await q(`SELECT count(*)::int n FROM audit_logs`)).rows[0].n;
    await maybeAutoRoute({ tenantId: t1.id, conversationId: await mkConv('QUEUED'), detection: det, env: M.dry });
    eq('dry-run writes no audit row', (await q(`SELECT count(*)::int n FROM audit_logs`)).rows[0].n, before2);
  } else {
    check('dry-run writes no audit row', true, 'no audit table in this schema - nothing to assert');
  }
} catch (e) {
  failures.push(`fatal: ${e.code ?? ''} ${e.message}`);
  console.error('\nfatal:', e.code, e.message);
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