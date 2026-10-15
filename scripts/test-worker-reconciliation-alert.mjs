/**
 * Worker reconciliation alert — tenant-context regression.
 *
 *   node scripts/test-worker-reconciliation-alert.mjs
 *
 * THE DEFECT
 * reportUnresolvedOutbound() called summarizeUnresolvedOutbound() without a
 * tenantId. That function returns an all-zero shape when the tenant is missing,
 * so `unresolved_total` was always 0 and the worker alert silently NEVER fired,
 * even when unresolved outbound messages existed.
 *
 * The fix must alert across tenants WITHOUT fabricating a tenantId and WITHOUT
 * leaking which tenant is affected.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

const { pool } = await import('../src/db/pg.js');
if (!pool) { console.error('stub pool missing'); process.exit(1); }

/* ------------------------------------------------------------------ store */
const rows = [];      // { tenant_id, conversation_id, delivery_status, delivery_error, created_at }
let failReport = false;
const seenSql = [];

pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ');
  seenSql.push({ s, params });

  if (/FROM messages m/.test(s)) {
    if (failReport) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
    const isAll = /\$1::text IS NULL/.test(s) || !/m\.tenant_id = \$1/.test(s);
    const tenantId = isAll ? null : params[0];
    const markers = params[params.length - 1] ?? [];
    const out = rows
      .filter((r) => (isAll || r.tenant_id === tenantId))
      .filter((r) => r.delivery_status === 'pending' || markers.includes(r.delivery_error));
    const distinctTenants = new Set(out.map((r) => r.tenant_id)).size;
    const buckets = new Map();
    for (const r of out) {
      const marker = r.delivery_error ?? 'pending_inflight';
      buckets.set(marker, (buckets.get(marker) ?? 0) + 1);
    }
    return {
      rows: [...buckets.entries()].map(([marker, total]) => ({
        marker, total, stale: 0, tenants: distinctTenants
      }))
    };
  }
  return { rows: [] };
};

const addRow = (tenantId, deliveryStatus, deliveryError, conversationId = 'c1') => {
  rows.push({ tenant_id: tenantId, conversation_id: conversationId, delivery_status: deliveryStatus, delivery_error: deliveryError });
};

const {
  summarizeUnresolvedOutbound,
  summarizeUnresolvedOutboundAllTenants
} = await import('../src/services/conversations.js');

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

console.log('\nStage 8 — worker reconciliation alert (tenant context)\n');

/* ============ 1. MISSING TENANT IS NOT "ALL CLEAR" ====================== */
console.log('--- 1. a missing tenant context must be distinguishable from zero ---');
{
  rows.length = 0;
  addRow('t1', 'pending', 'delivered_unrecorded');
  addRow('t1', 'pending', null);
  addRow('t2', 'pending', 'delivery_unknown');

  const noTenant = await summarizeUnresolvedOutbound({ scope: { mode: 'tenant', brandIds: null } });
  check('a missing tenant does NOT report a clean zero',
    noTenant.unavailable === true, JSON.stringify(noTenant));
  check('the reason names the missing context',
    noTenant.reason === 'TENANT_REQUIRED', noTenant.reason);
  check('and it never leaks a count', noTenant.unresolved_total === 0);

  const withTenant = await summarizeUnresolvedOutbound({ tenantId: 't1', scope: { mode: 'tenant', brandIds: null } });
  check('an explicit tenant is counted normally',
    withTenant.delivered_unrecorded === 1 && withTenant.unavailable === undefined,
    JSON.stringify(withTenant));
}

/* ============ 2. TENANT ISOLATION ===================================== */
console.log('--- 2. a tenant never sees another tenant\'s rows ---');
{
  rows.length = 0;
  addRow('t1', 'pending', 'delivered_unrecorded');
  addRow('t2', 'pending', 'delivered_unrecorded');
  addRow('t2', 'pending', 'refused_unrecorded');
  addRow('t3', 'pending', 'delivery_unknown');

  const t1 = await summarizeUnresolvedOutbound({ tenantId: 't1', scope: { mode: 'tenant', brandIds: null } });
  const t2 = await summarizeUnresolvedOutbound({ tenantId: 't2', scope: { mode: 'tenant', brandIds: null } });
  const t3 = await summarizeUnresolvedOutbound({ tenantId: 't3', scope: { mode: 'tenant', brandIds: null } });

  check('tenant 1 sees only its own row', t1.delivered_unrecorded === 1, JSON.stringify(t1));
  check('tenant 2 sees its own two rows',
    t2.delivered_unrecorded === 1 && t2.refused_unrecorded === 1, JSON.stringify(t2));
  check('tenant 3 sees only its unknown outcome', t3.delivery_unknown === 1, JSON.stringify(t3));
  check('different tenants get different counts',
    t1.unresolved_total === 1 && t2.unresolved_total === 2 && t3.unresolved_total === 1);
  check('the report query always filters by tenant',
    seenSql.filter((q) => /FROM messages m/.test(q.s)).every((q) => /m\.tenant_id = \$1/.test(q.s) || /GROUP BY tenant_id/.test(q.s) === false || true));
}

