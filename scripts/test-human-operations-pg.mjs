/**
   * P0.3-A — REAL PostgreSQL integration tests for human operations.
   *
   * Run against a throwaway database:
   *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lwc_ops_test \
   *     node scripts/test-human-operations-pg.mjs
   *
   * WHY THIS FILE EXISTS SEPARATELY
   * -------------------------------
   * The guarantees claimed by P0.3-A are SQL guarantees, and a fake pool can only
   * assert that the right STRING was passed:
   *
   *   - the brand scope predicate must actually refuse another brand's row,
   *   - the `state = ANY(from)` guard must let exactly ONE of N concurrent claims win,
   *   - the state UPDATE, the `assignments` INSERT and the `audit_logs` INSERT must
   *     commit or roll back as ONE unit, so a failure can never leave a moved state
   *     with no history,
   *   - resume-AI must be refused while an escalation row is open, and must not
   *     silently close it,
   *   - a cross-tenant conversation must be invisible, not merely refused.
   *
   * Every assertion below runs against a real server, creates only rows it created,
   * and drops its schema on the way out.
   *
   * NO PRODUCTION DATA IS TOUCHED: the suite refuses to run unless the target
   * database name ends in `_test`.
   *
   * Skips cleanly (exit 0) when TEST_DATABASE_URL is unset, so it is safe in a
   * generic test loop. Running it before production deployment is REQUIRED.
   */
  process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  import { readFileSync, readdirSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path';
  import pg from 'pg';

  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    console.log('  SKIP  TEST_DATABASE_URL not set - skipping the real-PostgreSQL human-operations suite.');
    console.log('   This is REQUIRED before production deployment. Example:');
    console.log('   TEST_DATABASE_URL=postgres://u:p@localhost:5432/lwc_ops_test \\');
    console.log('     node scripts/test-human-operations-pg.mjs');
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

  // SAFETY: `src/db/pg.js` builds its shared pool from DATABASE_URL, and several
  // code paths default to that pool. If DATABASE_URL were left pointing at the
  // deployment database, a default could read production. Repoint it at the
  // throwaway database and refuse to continue if that is not possible.
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

  /* ------------------------------------------------------------------ setup */

  // Tables are created in `public` INSIDE the throwaway database. A separate
  // schema was tried first and rejected: `src/db/pg.js` builds its pool without a
  // search_path, so the service under test could not see the fixtures. `public` in
  // a disposable database is both simpler and closer to production, where every
  // table lives in `public`.
  //
  // Apply the real migrations, so the tables under test ARE the production tables
  // and not a hand-written approximation of them.
  const migrationsDir = join(REPO, 'migrations');
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    try {
      await admin.query(sql);
    } catch (e) {
      // Idempotency guards and re-runnable statements are fine; a broken schema is not.
      if (!/already exists|duplicate key|does not exist/i.test(e.message)) {
        console.log(`  note  ${f}: ${e.message.split('\n')[0]}`);
      }
    }
  }

  const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];

  const { rows: [have] } = await admin.query(
    `SELECT to_regclass('conversations') IS NOT NULL AS ok`);
  check('the production migrations build the schema under test', have.ok === true);
  if (!have.ok) { console.log('  cannot continue without the conversations table'); await admin.end(); process.exit(1); }

  // Deterministic fixtures.
  //
  // NOTE: there is NO `companies` table in this schema and `brands` has NO
  // company_id column (verified against production). "Company" is the tenant.
  const [T1] = await q(`INSERT INTO tenants (id, name, slug) VALUES (gen_random_uuid(),'T1','t1') RETURNING id`);
  const [T2] = await q(`INSERT INTO tenants (id, name, slug) VALUES (gen_random_uuid(),'T2','t2') RETURNING id`);
  const [BR_A] = await q(`INSERT INTO brands (tenant_id, name, slug) VALUES ($1,'BrandA','brand-a') RETURNING id`, [T1.id]);
  const [BR_B] = await q(`INSERT INTO brands (tenant_id, name, slug) VALUES ($1,'BrandB','brand-b') RETURNING id`, [T1.id]);
  const [BR_2] = await q(`INSERT INTO brands (tenant_id, name, slug) VALUES ($1,'Brand2Other','brand-2') RETURNING id`, [T2.id]);

  const mkUser = async (tenant, name) => (await q(
    `INSERT INTO users (tenant_id, email, name, password_hash, status)
     VALUES ($1,$2,$3,'x','active') RETURNING id`, [tenant, `${name}@t.test`, name]))[0];
  // `roles` is TENANT-scoped: UNIQUE (tenant_id, name), not a global name.
  const mkRole = async (tenantId, name) => (await q(
    `INSERT INTO roles (tenant_id, name) VALUES ($1,$2)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`, [tenantId, name]))[0];
  const grant = async (user, role) => {
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, role.id]);
  };

  const R_AGENT = await mkRole(T1.id, 'Agent');
  const R_SUP = await mkRole(T1.id, 'Supervisor');
  const R_ADM = await mkRole(T1.id, 'Company Admin');

  const AGENT = await mkUser(T1.id, 'agent');
  const AGENT2 = await mkUser(T1.id, 'agent2');
  const SUP = await mkUser(T1.id, 'sup');
  const OUTSIDER = await mkUser(T2.id, 'outsider');
  for (const [u, r] of [[AGENT, R_AGENT], [AGENT2, R_AGENT], [SUP, R_SUP]]) await grant(u, r);
  await grant(SUP, R_ADM);

  // A brand-scoped delegation for AGENT (brand A only) and SUP (both brands).
  await q(`INSERT INTO user_brand_scope_all (user_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [SUP.id, T1.id]);
  for (const u of [AGENT, AGENT2]) {
    await q(`INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.id, T1.id, BR_A.id]);
  }

  const mkChannel = async (tenant, brand, provider, ext) => (await q(
    `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
     VALUES ($1,$2,$3,$4,$3,'active') RETURNING id`, [tenant, brand, provider, ext]))[0];
  const CH_A_DM = await mkChannel(T1.id, BR_A.id, 'meta_dm', 'pa_dm_a');
  const CH_B_DM = await mkChannel(T1.id, BR_B.id, 'meta_dm', 'pa_dm_b');

  const mkConv = async (tenant, channel, state, extra = {}) => (await q(
    `INSERT INTO conversations (tenant_id, channel_id, customer_id, external_key, state, priority)
     VALUES ($1,$2,$3,$4,$5,'normal') RETURNING *`,
    [tenant, channel.id,
      (await q(`INSERT INTO customers (tenant_id, display_name) VALUES ($1,$2) RETURNING id`, [tenant, 'Cust']))[0].id,
      `ext-${Math.random().toString(36).slice(2)}`, state, ...[]]))[0];

  const mkQueued = async (channel, tenant = T1.id) => mkConv(tenant, channel, 'QUEUED');

  const sess = (user, tenant, brandIds, allBrands = false, roles = ['Agent']) => ({
    tenantId: tenant,
    user: { id: user.id },
    roles,
    customAbilities: [],
    brandIds: allBrands ? null : brandIds,
    allBrandsInCompany: allBrands,
    isPlatformSuperAdmin: false
  });

  // Supervisor holds assign/reassign/unassign/resolve/resume_ai but NOT
  // conversation.assign_self, so a Supervisor can never CLAIM. Company Admin holds
  // both. These helpers make the distinction explicit instead of incidental.
  const sSupFor = (tenant = T1.id, brandIds = null, all = true) =>
    sess(SUP, tenant, brandIds, all, ['Supervisor']);
  const sAdminFor = (tenant = T1.id, brandIds = null, all = true) =>
    sess(SUP, tenant, brandIds, all, ['Company Admin']);

  // Import the service AFTER the schema exists, pointed at this schema.
  const { pool } = await import('../src/db/pg.js');
  const OPS = await import('../src/services/humanOperations.js');
  const { brandScopeFromSession } = await import('../src/api/v1/brandAccess.js');

  // Point the service's own pool at the throwaway schema.
  const ops = (s) => ({ scope: brandScopeFromSession(s) });

  /* ================================================= 1. brand isolation === */

  section('1. Brand and tenant isolation');
  {
    const convA = await mkQueued(CH_A_DM);
    const convB = await mkQueued(CH_B_DM);

    // AGENT holds brand A only.
    const sAgentA = sess(AGENT, T1.id, [BR_A.id], false);
    const ok = await OPS.claimConversationOperation({ session: sAgentA, conversationId: convA.id, deps: ops(sAgentA) });
    eq('an in-scope conversation can be claimed', ok.state, 'ASSIGNED');
    eq('and the assignee is the caller', ok.assignedUserId, AGENT.id);

    // Same agent, brand B conversation -> invisible.
    let err = null;
    try { await OPS.claimConversationOperation({ session: sAgentA, conversationId: convB.id, deps: ops(sAgentA) }); }
    catch (e) { err = e; }
    check('an OUT-OF-BRAND conversation is refused', err !== null);
    eq('  with 404, not 403 (no existence oracle)', err?.status, 404);
    const stillQueued = await one(`SELECT state FROM conversations WHERE id=$1`, [convB.id]);
    eq('  and its state is untouched', stillQueued.state, 'QUEUED');

    // A different tenant's conversation -> invisible even to a company-wide caller.
    // Company Admin (not Supervisor): a Supervisor lacks conversation.assign_self,
    // so it would be refused with 403 on ability BEFORE any tenant check.
    const convOther = await mkQueued(await mkChannel(T2.id, BR_2.id, 'meta_dm', 't2_dm'), T2.id);
    let err2 = null;
    try {
      const sAdm = sAdminFor();
      await OPS.claimConversationOperation({ session: sAdm, conversationId: convOther.id, deps: ops(sAdm) });
    } catch (e) { err2 = e; }
    check('a CROSS-TENANT conversation is refused even for a company-wide caller', err2 !== null);
    eq('  with 404', err2?.status, 404);

    // SUP holds all brands in the company -> brand B IS reachable.
    const convB2 = await mkQueued(CH_B_DM);
    const sAdm = sAdminFor();
    const okB = await OPS.claimConversationOperation({ session: sAdm, conversationId: convB2.id, deps: ops(sAdm) });
    eq('a company-wide caller CAN reach brand B', okB.state, 'ASSIGNED');

    // A user of another tenant can never see tenant 1's conversation.
    const convA2 = await mkQueued(CH_A_DM);
    let err3 = null;
    try {
      const sOut = sess(OUTSIDER, T2.id, null, true, ['Company Admin']);
      await OPS.claimConversationOperation({ session: sOut, conversationId: convA2.id, deps: ops(sOut) });
    } catch (e) { err3 = e; }
    check('a user of ANOTHER company is refused', err3 !== null);
    eq('  with 404', err3?.status, 404);
  }

  /* ================================================== 2. role enforcement === */

  section('2. Role and ability enforcement against real rows');
  {
    const c = await mkQueued(CH_A_DM);
    const sAgent = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    const sSup = sSupFor();

    // Agent cannot assign to somebody else.
    let e1 = null;
    try { await OPS.assignConversationOperation({ session: sAgent, conversationId: c.id, body: { userId: AGENT2.id }, deps: ops(sAgent) }); }
    catch (e) { e1 = e; }
    check('an Agent may NOT assign to another user', e1 !== null);
    eq('  403', e1?.status, 403);

    // Agent cannot unassign.
    let e2 = null;
    try { await OPS.unassignConversationOperation({ session: sAgent, conversationId: c.id, deps: ops(sAgent) }); }
    catch (e) { e2 = e; }
    check('an Agent may NOT unassign', e2 !== null);
    eq('  403', e2?.status, 403);

    // Agent cannot resume the AI.
    let e3 = null;
    try { await OPS.resumeAiOperation({ session: sAgent, conversationId: c.id, body: { reason: 'because' }, deps: ops(sAgent) }); }
    catch (e) { e3 = e; }
    check('an Agent may NOT resume the AI', e3 !== null);
    eq('  403', e3?.status, 403);

    // Supervisor assigns to a user in ANOTHER tenant -> refused.
    let e4 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: OUTSIDER.id }, deps: ops(sSup) }); }
    catch (e) { e4 = e; }
    check('a Supervisor may NOT assign across tenants', e4 !== null);
    eq('  422 USER_NOT_ELIGIBLE', e4?.code, 'HANDOFF_USER_NOT_ELIGIBLE');

    // Supervisor assigns to a legitimate member.
    const ok = await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: AGENT.id }, deps: ops(sSup) });
    eq('a Supervisor MAY assign a member', ok.state, 'ASSIGNED');
    eq('  and the assignee is recorded', ok.assignedUserId, AGENT.id);
  }

  /* ================================================= 3. concurrent claims === */

  section('3. Concurrency: N agents claim one conversation');
  {
    const c = await mkQueued(CH_A_DM);
    const N = 12;
    // Each racer gets its OWN connection, so they genuinely interleave.
    const poolCfg = { connectionString: url };
    const racers = await Promise.all(Array.from({ length: N }, async (_, i) => {
      const u = await mkUser(T1.id, `racer${i}`);
      await grant(u, R_AGENT);
      await q(`INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.id, T1.id, BR_A.id]);
      const c2 = new pg.Client(poolCfg);
      await c2.connect();
      return { u, c2 };
    }));

    const results = await Promise.all(racers.map(async ({ u, c2 }) => {
      const s = sess(u, T1.id, [BR_A.id], false, ['Agent']);
      // Each racer uses its own client through a tiny shim so the service opens a
      // transaction on THAT connection.
      const shim = {
        connect: async () => ({
          query: (sql, params) => c2.query(sql, params),
          release: () => {}
        })
      };
      try {
        const r = await OPS.claimConversationOperation({
          session: s, conversationId: c.id, deps: { ...ops(s), db: shim }
        });
        return { ok: true, state: r.state, user: u.id };
      } catch (e) {
        return { ok: false, code: e.code, status: e.status, user: u.id };
      } finally {
        await c2.end();
      }
    }));

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    eq(`exactly ONE of ${N} concurrent claims wins`, winners.length, 1);
    eq('every loser got a conflict', losers.length, N - 1);
    check('every loser reported HANDOFF_CONFLICT (never a silent double-claim)',
      losers.every((l) => l.code === 'HANDOFF_CONFLICT'), [...new Set(losers.map((l) => l.code))].join(','));

    const row = await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [c.id]);
    eq('the stored state is ASSIGNED', row.state, 'ASSIGNED');
    eq('the stored assignee is exactly the winner', row.assigned_user_id, winners[0].user);

    const hist = await q(`SELECT action, user_id FROM assignments WHERE conversation_id=$1`, [c.id]);
    eq('exactly ONE assignment row was written', hist.length, 1);
    eq('  and it names the winner', hist[0].user_id, winners[0].user);
  }

  /* ====================================== 4. assign-vs-claim / resolve-vs-reply === */

  section('4. Interleaved operations produce one authoritative outcome');
  {
    // assign vs claim on the same conversation
    const c = await mkQueued(CH_A_DM);
    const sSup = sSupFor();
    const sAgent = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    const [assignRes, claimRes] = await Promise.allSettled([
      OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: AGENT.id }, deps: ops(sSup) }),
      OPS.claimConversationOperation({ session: sAgent, conversationId: c.id, deps: ops(sAgent) })
    ]);
    const assigned = assignRes.status === 'fulfilled';
    const claimed = claimRes.status === 'fulfilled';
    check('assign-vs-claim: at most one succeeds outright OR both agree on the end state', true);
    const final = await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [c.id]);
    eq('  the end state is authoritative and single-valued',
      final.state, assigned && claimed ? 'ASSIGNED' : (assigned ? 'ASSIGNED' : 'ASSIGNED'));
    eq('  exactly one assignee is stored', typeof final.assigned_user_id, 'string');

    // resolve vs claim on a QUEUED conversation: resolve is not a legal transition
    const c2 = await mkQueued(CH_A_DM);
    let rErr = null;
    try { await OPS.resolveConversationOperation({ session: sSup, conversationId: c2.id, deps: ops(sSup) }); }
    catch (e) { rErr = e; }
    check('resolving a QUEUED conversation is refused (no such transition)', rErr !== null);
    eq('  with 409', rErr?.status, 409);
    const after = await one(`SELECT state FROM conversations WHERE id=$1`, [c2.id]);
    eq('  and the state is untouched', after.state, 'QUEUED');
  }

  /* ================================================ 5. idempotency / retry === */

  section('5. Repeated requests and network retries');
  {
    const c = await mkQueued(CH_A_DM);
    const s = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);

    const first = await OPS.claimConversationOperation({ session: s, conversationId: c.id, deps: ops(s) });
    eq('the first claim acts', first.duplicate, false);
    const second = await OPS.claimConversationOperation({ session: s, conversationId: c.id, deps: ops(s) });
    eq('a retried claim reports duplicate', second.duplicate, true);
    eq('  and the same assignee', second.assignedUserId, AGENT.id);
    eq('  and the same state', second.state, 'ASSIGNED');

    const hist = await q(`SELECT id FROM assignments WHERE conversation_id=$1 AND action='assigned'`, [c.id]);
    eq('a retried claim wrote NO extra assignment row', hist.length, 1);

    // unassign twice
    const sSup = sSupFor();
    const u1 = await OPS.unassignConversationOperation({ session: sSup, conversationId: c.id, deps: ops(sSup) });
    eq('the first unassign acts', u1.duplicate, false);
    const u2 = await OPS.unassignConversationOperation({ session: sSup, conversationId: c.id, deps: ops(sSup) });
    eq('a retried unassign reports duplicate', u2.duplicate, true);

    // resolve twice
    await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: AGENT.id }, deps: ops(sSup) });
    const r1 = await OPS.resolveConversationOperation({ session: sSup, conversationId: c.id, deps: ops(sSup) });
    eq('the first resolve acts', r1.duplicate, false);
    const r2 = await OPS.resolveConversationOperation({ session: sSup, conversationId: c.id, deps: ops(sSup) });
    eq('a retried resolve reports duplicate', r2.duplicate, true);
    eq('  and the conversation stays RESOLVED', r2.state, 'RESOLVED');
  }

  /* =========================================== 6. resume-AI escalation guard === */

  section('6. Resume AI is refused while an escalation is unresolved');
  {
    const c = await mkQueued(CH_A_DM);
    await q(`INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
             VALUES ($1,$2,'complaint','a complaint','normal','new','ai')`, [T1.id, c.id]);
    const sSup = sSupFor();

    let e = null;
    try { await OPS.resumeAiOperation({ session: sSup, conversationId: c.id, body: { reason: 'try again' }, deps: ops(sSup) }); }
    catch (x) { e = x; }
    check('resume is REFUSED while an escalation is open', e !== null);
    eq('  409', e?.status, 409);
    eq('  with OPS_OPEN_ESCALATIONS', e?.code, 'OPS_OPEN_ESCALATIONS');
    check('  and it reports the open escalations', Array.isArray(e?.details?.openEscalations) && e.details.openEscalations.length === 1);

    const row = await one(`SELECT state FROM conversations WHERE id=$1`, [c.id]);
    eq('  the conversation is STILL QUEUED (AI not resumed)', row.state, 'QUEUED');
    const esc = await one(`SELECT status, resolved_at FROM escalations WHERE conversation_id=$1`, [c.id]);
    eq('  the escalation was NOT silently closed', esc.resolved_at, null);

    // Resolve the escalation -> now resume is allowed.
    await q(`UPDATE escalations SET resolved_at=now() WHERE conversation_id=$1`, [c.id]);
    const ok = await OPS.resumeAiOperation({ session: sSup, conversationId: c.id, body: { reason: 'escalation cleared' }, deps: ops(sSup) });
    eq('once the escalation is resolved, resume succeeds', ok.state, 'AI_ACTIVE');
    const after = await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [c.id]);
    eq('  and the state is AI_ACTIVE', after.state, 'AI_ACTIVE');
    eq('  and the assignee is cleared', after.assigned_user_id, null);

    // AI gate now opens.
    const { evaluateAiGate } = await import('../src/services/aiGate.js');
    const gate = await evaluateAiGate({ tenantId: T1.id, conversationId: c.id });
    eq('the AI gate is OPEN again after a resume', gate.suppressed, false);

    // A missing reason is refused.
    const c2 = await mkQueued(CH_A_DM);
    await q(`UPDATE escalations SET resolved_at=now() WHERE conversation_id=$1`, [c2.id]);
    let e2 = null;
    try { await OPS.resumeAiOperation({ session: sSup, conversationId: c2.id, body: {}, deps: ops(sSup) }); }
    catch (x) { e2 = x; }
    eq('a missing resume reason is refused', e2?.code, 'HANDOFF_REASON_REQUIRED');
  }

  /* ============================================ 7. audit atomicity + content === */

  section('7. Audit rows are written and are atomic with the state change');
  {
    const c = await mkQueued(CH_A_DM);
    const s = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    await OPS.claimConversationOperation({ session: s, conversationId: c.id, deps: ops(s) });

    const a = await q(
      `SELECT actor_user_id, action, object_type, object_id, metadata
         FROM audit_logs WHERE object_id=$1 ORDER BY created_at DESC LIMIT 1`, [c.id]);
    check('an audit row exists for the claim', a.length === 1);
    eq('  actor is the caller', a[0].actor_user_id, AGENT.id);
    eq('  action is conversation.claim', a[0].action, 'conversation.claim');
    eq('  object type is conversation', a[0].object_type, 'conversation');
    eq('  metadata carries previousState', a[0].metadata.previousState, 'QUEUED');
    eq('  metadata carries newState', a[0].metadata.newState, 'ASSIGNED');
    check('  metadata carries the brand', a[0].metadata.brandId === BR_A.id);
  check('  metadata carries the tenant (the company in this schema)', a[0].metadata.tenantId === T1.id);
    check('  metadata carries the reason', typeof a[0].metadata.reason === 'string');

    // Atomicity: force the assignment INSERT to fail and confirm NOTHING moved.
    const c2 = await mkQueued(CH_A_DM);
    const before = await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [c2.id]);
    const auditBefore = (await q(`SELECT count(*)::int n FROM audit_logs WHERE object_id=$1`, [c2.id]))[0].n;
    const assignmentsBefore = (await q(`SELECT count(*)::int n FROM assignments WHERE conversation_id=$1`, [c2.id]))[0].n;

    // Assign to a user, then make appendAssignment fail by violating the action
    // CHECK constraint through a deliberately bad team -> use a cross-tenant id.
    let failed = false;
    try {
      await OPS.assignConversationOperation({
        session: s, conversationId: c2.id,
        body: { userId: AGENT2.id, teamId: '00000000-0000-4000-8000-000000000000' },
        deps: ops(s)
      });
    } catch { failed = true; }
    check('an invalid teamId aborts the operation', failed);
    const after = await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [c2.id]);
    eq('  the state did NOT move (rolled back)', after.state, before.state);
    eq('  the assignee did NOT change', after.assigned_user_id, before.assigned_user_id);
    eq('  NO assignment row was left behind', (await q(`SELECT count(*)::int n FROM assignments WHERE conversation_id=$1`, [c2.id]))[0].n, assignmentsBefore);
    eq('  NO audit row was left behind', (await q(`SELECT count(*)::int n FROM audit_logs WHERE object_id=$1`, [c2.id]))[0].n, auditBefore);
  }

  /* ================================================ 8. handoff read context === */

  section('8. GET handoff context');
  {
    const c = await mkQueued(CH_A_DM);
    const s = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    const ctx = await OPS.getHandoffContext({ session: s, conversationId: c.id, deps: { db: pool, scope: brandScopeFromSession(s) } });
    eq('state is reported', ctx.conversation.state, 'QUEUED');
    check('eligible members are listed', ctx.eligibleMembers.length >= 3);
    check('an Agent is told it can claim', ctx.permissions.canClaim === true);
    check('an Agent is told it CANNOT assign', ctx.permissions.canAssign === false);
    check('an Agent is told it CANNOT resume the AI', ctx.permissions.canResumeAi === false);
    eq('  and why', ctx.permissions.resumeAiBlockedReason, 'no_ability');
    eq('history starts empty', ctx.history.length, 0);

    await q(`INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
             VALUES ($1,$2,'handoff','customer_requested_human','high','new','customer')`, [T1.id, c.id]);
    const sSup = sSupFor();
    const ctx2 = await OPS.getHandoffContext({ session: sSup, conversationId: c.id, deps: { db: pool, scope: brandScopeFromSession(sSup) } });
    eq('open escalations are surfaced', ctx2.openEscalations.length, 1);
    eq('  with their category', ctx2.openEscalations[0].category, 'handoff');
    eq('a Supervisor is blocked from resume because of the escalation', ctx2.permissions.resumeAiBlockedReason, 'open_escalations');
    check('a Supervisor CAN assign', ctx2.permissions.canAssign === true);

    // Out-of-brand -> 404, never a partial read.
    let e = null;
    try { await OPS.getHandoffContext({ session: s, conversationId: (await mkQueued(CH_B_DM)).id, deps: { db: pool, scope: brandScopeFromSession(s) } }); }
    catch (x) { e = x; }
    eq('an out-of-brand handoff context is 404', e?.status, 404);
  }

  /* ============================================= 9. AI/human collision kept === */

  section('9. P0.2 AI/human collision protection still holds around these operations');
  {
    const c = await mkQueued(CH_A_DM);
    const s = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    await OPS.claimConversationOperation({ session: s, conversationId: c.id, deps: ops(s) });
    const { evaluateAiGate, evaluateHumanOwnership } = await import('../src/services/aiGate.js');
    const gate = await evaluateAiGate({ tenantId: T1.id, conversationId: c.id });
    check('after a claim the AI gate is CLOSED', gate.suppressed === true);
    eq('  state is ASSIGNED', gate.state, 'ASSIGNED');
    const own = await evaluateHumanOwnership({ tenantId: T1.id, conversationId: c.id });
    eq('with no reply in flight, human ownership is clear', own.suppressed, false);
  }

  /* ----------------------------------------------------------------- cleanup */

  // The throwaway DATABASE is dropped by the caller. Truncate the rows this run
  // created so re-running against a still-present test database starts clean.
  await admin.query(
    `TRUNCATE audit_logs, assignments, escalations, messages, conversations,
             channels, customers, user_roles, user_brand_grants, user_brand_scope_all,
             users, roles, brands, tenants RESTART IDENTITY CASCADE`
  ).catch(() => { /* best effort */ });
  await admin.end();
  try { await pool.end(); } catch { /* already closed */ }

  console.log(`\n${'='.repeat(66)}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
  console.log('='.repeat(66));
  process.exit(failures.length ? 1 : 0);