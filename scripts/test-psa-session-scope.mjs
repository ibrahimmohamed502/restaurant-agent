/**
 * Regression: the REAL Dashboard and Inbox routers must honour a Platform Super
 * Admin's EXPLICIT grant, and must keep every other authorisation rule intact.
 *
 * Why this file exists
 * --------------------
 * The R1 bug that emptied the production dashboard was invisible to every other
 * suite: all 1,556 existing assertions tested brandScopeFromSession() or the
 * grant service in isolation. Nothing ever drove the real routers with a
 * req.v1 shaped the way sessions.js actually builds one. This suite does exactly
 * that, so a precedence mistake cannot reach production again.
 *
 * Runs on a stub pool -> no database, no production writes, no network.
 *   node scripts/test-psa-session-scope.mjs
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pool } = await import('../src/db/pg.js');
const B = await import('../src/api/v1/brandAccess.js');
const A = await import('../src/auth/abilities.js');
const dashMod = await import('../src/api/v1/dashboard.js');
const convMod = await import('../src/api/v1/conversations.js');

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const T1 = U(1);              // company A (the one the owner belongs to)
const T2 = U(2);              // company B (must never leak into A)
const BRAND_A = U(21), BRAND_B = U(22), BRAND_OTHER = U(31);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  OK   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

// ---------------------------------------------------------------------------
// Fixture: conversations reachable only through their channel's brand.
// ---------------------------------------------------------------------------
const CHANNELS = [
  { id: U(41), tenant_id: T1, brand_id: BRAND_A, status: 'active' },
  { id: U(42), tenant_id: T1, brand_id: BRAND_B, status: 'active' },
  { id: U(43), tenant_id: T2, brand_id: BRAND_OTHER, status: 'active' }
];
const CONVERSATIONS = [
  { id: U(51), tenant_id: T1, channel_id: U(41), state: 'AI_ACTIVE', messages: 4 },
  { id: U(52), tenant_id: T1, channel_id: U(42), state: 'AI_ACTIVE', messages: 6 },
  { id: U(53), tenant_id: T2, channel_id: U(43), state: 'AI_ACTIVE', messages: 2 }
];
const AGENTS = [{ id: U(71), tenant_id: T1, brand_id: BRAND_A, name: 'LWC AI Agent', is_active: true }];
const KNOWLEDGE = [{ brand_id: BRAND_A, version: 1, updated_at: '2026-01-01T00:00:00Z' }];

/** Apply the exact predicate the routers emit, derived from the real bind params. */
function visible(tenantWide, brandIds, tenantId) {
  return CONVERSATIONS.filter((c) => {
    if (c.tenant_id !== tenantId) return false;
    const ch = CHANNELS.find((x) => x.id === c.channel_id);
    if (tenantWide === true) return true;
    return Boolean(ch && ch.brand_id) && brandIds.includes(ch.brand_id);
  });
}

pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  // Every brand-scoped query binds: $1 tenantWide, $2 brandIds[], $3 tenantId.
  const tenantWide = params[0];
  const brandIds = Array.isArray(params[1]) ? params[1] : [];
  const tenantId = params[2];

  if (/SELECT count\(\*\) FROM conversations c/.test(s)) {
    const rows = visible(tenantWide, brandIds, tenantId);
    return {
      rows: [{
        conversations: rows.length,
        messages: rows.reduce((a, c) => a + c.messages, 0),
        active_channels: CHANNELS.filter((c) => c.tenant_id === tenantId
          && (tenantWide === true || brandIds.includes(c.brand_id))).length,
        escalations: rows.length
      }]
    };
  }
  if (/FROM conversations c LEFT JOIN customers cu/.test(s)) {
    return {
      rows: visible(tenantWide, brandIds, tenantId).slice(0, 6).map((c) => ({
        id: c.id, state: c.state, language: null, last_message_at: null,
        customer_name: null, provider: 'meta_dm', last_text: null, last_message_at_ts: null
      }))
    };
  }
  if (/FROM knowledge_documents d/.test(s)) {
    const ok = tenantWide === true || brandIds.includes(KNOWLEDGE[0].brand_id);
    return { rows: ok ? KNOWLEDGE : [] };
  }
  if (/FROM ai_agents a/.test(s)) {
    const ok = tenantWide === true || brandIds.includes(AGENTS[0].brand_id);
    return { rows: ok ? AGENTS : [] };
  }
  if (/FROM conversations c JOIN channels ch/.test(s)) {
    return {
      rows: visible(tenantWide, brandIds, tenantId).slice(0, 50).map((c) => ({
        id: c.id, state: c.state, language: null, customer_name: null, provider: 'meta_dm',
        message_count: c.messages, last_text: null, last_message_at: null, channel_name: null
      }))
    };
  }
  return { rows: [] };
};