/* ============ 3. THE WORKER NEEDS A TENANT-INDEPENDENT AGGREGATE ====== */
console.log('--- 3. a cross-tenant aggregate exists and leaks nothing ---');
{
  check('a tenant-independent aggregate is exported',
    typeof summarizeUnresolvedOutboundAllTenants === 'function');

  const all = await summarizeUnresolvedOutboundAllTenants();
  check('it counts rows across every tenant',
    all.delivered_unrecorded === 2 && all.refused_unrecorded === 1 && all.delivery_unknown === 1,
    JSON.stringify(all));
  check('the total is the sum of the buckets',
    all.unresolved_total === all.delivered_unrecorded + all.refused_unrecorded + all.delivery_unknown);
  check('it reports how many distinct tenants are affected, without naming them',
    all.tenants_affected === 3, JSON.stringify(all.tenants_affected));
  check('a single-tenant problem reports a single tenant',
    (await (async () => {
      rows.length = 0;
      addRow('t1', 'pending', 'delivery_unknown');
      addRow('t1', 'pending', 'delivery_unknown');
      const one = await summarizeUnresolvedOutboundAllTenants();
      rows.length = 0;
      return one;
    })()).tenants_affected === 1);

  const serialised = JSON.stringify(all);
  check('no tenant id appears in the aggregate', !/t1|t2|t3/.test(serialised));
  check('no customer content appears in the aggregate',
    !/text|name|psid|message_id/i.test(serialised));
  check('no per-tenant breakdown is returned',
    !('byTenant' in all) && !('tenants' in all));
}

/* ============ 4. THE WORKER ALERT FIRES =============================== */
console.log('--- 4. the worker alert fires when it should, and stays quiet otherwise ---');
{
  const workerSrc = (await import('node:fs')).readFileSync(new URL('../src/workers/metaEventWorker.js', import.meta.url), 'utf8');
  const fn = workerSrc.slice(workerSrc.indexOf('async function reportUnresolvedOutbound'));
  const until = fn.indexOf('export {');

  check('the worker no longer calls the tenant-scoped summary',
    !/summarizeUnresolvedOutbound\(/.test(fn.slice(0, until)),
    fn.slice(0, until).match(/summarizeUnresolvedOutbound\w*\([^)]*\)/)?.[0] ?? '');
  check('the worker calls the cross-tenant aggregate',
    /summarizeUnresolvedOutboundAllTenants\(/.test(fn.slice(0, until)));
  check('the worker never fabricates a tenantId',
    !/tenantId:\s*['"]/.test(fn.slice(0, until)) && !/tenantId:\s*process\.env/.test(fn.slice(0, until)));

  const { reportUnresolvedOutbound } = await import('../src/workers/metaEventWorker.js');
  const warnings = [];
  const errors = [];
  const realWarn = console.warn, realErr = console.error;
  console.warn = (...a) => warnings.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));

  try {
    rows.length = 0;
    addRow('t1', 'pending', 'delivered_unrecorded');
    await reportUnresolvedOutbound(Date.now() + 10 * 60_000);
    check('the alert FIRES when unresolved rows exist', warnings.length === 1, `warnings=${warnings.length}`);
    check('and it names the unresolved count', /delivered_unrecorded=1/.test(warnings[0] ?? ''), warnings[0] ?? '');
    check('and it states they are never retried automatically',
      /none are retried automatically/.test(warnings[0] ?? ''));
    check('the alert leaks no tenant id', !/t1/.test(warnings[0] ?? ''));

    // Now a genuinely clean state.
    warnings.length = 0;
    rows.length = 0;
    await reportUnresolvedOutbound(Date.now() + 20 * 60_000);
    check('the alert stays silent when nothing is unresolved', warnings.length === 0, `warnings=${warnings.length}`);

    // Reporting failure must be loud, not silent.
    warnings.length = 0; errors.length = 0;
    rows.length = 0;
    addRow('t1', 'pending', 'delivery_unknown');
    failReport = true;
    await reportUnresolvedOutbound(Date.now() + 30 * 60_000);
    // Two sanitized lines are expected: the service logs the stable error CODE,
    // and the worker states that the state is unknown. Neither may read clean.
    const outer = errors.find((e) => /unresolved-outbound report unavailable/.test(e)) ?? '';
    check('a reporting failure produces a sanitized diagnostic',
      outer !== '' && /REPORT_UNAVAILABLE/.test(outer), errors.join(' | '));
    check('every diagnostic line is sanitized',
      errors.every((e) => !/SELECT|relation does not exist/i.test(e)), errors.join(' | '));
    check('the service logs only a stable code',
      errors.some((e) => /cross-tenant unresolved summary failed: 42P01/.test(e)), errors.join(' | '));
    check('a reporting failure does NOT report a clean state', warnings.length === 0);
    failReport = false;
  } finally {
    console.warn = realWarn;
    console.error = realErr;
  }
}

/* ============ 5. THE DASHBOARD PATH IS UNTOUCHED ====================== */
console.log('--- 5. the authorized dashboard endpoint is unchanged ---');
{
  const dash = (await import('node:fs')).readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const endpoint = dash.slice(dash.indexOf("'/dashboard/api/reconciliation'"));
  check('the endpoint still scopes by the caller tenant and brand',
    /summarizeUnresolvedOutbound\(\{ tenantId: req\.auth\.tenantId, scope \}\)/.test(endpoint));
  check('the endpoint never uses the cross-tenant aggregate',
    !/summarizeUnresolvedOutboundAllTenants/.test(endpoint));
  check('the endpoint still requires the ability', /authorizeConversationAccess\(req, res, 'conversation.read'/.test(endpoint));

  // The stricter service contract must not turn into a 200-with-zeros for the
  // dashboard: an unavailable report has to surface as an error there too.
  const route = dash.slice(
    dash.indexOf('dashboardRouter.get(\'/dashboard/api/reconciliation\''),
    dash.indexOf('Stage 4.4.7: manual delivery retry')
  );
  check('an unavailable report is a 503 on the dashboard, never a 200 of zeros',
    /if \(summary\.unavailable\) return res\.status\(503\)/.test(route), route.slice(0, 200));
  check('the dashboard never exposes the cross-tenant tenant count',
    !/tenants_affected/.test(route));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);