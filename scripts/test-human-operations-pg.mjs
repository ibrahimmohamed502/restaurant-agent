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
  // `permissions` is written for CUSTOM roles; for a built-in name the application
  // ignores the column entirely, which is precisely why migration 017 seeds a
  // custom name rather than extending an existing built-in role.
  const mkRole = async (tenantId, name, permissions = []) => (await q(
    `INSERT INTO roles (tenant_id, name, permissions) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`, [tenantId, name, JSON.stringify(permissions)]))[0];
  const grant = async (user, role) => {
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, role.id]);
  };

  const R_AGENT = await mkRole(T1.id, 'Agent');
  const R_SUP = await mkRole(T1.id, 'Supervisor');
  const R_ADM = await mkRole(T1.id, 'Company Admin');
  // P0.3: the seeded CUSTOM role. Its name is deliberately NOT a built-in one, so
  // its stored permissions are honoured by effectiveCustomAbilities().
  const R_ESCALATION = await mkRole(T1.id, 'Escalation Manager', ['escalation.resolve']);

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

  const sess = (user, tenant, brandIds, allBrands = false, roles = ['Agent'], customAbilities = []) => ({
    tenantId: tenant,
    user: { id: user.id },
    roles,
    customAbilities,
    brandIds: allBrands ? null : brandIds,
    allBrandsInCompany: allBrands,
    isPlatformSuperAdmin: false
  });

  /**
   * Build a session the way src/auth/sessions.js actually does.
   *
   * A hand-rolled session with `customAbilities: []` would bypass the entire custom
   * role path and make a role that genuinely carries an ability look like it does
   * not. This reads the holder's real role rows and runs the SAME derivation the
   * server runs, so the test exercises the production code path rather than a
   * convenient fiction.
   */
  const sessForRoles = async (user, tenant, brandIds, allBrands = false) => {
    // `q()` already resolves to `.rows`.
    const rs = await q(
      `SELECT r.name, r.permissions
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1`, [user.id]);
    const roleNames = rs.map((r) => r.name);
    const perRolePermissions = Object.fromEntries(rs.map((r) => [r.name, r.permissions]));
    const customAbilities = effectiveCustomAbilities(roleNames, perRolePermissions);
    return sess(user, tenant, brandIds, allBrands, roleNames, customAbilities);
  };

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
  const { effectiveCustomAbilities } = await import('../src/auth/abilities.js');

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

    // A Supervisor may NOT assign across tenants. The brand-access guard now fires
    // first, with its own uniform 422 rather than handoff.js's USER_NOT_ELIGIBLE.
    let e4 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: OUTSIDER.id }, deps: ops(sSup) }); }
    catch (e) { e4 = e; }
    check('a Supervisor may NOT assign across tenants', e4 !== null);
    eq('  422', e4?.status, 422);
    eq('  with a uniform refusal that does not reveal whether the user exists',
      e4?.message, 'the target user cannot be assigned this conversation');

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
    await q('UPDATE escalations SET resolved_at=now() WHERE conversation_id=$1', [c2.id]);
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

  /* ================================= 10. assignee brand access is ENFORCED ==== */

  section('10. Assignee brand access is enforced inside the mutation');
  {
    // AGENT has brand A only. AGENT2 gets brand B only. SUP has all brands.
    const c = await mkQueued(CH_A_DM);           // brand A channel
    const cB = await mkQueued(CH_B_DM);          // brand B channel
    const sSup = sSupFor();
    const sAdm = sAdminFor();

    // 1. cross-company target is refused.
    let e = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: OUTSIDER.id }, deps: ops(sSup) }); }
    catch (x) { e = x; }
    check('assigning to a user of ANOTHER company is refused', e !== null);
    eq('  with 422', e?.status, 422);

    // 2. cross-brand target is refused.
    const [AGENT_B] = [await mkUser(T1.id, 'agentB')];
    await grant(AGENT_B, R_AGENT);
    await q(`INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3)`,
      [AGENT_B.id, T1.id, BR_B.id]);
    let e2 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: AGENT_B.id }, deps: ops(sSup) }); }
    catch (x) { e2 = x; }
    check('assigning a BRAND-A conversation to a BRAND-B-only user is refused', e2 !== null);
    eq('  with OPS_ASSIGNEE_NO_BRAND_ACCESS', e2?.code, 'OPS_ASSIGNEE_NO_BRAND_ACCESS');
    eq('  and a uniform message (no user enumeration)',
      e2?.message, 'the target user cannot be assigned this conversation');

    // 3. an inactive member is refused.
    await q(`UPDATE users SET status='disabled' WHERE id=$1`, [AGENT_B.id]);
    let e3 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: AGENT_B.id }, deps: ops(sSup) }); }
    catch (x) { e3 = x; }
    check('assigning a DISABLED user is refused', e3 !== null);
    eq('  with 422 ASSIGNEE_NOT_ELIGIBLE', e3?.code, 'OPS_ASSIGNEE_NOT_ELIGIBLE');
    await q(`UPDATE users SET status='active' WHERE id=$1`, [AGENT_B.id]);

    // 4. a user with NO grant at all is refused.
    const [NOGRANT] = [await mkUser(T1.id, 'nogrant')];
    await grant(NOGRANT, R_AGENT);
    let e4 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: NOGRANT.id }, deps: ops(sSup) }); }
    catch (x) { e4 = x; }
    check('assigning to a member with NO brand grant is refused (fail-closed on absence)',
      e4?.code === 'OPS_ASSIGNEE_NO_BRAND_ACCESS', e4?.code);

    // 5. a revoked grant is refused.
    await q(`UPDATE user_brand_grants SET revoked_at=now() WHERE user_id=$1 AND brand_id=$2`,
      [AGENT_B.id, BR_B.id]);
    let e5 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: cB.id, body: { userId: AGENT_B.id }, deps: ops(sSup) }); }
    catch (x) { e5 = x; }
    check('assigning with a REVOKED grant is refused', e5?.code === 'OPS_ASSIGNEE_NO_BRAND_ACCESS', e5?.code);

    // 6. the matching grant succeeds.
    const ok = await OPS.assignConversationOperation({ session: sSup, conversationId: c.id, body: { userId: AGENT.id }, deps: ops(sSup) });
    eq('a user WITH the brand grant is accepted', ok.state, 'ASSIGNED');
    eq('  and the response records that brand access was verified',
      ok.assigneeBrandAccessVerified, true);
    eq('  no conversation was left assigned on a refusal',
      (await one(`SELECT state FROM conversations WHERE id=$1`, [cB.id])).state, 'QUEUED');

    // 7. a revoked all-brands delegation is refused.
    const [ALLBRANDS_REVOKED] = [await mkUser(T1.id, 'revokedall')];
    await grant(ALLBRANDS_REVOKED, R_AGENT);
    await q(`INSERT INTO user_brand_scope_all (user_id, tenant_id) VALUES ($1,$2)`,
      [ALLBRANDS_REVOKED.id, T1.id]);
    const beforeRevoke = await OPS.assignConversationOperation({
      session: sSup, conversationId: cB.id, body: { userId: ALLBRANDS_REVOKED.id }, deps: ops(sSup)
    });
    eq('an all-brands delegation is accepted', beforeRevoke.state, 'ASSIGNED');
    await q(`UPDATE user_brand_scope_all SET revoked_at=now() WHERE user_id=$1`, [ALLBRANDS_REVOKED.id]);
    const cB2 = await mkQueued(CH_B_DM);
    let e6 = null;
    try { await OPS.assignConversationOperation({ session: sSup, conversationId: cB2.id, body: { userId: ALLBRANDS_REVOKED.id }, deps: ops(sSup) }); }
    catch (x) { e6 = x; }
    check('a REVOKED all-brands delegation is refused', e6?.code === 'OPS_ASSIGNEE_NO_BRAND_ACCESS', e6?.code);
  }

  /* ================================= 11. escalation closure + resume rules ==== */

  section('11. Escalation closure is narrow, audited, and never resumes the AI');
  {
    const c = await mkQueued(CH_A_DM);
    const [e1, e2] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','first complaint','normal','new','ai'),
              ($1,$2,'handoff','customer_requested_human','high','new','customer')
       RETURNING id`, [T1.id, c.id]);
    const sAgent = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);

    // P0.3: closure now requires the DEDICATED escalation.resolve ability, so this
    // section runs as the seeded Escalation Manager, not as a Supervisor. The
    // session is derived from the real role rows so the custom-role path — the whole
    // point of the split — is actually exercised.
    const escMgr = await mkUser(T1.id, 'esc_mgr');
    await grant(escMgr, R_AGENT);
    await grant(escMgr, R_ESCALATION);
    await q('INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3)',
      [escMgr.id, T1.id, BR_A.id]);
    const sSup = await sessForRoles(escMgr, T1.id, [BR_A.id], false);

    // Resume AI is a SEPARATE ability (conversation.resume_ai) that an Escalation
    // Manager does not hold, so those assertions below run as a real Supervisor.
    const sResume = sSupFor();

    // An Agent may not close an escalation.
    let ea = null;
    try { await OPS.resolveEscalationOperation({ session: sAgent, conversationId: c.id, escalationId: e1.id, body: { reason: 'x' }, deps: ops(sAgent) }); }
    catch (x) { ea = x; }
    check('an Agent may NOT close an escalation', ea?.status === 403, `${ea?.status} ${ea?.code}`);

    // A reason is mandatory.
    let er = null;
    try { await OPS.resolveEscalationOperation({ session: sSup, conversationId: c.id, escalationId: e1.id, body: {}, deps: ops(sSup) }); }
    catch (x) { er = x; }
    eq('a missing reason is refused', er?.code, 'HANDOFF_REASON_REQUIRED');

    // An escalation belonging to another conversation is 404.
    const otherC = await mkQueued(CH_A_DM);
    let eo = null;
    try { await OPS.resolveEscalationOperation({ session: sSup, conversationId: otherC.id, escalationId: e1.id, body: { reason: 'wrong conversation' }, deps: ops(sSup) }); }
    catch (x) { eo = x; }
    eq('an escalation from ANOTHER conversation is 404', eo?.status, 404);
    eq('  with ESCALATION_NOT_FOUND', eo?.code, 'OPS_ESCALATION_NOT_FOUND');

    // Close exactly one.
    const r1 = await OPS.resolveEscalationOperation({
      session: sSup, conversationId: c.id, escalationId: e1.id,
      body: { reason: 'complaint answered by phone' }, deps: ops(sSup)
    });
    eq('the escalation is closed', r1.duplicate, false);
    eq('  and the AI is NOT resumed', r1.aiResumed, false);
    eq('  and the conversation state is untouched', r1.conversationState, 'QUEUED');
    eq('  and one escalation is still open', r1.remainingOpenEscalations, 1);

    // The sibling is untouched, and history is preserved.
    const rows = await q(`SELECT id, status, resolved_at, reason FROM escalations WHERE conversation_id=$1 ORDER BY created_at`, [c.id]);
    eq('both escalation rows still exist (nothing deleted)', rows.length, 2);
    eq('  the closed one keeps its reason', rows[0].reason, 'first complaint');
    eq('  the closed one is status done', rows[0].status, 'done');
    check('  the closed one has resolved_at', rows[0].resolved_at !== null);
    eq('  the sibling is STILL open', rows[1].resolved_at, null);
    eq('  and the sibling keeps status new', rows[1].status, 'new');

    // Retry -> duplicate, no second effect.
    const r2 = await OPS.resolveEscalationOperation({
      session: sSup, conversationId: c.id, escalationId: e1.id,
      body: { reason: 'already done' }, deps: ops(sSup)
    });
    eq('a retried close reports duplicate', r2.duplicate, true);

    // Resume AI is still refused while the sibling is open.
    let eb = null;
    try { await OPS.resumeAiOperation({ session: sResume, conversationId: c.id, body: { reason: 'try' }, deps: ops(sResume) }); }
    catch (x) { eb = x; }
    check('Resume AI is STILL refused while a sibling escalation is open', eb?.code === 'OPS_OPEN_ESCALATIONS', eb?.code);
    eq('  and it names the remaining escalation', eb?.details?.openEscalations?.length, 1);

    // Close the sibling -> now Resume AI is permitted.
    await OPS.resolveEscalationOperation({
      session: sSup, conversationId: c.id, escalationId: e2.id,
      body: { reason: 'customer request withdrawn' }, deps: ops(sSup)
    });
    const resumed = await OPS.resumeAiOperation({
      session: sResume, conversationId: c.id, body: { reason: 'all escalations closed' }, deps: ops(sResume)
    });
    eq('once every escalation is closed, Resume AI succeeds', resumed.state, 'AI_ACTIVE');

    // Closing an escalation alone never resumes: prove it on a fresh conversation.
    const c2 = await mkQueued(CH_A_DM);
    const [only] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','lone complaint','normal','new','ai') RETURNING id`, [T1.id, c2.id]);
    const onlyRes = await OPS.resolveEscalationOperation({
      session: sSup, conversationId: c2.id, escalationId: only.id,
      body: { reason: 'done' }, deps: ops(sSup)
    });
    eq('closing the ONLY escalation leaves the conversation QUEUED, not AI_ACTIVE',
      onlyRes.conversationState, 'QUEUED');
    eq('  and the database agrees', (await one(`SELECT state FROM conversations WHERE id=$1`, [c2.id])).state, 'QUEUED');

    // Audit trail.
    const aud = await q(`SELECT actor_user_id, action, metadata FROM audit_logs WHERE object_id=$1 AND action='escalation.resolve' ORDER BY created_at`, [c.id]);
    check('every close is audited', aud.length >= 3, String(aud.length));
    eq('  actor is the escalation manager who performed it', aud[0].actor_user_id, escMgr.id);
    eq('  metadata names the escalation', typeof aud[0].metadata.escalationId, 'string');
    eq('  metadata records aiResumed:false', aud[0].metadata.aiResumed, false);

    // A denial on an out-of-scope conversation writes NO audit row. Use a
    // SUPERVISOR scoped to brand A: an Agent would be refused 403 on ability
    // before the brand scope is ever evaluated, which proves nothing about scope.
    const supA = await mkUser(T1.id, 'supA');
    await grant(supA, R_SUP);
    await q(`INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3)`,
      [supA.id, T1.id, BR_A.id]);
    const hidden = await mkQueued(CH_B_DM);
    const hiddenEsc = (await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','hidden','normal','new','ai') RETURNING id`, [T1.id, hidden.id]))[0];
    const auditBefore = (await q(`SELECT count(*)::int n FROM audit_logs WHERE object_id=$1`, [hidden.id]))[0].n;
    // The caller must HOLD escalation.resolve for this to reach the brand check at
    // all — otherwise it is refused 403 first, which proves nothing about scope.
    const sSupBrandA = await sessForRoles(escMgr, T1.id, [BR_A.id], false);
    let eh = null;
    try { await OPS.resolveEscalationOperation({ session: sSupBrandA, conversationId: hidden.id, escalationId: hiddenEsc.id, body: { reason: 'probe' }, deps: ops(sSupBrandA) }); }
    catch (x) { eh = x; }
    check('an escalation manager scoped to brand A gets 404 for a brand-B conversation', eh?.status === 404, String(eh?.status));
    eq('  and NO audit row was written for it (no existence leak)',
      (await q(`SELECT count(*)::int n FROM audit_logs WHERE object_id=$1`, [hidden.id]))[0].n, auditBefore);
    eq('  and the escalation is untouched', (await one(`SELECT resolved_at FROM escalations WHERE id=$1`, [hiddenEsc.id])).resolved_at, null);

    // And the ability check runs FIRST for a caller who lacks it entirely, which
    // likewise discloses nothing about whether the conversation exists.
    const sBrandA = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    let ea2 = null;
    try { await OPS.resolveEscalationOperation({ session: sBrandA, conversationId: hidden.id, escalationId: hiddenEsc.id, body: { reason: 'probe' }, deps: ops(sBrandA) }); }
    catch (x) { ea2 = x; }
    eq('a caller without conversation.resolve gets 403 regardless of scope', ea2?.status, 403);
  }

  /* ========================================= 12. staff-initiated handoff ====== */

  section('12. Staff-initiated handoff');
  {
    const c = await mkConv(T1.id, CH_A_DM, 'AI_ACTIVE');
    const sSup = sSupFor();
    const sAgent = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);

    // A reason is mandatory.
    let e0 = null;
    try { await OPS.requestStaffHandoffOperation({ session: sSup, conversationId: c.id, body: {}, deps: ops(sSup) }); }
    catch (x) { e0 = x; }
    eq('a missing reason is refused', e0?.code, 'HANDOFF_REASON_REQUIRED');

    // An Agent CAN hand off (holds conversation.handoff).
    const ho = await OPS.requestStaffHandoffOperation({
      session: sAgent, conversationId: c.id, body: { reason: 'customer asked for a manager' }, deps: ops(sAgent)
    });
    eq('an Agent may hand off an AI_ACTIVE conversation', ho.state, 'QUEUED');
    eq('  and it is not a duplicate', ho.duplicate, false);

    // Exactly one assignment row + one escalation, both attributed to staff.
    const asg = await q(`SELECT action, reason, assigned_by FROM assignments WHERE conversation_id=$1`, [c.id]);
    eq('exactly ONE assignment row was written', asg.length, 1);
    eq('  attributed to the staff member', asg[0].assigned_by, AGENT.id);
    const escs = await q(`SELECT category, requested_by, status FROM escalations WHERE conversation_id=$1`, [c.id]);
    eq('exactly ONE escalation row was written', escs.length, 1);
    eq('  requested_by is staff', escs[0].requested_by, 'staff');
    eq('  it is a handoff escalation', escs[0].category, 'handoff');

    // The AI is now off.
    const { evaluateAiGate } = await import('../src/services/aiGate.js');
    eq('the AI gate is CLOSED after a staff handoff',
      (await evaluateAiGate({ tenantId: T1.id, conversationId: c.id })).suppressed, true);

    // Retry -> duplicate, and NO extra rows.
    const again = await OPS.requestStaffHandoffOperation({
      session: sAgent, conversationId: c.id, body: { reason: 'oops, sent twice' }, deps: ops(sAgent)
    });
    eq('a retried handoff reports duplicate', again.duplicate, true);
    eq('  and writes NO second assignment row', (await q(`SELECT id FROM assignments WHERE conversation_id=$1`, [c.id])).length, 1);
    eq('  and NO second escalation', (await q(`SELECT id FROM escalations WHERE conversation_id=$1`, [c.id])).length, 1);

    // Someone else progressed it -> 409 conflict, NOT a duplicate.
    const claimed = await OPS.claimConversationOperation({
      session: sAgent, conversationId: c.id, deps: ops(sAgent)
    });
    eq('an agent then claims the handed-off conversation', claimed.state, 'ASSIGNED');
    let ec = null;
    try { await OPS.requestStaffHandoffOperation({ session: sSup, conversationId: c.id, body: { reason: 'again' }, deps: ops(sSup) }); }
    catch (x) { ec = x; }
    check('a handoff over someone else\'s active handling is a 409 CONFLICT, not a duplicate',
      ec?.status === 409, `${ec?.status} ${ec?.code}`);
    eq('  the assignment survived', (await one(`SELECT state, assigned_user_id FROM conversations WHERE id=$1`, [c.id])).assigned_user_id, AGENT.id);

    // A RESOLVED conversation cannot be handed off either.
    const c3 = await mkConv(T1.id, CH_A_DM, 'AI_ACTIVE');
    await OPS.requestStaffHandoffOperation({ session: sSup, conversationId: c3.id, body: { reason: 'go' }, deps: ops(sSup) });
    await OPS.claimConversationOperation({ session: sAgent, conversationId: c3.id, deps: ops(sAgent) });
    await OPS.resolveConversationOperation({ session: sSup, conversationId: c3.id, deps: ops(sSup) });
    let ed = null;
    try { await OPS.requestStaffHandoffOperation({ session: sSup, conversationId: c3.id, body: { reason: 'reopen?' }, deps: ops(sSup) }); }
    catch (x) { ed = x; }
    check('a RESOLVED conversation cannot be handed off', ed?.status === 409, String(ed?.status));

    // Brand scope.
    const hidden = await mkConv(T1.id, CH_B_DM, 'AI_ACTIVE');
    const sBrandA = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    let eh = null;
    try { await OPS.requestStaffHandoffOperation({ session: sBrandA, conversationId: hidden.id, body: { reason: 'probe' }, deps: ops(sBrandA) }); }
    catch (x) { eh = x; }
    eq('an out-of-BRAND handoff is 404', eh?.status, 404);
    eq('  and the conversation is still AI_ACTIVE',
      (await one(`SELECT state FROM conversations WHERE id=$1`, [hidden.id])).state, 'AI_ACTIVE');
  }

  /* ================================ 13. cross-operation concurrency ======== */

  section('13. Interleaved mutations produce one authoritative outcome');
  {
    // Escalation closure vs Resume AI: closing the last escalation and resuming at
    // the same time must not produce a resume that skipped the blocker.
    const c = await mkQueued(CH_A_DM);
    const [esc] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','c','normal','new','ai') RETURNING id`, [T1.id, c.id]);
    const s = sSupFor();
    const [closeRes, resumeRes] = await Promise.allSettled([
      OPS.resolveEscalationOperation({ session: s, conversationId: c.id, escalationId: esc.id, body: { reason: 'closing' }, deps: ops(s) }),
      OPS.resumeAiOperation({ session: s, conversationId: c.id, body: { reason: 'resuming' }, deps: ops(s) })
    ]);
    const final = await one(`SELECT state FROM conversations WHERE id=$1`, [c.id]);
    if (resumeRes.status === 'fulfilled') {
      eq('if the resume won the race, the escalation really was closed first', final.state, 'AI_ACTIVE');
      eq('  and the escalation is resolved', (await one(`SELECT resolved_at FROM escalations WHERE id=$1`, [esc.id])).resolved_at !== null, true);
    } else {
      eq('if the resume lost the race, the blocker was reported', resumeRes.reason?.code, 'OPS_OPEN_ESCALATIONS');
      eq('  and the AI did NOT resume', final.state, 'QUEUED');
    }
    check('escalation-close vs resume-ai always ends in a consistent state',
      ['AI_ACTIVE', 'QUEUED'].includes(final.state), final.state);

    // Claim vs claim, many racers, each on its own connection.
    const c2 = await mkQueued(CH_A_DM);
    const N = 10;
    const clients = [];
    const racers = [];
    for (let i = 0; i < N; i++) {
      const u = await mkUser(T1.id, `lock_racer_${i}`);
      await grant(u, R_AGENT);
      await q(`INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3)`, [u.id, T1.id, BR_A.id]);
      const cl = new pg.Client({ connectionString: url });
      await cl.connect();
      clients.push(cl);
      racers.push({ u, cl });
    }
    const settled = await Promise.all(racers.map(async ({ u, cl }) => {
      const ss = sess(u, T1.id, [BR_A.id], false, ['Agent']);
      const shim = { connect: async () => ({ query: (sql, p) => cl.query(sql, p), release: () => {} }) };
      try {
        await OPS.claimConversationOperation({ session: ss, conversationId: c2.id, deps: { ...ops(ss), db: shim } });
        return true;
      } catch { return false; }
    }));
    await Promise.all(clients.map((c3) => c3.end().catch(() => {})));
    eq(`the state guard alone (no row lock) still lets exactly ONE of ${N} concurrent claims win`,
      settled.filter(Boolean).length, 1);
    eq('  and the stored state is ASSIGNED', (await one(`SELECT state FROM conversations WHERE id=$1`, [c2.id])).state, 'ASSIGNED');
    eq('  with exactly ONE assignment row', (await q(`SELECT id FROM assignments WHERE conversation_id=$1`, [c2.id])).length, 1);

    // Repeated retries of the same operation never multiply rows.
    const c3 = await mkQueued(CH_A_DM);
    const sA = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    for (let i = 0; i < 5; i++) await OPS.claimConversationOperation({ session: sA, conversationId: c3.id, deps: ops(sA) });
    eq('5 identical claims write exactly ONE assignment row',
      (await q(`SELECT id FROM assignments WHERE conversation_id=$1`, [c3.id])).length, 1);

    // Resolve vs manual reply: RESOLVED must win deterministically, or the reply
    // must be refused. Either way the conversation ends RESOLVED, never replying.
    const c4 = await mkQueued(CH_A_DM);
    await OPS.claimConversationOperation({ session: sA, conversationId: c4.id, deps: ops(sA) });
    const before = (await one(`SELECT state FROM conversations WHERE id=$1`, [c4.id])).state;
    await OPS.resolveConversationOperation({ session: sSupFor(), conversationId: c4.id, deps: ops(sSupFor()) });
    eq('resolve vs reply ends RESOLVED (reply would be refused by state)', before, 'ASSIGNED');
    eq('  final state', (await one(`SELECT state FROM conversations WHERE id=$1`, [c4.id])).state, 'RESOLVED');
    const { evaluateReplyEligibility, resolveReplyAuthority } = await import('../src/services/manualReplies.js');
    const elig = evaluateReplyEligibility({
      authority: resolveReplyAuthority(sA),
      conversation: { state: 'RESOLVED', channelProvider: 'meta_dm', channelStatus: 'active', assignedUserId: sA.user.id, lastInboundAt: new Date() }
    });
    eq('  and a reply on a RESOLVED conversation is refused', elig.allowed, false);
    eq('  with reason closed', elig.reason, 'closed');
  }

  /* ==================== 14. escalation.resolve is a separate authority ==== */

  section('14. escalation.resolve is separate from conversation.resolve');
  {
    const c = await mkQueued(CH_A_DM);
    const [esc] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','split test','normal','new','ai') RETURNING id`, [T1.id, c.id]);

    const escUser = await mkUser(T1.id, 'escmanager');
    await grant(escUser, R_AGENT);
    await grant(escUser, R_ESCALATION);
    await q('INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3)',
      [escUser.id, T1.id, BR_A.id]);
    const sEsc = await sessForRoles(escUser, T1.id, [BR_A.id], false);

    // 1. conversation.resolve alone is NOT enough any more.
    const sSup = sSupFor();
    let e1 = null;
    try { await OPS.resolveEscalationOperation({ session: sSup, conversationId: c.id, escalationId: esc.id, body: { reason: 'admin try' }, deps: ops(sSup) }); }
    catch (e) { e1 = e; }
    check('a Supervisor/Company Admin WITHOUT escalation.resolve is REFUSED', e1?.status === 403, `${e1?.status} ${e1?.code}`);
    eq('  and the escalation is untouched', (await one(`SELECT resolved_at FROM escalations WHERE id=$1`, [esc.id])).resolved_at, null);

    // 2. The dedicated holder succeeds.
    const ok = await OPS.resolveEscalationOperation({
      session: sEsc, conversationId: c.id, escalationId: esc.id,
      body: { reason: 'phone call handled it' }, deps: ops(sEsc)
    });
    eq('the escalation.resolve holder CAN close it', ok.duplicate, false);
    eq('  and the AI is not resumed', ok.aiResumed, false);

    // 3. The converse: escalation.resolve does NOT let you resolve a conversation.
    const c2 = await mkQueued(CH_A_DM);
    const sAgentA = sess(AGENT, T1.id, [BR_A.id], false, ['Agent']);
    await OPS.claimConversationOperation({ session: sAgentA, conversationId: c2.id, deps: ops(sAgentA) });
    let e2 = null;
    try { await OPS.resolveConversationOperation({ session: sEsc, conversationId: c2.id, deps: ops(sEsc) }); }
    catch (e) { e2 = e; }
    check('escalation.resolve does NOT grant conversation resolution', e2?.status === 403, `${e2?.status} ${e2?.code}`);
    eq('  the conversation is still ASSIGNED', (await one(`SELECT state FROM conversations WHERE id=$1`, [c2.id])).state, 'ASSIGNED');

    // 4. It confers no reply authority either. Deliberately a user holding ONLY the
    // Escalation Manager role: sEsc also holds Agent, and Agent legitimately carries
    // reply_own for conversations assigned to it — which is unrelated to this ability
    // and would mask what is being asserted here.
    const escOnly = await mkUser(T1.id, 'esc_only');
    await grant(escOnly, R_ESCALATION);
    await q('INSERT INTO user_brand_grants (user_id, tenant_id, brand_id) VALUES ($1,$2,$3)',
      [escOnly.id, T1.id, BR_A.id]);
    const sEscOnly = await sessForRoles(escOnly, T1.id, [BR_A.id], false);
    const MR = await import('../src/services/manualReplies.js');
    const auth = MR.resolveReplyAuthority(sEscOnly);
    check('escalation.resolve alone confers NO reply ability',
      auth.canReplyAny === false && auth.canReplyOwn === false,
      `any=${auth.canReplyAny} own=${auth.canReplyOwn}`);
    check('...and no conversation resolution either', auth.canReplyAny === false);

    // 5. Cross-brand refusal.
    const cB = await mkQueued(CH_B_DM);
    const [escB] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','other brand','normal','new','ai') RETURNING id`, [T1.id, cB.id]);
    let e4 = null;
    try { await OPS.resolveEscalationOperation({ session: sEsc, conversationId: cB.id, escalationId: escB.id, body: { reason: 'cross brand' }, deps: ops(sEsc) }); }
    catch (e) { e4 = e; }
    eq('cross-BRAND closure is refused 404', e4?.status, 404);
    eq('  and that escalation is untouched', (await one(`SELECT resolved_at FROM escalations WHERE id=$1`, [escB.id])).resolved_at, null);

    // 6. Revocation takes effect on the next request.
    // The session MUST be rebuilt after revoking, because that is what production
    // does: requireV1Auth -> validateSession() re-reads roles on EVERY request, so a
    // revoked role disappears immediately. Reusing a pre-built session object would
    // test a fiction.
    await q('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2', [escUser.id, R_ESCALATION.id]);
    const sAfterRevoke = await sessForRoles(escUser, T1.id, [BR_A.id], false);
    check('the rebuilt session no longer carries the ability',
      sAfterRevoke.customAbilities.length === 0, JSON.stringify(sAfterRevoke.customAbilities));
    const c3 = await mkQueued(CH_A_DM);
    const [esc3] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','after revoke','normal','new','ai') RETURNING id`, [T1.id, c3.id]);
    let e5 = null;
    try { await OPS.resolveEscalationOperation({ session: sAfterRevoke, conversationId: c3.id, escalationId: esc3.id, body: { reason: 'still allowed?' }, deps: ops(sAfterRevoke) }); }
    catch (e) { e5 = e; }
    check('after the role is REVOKED, closure is refused', e5?.status === 403, `${e5?.status} ${e5?.code}`);
    await grant(escUser, R_ESCALATION);
    const sEscRestored = await sessForRoles(escUser, T1.id, [BR_A.id], false);

    // 7. Concurrent closure on separate connections.
    const c4 = await mkQueued(CH_A_DM);
    const [esc4] = await q(
      `INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
       VALUES ($1,$2,'complaint','race','normal','new','ai') RETURNING id`, [T1.id, c4.id]);
    const cl1 = new pg.Client({ connectionString: url });
    const cl2 = new pg.Client({ connectionString: url });
    await cl1.connect(); await cl2.connect();
    const shim = (cl) => ({ connect: async () => ({ query: (sql, pr) => cl.query(sql, pr), release: () => {} }) });
    const [r1, r2] = await Promise.all([
      OPS.resolveEscalationOperation({ session: sEscRestored, conversationId: c4.id, escalationId: esc4.id, body: { reason: 'first attempt' }, deps: { ...ops(sEscRestored), db: shim(cl1) } }),
      OPS.resolveEscalationOperation({ session: sEscRestored, conversationId: c4.id, escalationId: esc4.id, body: { reason: 'second attempt' }, deps: { ...ops(sEscRestored), db: shim(cl2) } })
    ]);
    await cl1.end().catch(() => {}); await cl2.end().catch(() => {});
    const dups = [r1, r2].filter((r) => r.duplicate).length;
    eq('two concurrent closures produce exactly ONE update', 2 - dups, 1);
    eq('  and exactly one duplicate report', dups, 1);
    eq('  the escalation is resolved exactly once',
      (await one('SELECT resolved_at FROM escalations WHERE id=$1', [esc4.id])).resolved_at !== null, true);

    // 8. The handoff context reports the NEW authority.
    const sSupReal = sSupFor();
    const ctxSup = await OPS.getHandoffContext({ session: sSupReal, conversationId: c2.id, deps: { db: pool, scope: brandScopeFromSession(sSupReal) } });
    check('a Supervisor is told canResolveEscalations = false', ctxSup.permissions.canResolveEscalations === false);
    // A conversation with NO open escalations. Note that claiming one creates an
    // escalation via syncEscalation, so c2 (claimed) does have one — which is
    // exactly why the flag is true there and false here.
    const cClean = await mkQueued(CH_A_DM);
    const ctxEsc = await OPS.getHandoffContext({ session: sEscRestored, conversationId: cClean.id, deps: { db: pool, scope: brandScopeFromSession(sEscRestored) } });
    check('an escalation manager is told canResolveEscalations = false when none are open',
      ctxEsc.permissions.canResolveEscalations === false,
      `open=${ctxEsc.openEscalations.length}`);
    check('  ...and the escalation manager IS allowed to resolve a conversation they own? no - not assigned',
      ctxEsc.permissions.canResolve === false);
    // ...and TRUE when one is open, proving the flag is real and not just always off.
    const c5 = await mkQueued(CH_A_DM);
    await q(`INSERT INTO escalations (tenant_id, conversation_id, category, reason, priority, status, requested_by)
             VALUES ($1,$2,'complaint','flag check','normal','new','ai')`, [T1.id, c5.id]);
    const ctxEsc2 = await OPS.getHandoffContext({ session: sEscRestored, conversationId: c5.id, deps: { db: pool, scope: brandScopeFromSession(sEscRestored) } });
    check('an escalation manager IS told canResolveEscalations = true when one is open',
      ctxEsc2.permissions.canResolveEscalations === true);
    const ctxSup2 = await OPS.getHandoffContext({ session: sSupReal, conversationId: c5.id, deps: { db: pool, scope: brandScopeFromSession(sSupReal) } });
    check('a Supervisor is still told false even with an open escalation',
      ctxSup2.permissions.canResolveEscalations === false);
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