// ---------------------------------------------------------------------------
// Drive the real routers exactly as index.js requireV1Auth would.
// ---------------------------------------------------------------------------
function fakeRes() {
  const r = { _status: 200, _body: null };
  r.status = (c) => { r._status = c; return r; };
  r.json = (b) => { r._body = b; return r; };
  r.setHeader = () => r; r.set = () => r;
  return r;
}
async function call(router, path, v1) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  if (!layer) return { status: 'ROUTE-NOT-FOUND' };
  const res = fakeRes();
  const req = { v1, params: {}, query: {}, body: {}, headers: {}, cookies: {} };
  try {
    await new Promise((resolve, reject) => {
      let i = 0;
      const next = (e) => {
        if (e) return reject(e);
        if (i >= layer.route.stack.length) return resolve();
        try { layer.route.stack[i++].handle(req, res, next); } catch (x) { reject(x); }
      };
      next();
      setTimeout(resolve, 3000);
    });
  } catch (e) { return { status: 500, body: { thrown: e.message } }; }
  return { status: res._status, body: res._body };
}
const dash = () => dashMod.createDashboardRouter({ pool, getQueue: () => ({ available: false, failed: 0 }) });
const inbox = () => convMod.createConversationsRouter({ pool });

/** Exactly the object sessions.js builds, given these inputs. */
function sessionFor({ roles, tenantId, brandIds, allBrandsInCompany, isPSA }) {
  return {
    tenantId,
    user: { id: U(90), email: 'test@example.invalid', name: 'Test' },
    roles,
    sessionId: null,
    brandIds: allBrandsInCompany ? null : brandIds,
    allBrandsInCompany: allBrandsInCompany === true,
    isPlatformSuperAdmin: isPSA === true,
    customAbilities: []
  };
}

// ---------------------------------------------------------------------------
console.log('=== 1. PSA + explicit company-wide delegation (the reported bug) ===');
{
  const v1 = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T1,
    allBrandsInCompany: true, isPSA: true
  });
  check('scope resolves to tenant', B.brandScopeFromSession(v1).mode === 'tenant',
    JSON.stringify(B.brandScopeFromSession(v1)));

  const d = await call(dash(), '/', v1);
  check('dashboard returns HTTP 200', d.status === 200, String(d.status));
  check('dashboard shows company A conversations', d.body?.data?.kpis?.conversations === 2,
    JSON.stringify(d.body?.data?.kpis));
  check('dashboard shows company A messages', d.body?.data?.kpis?.messages === 10,
    JSON.stringify(d.body?.data?.kpis));
  check('dashboard shows the ai agent again', d.body?.data?.aiAgent?.name === 'LWC AI Agent',
    JSON.stringify(d.body?.data?.aiAgent));
  check('dashboard preview is populated', (d.body?.data?.conversations?.length ?? 0) === 2,
    String(d.body?.data?.conversations?.length));

  const i = await call(inbox(), '/', v1);
  check('inbox returns company A conversations', Array.isArray(i.body?.data) && i.body.data.length === 2,
    JSON.stringify(i.body?.data?.length));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. PSA with NO grant still sees nothing (the security invariant) ===');
{
  // Same person as section 1, but the delegation is gone.
  const v1 = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T1,
    brandIds: [], allBrandsInCompany: false, isPSA: true
  });
  const sc = B.brandScopeFromSession(v1);
  check('scope is zero brands', sc.mode === 'restricted' && sc.brandIds.length === 0, JSON.stringify(sc));
  const d = await call(dash(), '/', v1);
  check('dashboard returns HTTP 200', d.status === 200, String(d.status));
  check('dashboard is all zeros', d.body?.data?.kpis?.conversations === 0, JSON.stringify(d.body?.data?.kpis));
  check('ai agent is null', d.body?.data?.aiAgent === null);
  check('knowledge is null', d.body?.data?.knowledge?.brandId === null);
  const i = await call(inbox(), '/', v1);
  check('inbox is empty', Array.isArray(i.body?.data) && i.body.data.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. PSA with SPECIFIC brand grants (not only company-wide) ===');
{
  const v1 = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T1,
    brandIds: [BRAND_A], allBrandsInCompany: false, isPSA: true
  });
  const sc = B.brandScopeFromSession(v1);
  check('scope is restricted to exactly the granted brand',
    sc.mode === 'restricted' && sc.brandIds.length === 1 && sc.brandIds[0] === BRAND_A,
    JSON.stringify(sc));
  const d = await call(dash(), '/', v1);
  check('dashboard shows only the granted brand conversation', d.body?.data?.kpis?.conversations === 1,
    JSON.stringify(d.body?.data?.kpis));
  check('dashboard shows only the granted brand messages', d.body?.data?.kpis?.messages === 4,
    JSON.stringify(d.body?.data?.kpis));
  const i = await call(inbox(), '/', v1);
  check('inbox shows only the granted brand', i.body?.data?.length === 1,
    JSON.stringify(i.body?.data?.length));
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. TENANT ISOLATION - company B data never appears in company A ===');
{
  // A delegation for company A must not expose company B.
  const v1 = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T1,
    allBrandsInCompany: true, isPSA: true
  });
  const d = await call(dash(), '/', v1);
  const ids = (d.body?.data?.conversations ?? []).map((c) => c.id);
  check('no company B conversation id leaks', !ids.includes(U(53)), JSON.stringify(ids));
  check('counts match company A exactly', d.body?.data?.kpis?.conversations === 2);

  // A brand granted in company A is worthless when the session tenant is B.
  const crossTenant = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T2,
    brandIds: [BRAND_A], allBrandsInCompany: false, isPSA: true
  });
  const d2 = await call(dash(), '/', crossTenant);
  check('a company-A brand grant yields nothing under company B', d2.body?.data?.kpis?.conversations === 0,
    JSON.stringify(d2.body?.data?.kpis));

  // And company B's own conversation is reachable only from a B session.
  const v2 = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T2,
    allBrandsInCompany: true, isPSA: true
  });
  const d3 = await call(dash(), '/', v2);
  check('company B session sees exactly its own conversation', d3.body?.data?.kpis?.conversations === 1,
    JSON.stringify(d3.body?.data?.kpis));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. ORDINARY ROLES ARE UNCHANGED ===');
{
  const adminYes = sessionFor({
    roles: ['Company Admin'], tenantId: T1, allBrandsInCompany: true, isPSA: false
  });
  check('Company Admin with delegation -> tenant',
    B.brandScopeFromSession(adminYes).mode === 'tenant');
  const adminNo = sessionFor({
    roles: ['Company Admin'], tenantId: T1, brandIds: [], allBrandsInCompany: false, isPSA: false
  });
  const sc = B.brandScopeFromSession(adminNo);
  check('Company Admin without delegation -> zero brands',
    sc.mode === 'restricted' && sc.brandIds.length === 0, JSON.stringify(sc));
  const agent = sessionFor({
    roles: ['Agent'], tenantId: T1, brandIds: [BRAND_B], allBrandsInCompany: false, isPSA: false
  });
  check('Agent with one brand grant -> exactly that brand',
    B.brandScopeFromSession(agent).brandIds.length === 1);
  check('hasTenantWideBrandScope is false for every role',
    ['Company Admin', 'Supervisor', 'Agent', 'Platform Super Admin']
      .every((r) => A.hasTenantWideBrandScope([r]) === false));
  check('custom roles cannot obtain brand.grant_all or wildcards',
    !A.can(['Custom Lead'], 'brand.grant_all', A.normalizeCustomAbilities(['brand.grant_all']))
    && A.normalizeCustomAbilities(['*', 'platform.*']).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. BRAND SCOPE IS NOT AN ABILITY GRANT ===');
{
  // A PSA holding a FULL company-wide delegation resolves brand scope to tenant,
  // but the PSA role alone carries no conversation.read ability. The route must
  // therefore refuse on the ABILITY gate (403) even though the data scope exists.
  const v1 = sessionFor({
    roles: ['Platform Super Admin'], tenantId: T1,
    allBrandsInCompany: true, isPSA: true
  });
  check('brand scope does resolve to tenant', B.brandScopeFromSession(v1).mode === 'tenant');

  const d = await call(dash(), '/', v1);
  check('but the dashboard still refuses with 403', d.status === 403, `got ${d.status}`);
  check('and returns no data envelope', d.body?.data === undefined, JSON.stringify(d.body));

  const i = await call(inbox(), '/', v1);
  check('the inbox also refuses with 403', i.status === 403, `got ${i.status}`);

  check('but the PSA role still cannot reply to conversations',
    !A.can(['Platform Super Admin'], 'conversation.reply'));
  check('and still cannot grant or revoke brands',
    !A.can(['Platform Super Admin'], 'brand.grant') && !A.can(['Platform Super Admin'], 'brand.revoke'));

  // Adding the Company Admin role - which does carry conversation.read - unlocks it,
  // and only for the company the delegation names.
  const v2 = sessionFor({
    roles: ['Company Admin', 'Platform Super Admin'], tenantId: T1,
    allBrandsInCompany: true, isPSA: true
  });
  const d2 = await call(dash(), '/', v2);
  check('with Company Admin the same delegation now returns data', d2.status === 200
    && d2.body?.data?.kpis?.conversations === 2, `${d2.status} ${JSON.stringify(d2.body?.data?.kpis)}`);
}

console.log(`\n  ${pass === 0 && fail === 0 ? 'ALL PASS' : fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
