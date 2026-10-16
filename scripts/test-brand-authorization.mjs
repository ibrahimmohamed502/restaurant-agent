/**
 * Brand + role authorisation hardening for the dashboard.
 *
 *   node scripts/test-brand-authorization.mjs
 *
 * Covers the policy matrix, the fail-closed defaults, and the structural
 * guarantees (atomic claim, denial immutability, audit on both outcomes).
 *
 * The SQL-level guarantees are proven against a real PostgreSQL in
 * scripts/test-pg-delivery-integration.mjs.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import { readFileSync } from 'node:fs';
import {
  can,
  hasTenantWideBrandScope,
  isCompanyAdmin,
  isPlatformSuperAdmin,
  ROLE_ABILITIES,
  TENANT_WIDE_BRAND_ABILITY
} from '../src/auth/abilities.js';
import {
  brandScopeFromSession,
  brandVisibleToScope,
  brandScopeSql,
  BRAND_SCOPE_TENANT,
  BRAND_SCOPE_RESTRICTED
} from '../src/api/v1/brandAccess.js';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

const BRAND_A = 'a0000000-0000-4000-8000-000000000001';
const BRAND_B = 'b0000000-0000-4000-8000-000000000002';
const NOT_A_UUID = 'brand-one';

console.log('\nStage 8 — brand + role authorisation\n');

/* ============ 1. THE PERMISSION MATRIX =============================== */
console.log('--- 1. retry requires an explicit conversation.reply ability ---');
{
  const expect = {
    'Company Admin': true,
    Supervisor: true,
    Agent: false,                 // holds conversation.reply_own only
    'Platform Super Admin': false,// platform.* must not imply tenant replies
    'Head of Growth': false,      // unknown / custom role
    '': false
  };
  for (const [role, allowed] of Object.entries(expect)) {
    check(`retry: ${role || '(no role)'} -> ${allowed ? 'ALLOWED' : 'DENIED'}`,
      can(role ? [role] : [], 'conversation.reply') === allowed);
  }
  check('an Agent may still read conversations',
    can(['Agent'], 'conversation.read') === true);
  check('a Platform Super Admin may not read tenant conversations',
    can(['Platform Super Admin'], 'conversation.read') === false);
  check('an unknown role is denied every ability',
    can(['Head of Growth'], 'brand.read') === false &&
    can(['Head of Growth'], 'conversation.read') === false);
  check('a malformed roles value is denied, not crashed',
    can(null, 'conversation.reply') === false && can('Company Admin', 'conversation.reply') === false);
}

/* ============ 2. TENANT-WIDE IS DELEGATED, NEVER DERIVED FROM A ROLE ==== */
console.log('--- 2. tenant-wide scope requires an explicit per-user delegation ---');
{
  // R1: NO role confers tenant-wide brand scope. This was the defect: Company
  // Admin, Supervisor AND Agent all held brand.read, so an absent grant silently
  // became company-wide access. hasTenantWideBrandScope now answers false for
  // every input, and company-wide comes only from an audited delegation row.
  check('Company Admin is NOT tenant-wide by role alone', !hasTenantWideBrandScope(['Company Admin']));
  check('Supervisor is NOT tenant-wide by role alone', !hasTenantWideBrandScope(['Supervisor']));
  check('Agent is NOT tenant-wide by role alone', !hasTenantWideBrandScope(['Agent']));
  check('Platform Super Admin is NOT tenant-wide', !hasTenantWideBrandScope(['Platform Super Admin']));
  check('an unknown role is NOT tenant-wide', !hasTenantWideBrandScope(['Head of Growth']));
  check('the tenant-wide policy ability matches NO role', TENANT_WIDE_BRAND_ABILITY === '__none__'
    && Object.values(ROLE_ABILITIES).every((a) => !a.includes(TENANT_WIDE_BRAND_ABILITY)));

  // The critical default: an absent grant must NOT widen access.
  check('absent grant + unauthorised role -> zero brands',
    brandScopeFromSession({ roles: ['Platform Super Admin'] }).mode === BRAND_SCOPE_RESTRICTED &&
    brandScopeFromSession({ roles: ['Platform Super Admin'] }).brandIds.length === 0);
  check('absent grant + unknown role -> zero brands',
    brandScopeFromSession({ roles: ['Head of Growth'] }).brandIds.length === 0);
  check('R1: absent grant + Company Admin -> ZERO brands, not tenant-wide',
    brandScopeFromSession({ roles: ['Company Admin'] }).mode === BRAND_SCOPE_RESTRICTED &&
    brandScopeFromSession({ roles: ['Company Admin'] }).brandIds.length === 0);
  check('R1: null grant WITHOUT a delegation -> zero brands, for every role',
    ['Company Admin', 'Supervisor', 'Agent'].every((r) =>
      brandScopeFromSession({ roles: [r], brandIds: null }).brandIds.length === 0));
  check('R1: tenant-wide REQUIRES the audited delegation flag',
    brandScopeFromSession({ roles: ['Company Admin'], brandIds: null, allBrandsInCompany: true }).mode === BRAND_SCOPE_TENANT);
  check('no session at all -> zero brands (fail closed)',
    brandScopeFromSession({}).brandIds.length === 0 &&
    brandScopeFromSession(undefined).brandIds.length === 0);
}

/* ============ 3. MALFORMED GRANTS FAIL CLOSED ======================== */
console.log('--- 3. a malformed grant is never tenant-wide ---');
{
  const malformed = ['a-brand-uuid', 42, { 0: BRAND_A }, true, 'Company Admin', NOT_A_UUID];
  for (const value of malformed) {
    const s = brandScopeFromSession({ roles: ['Company Admin'], brandIds: value });
    check(`malformed grant ${JSON.stringify(value)} -> zero brands`,
      s.mode === BRAND_SCOPE_RESTRICTED && s.brandIds.length === 0,
      `mode=${s.mode}`);
  }
  check('an explicit empty grant list means zero brands',
    brandScopeFromSession({ roles: ['Company Admin'], brandIds: [] }).brandIds.length === 0);
  check('invalid uuids inside an array are dropped, not honoured',
    brandScopeFromSession({ roles: ['Agent'], brandIds: [BRAND_A, 'nope', 7, BRAND_A] })
      .brandIds.join(',') === BRAND_A);
  check('a grant list overrides the delegation flag',
    brandScopeFromSession({ roles: ['Company Admin'], brandIds: [BRAND_A], allBrandsInCompany: false }).mode === BRAND_SCOPE_RESTRICTED);
}

/* ============ 4. VISIBILITY SEMANTICS =============================== */
console.log('--- 4. visibility, including company-wide channels ---');
{
  // R1: tenant-wide is reached only through the audited delegation flag.
  const tenant = brandScopeFromSession({ roles: ['Company Admin'], brandIds: null, allBrandsInCompany: true });
  check('delegated caller sees every brand', brandVisibleToScope(BRAND_A, tenant) && brandVisibleToScope(BRAND_B, tenant));
  check('delegated caller also sees company-wide (NULL brand) channels', brandVisibleToScope(null, tenant));
  // R1 regression: the SAME role WITHOUT the delegation sees nothing at all.
  const ungrantedAdmin = brandScopeFromSession({ roles: ['Company Admin'] });
  check('R1: an ungranted Company Admin sees no brand, including its own tenant',
    !brandVisibleToScope(BRAND_A, ungrantedAdmin) && !brandVisibleToScope(BRAND_B, ungrantedAdmin));

  const restricted = brandScopeFromSession({ roles: ['Agent'], brandIds: [BRAND_A] });
  check('restricted sees its own brand', brandVisibleToScope(BRAND_A, restricted));
  check('restricted cannot see another brand', !brandVisibleToScope(BRAND_B, restricted));
  check('restricted cannot see company-wide (NULL brand) channels',
    !brandVisibleToScope(null, restricted));
  check('restricted cannot see an undefined brand', !brandVisibleToScope(undefined, restricted));

  const none = brandScopeFromSession({ roles: ['Platform Super Admin'] });
  check('a zero-brand scope sees nothing at all',
    !brandVisibleToScope(BRAND_A, none) && !brandVisibleToScope(null, none));
}

/* ============ 5. THE SQL FRAGMENT ================================== */
console.log('--- 5. the SQL fragment matches the JS policy ---');
{
  // Assert the GENERATED SQL: the parameter numbers are interpolated when the
  // fragment is built, so the source template never contains a literal '$5'.
  const f = brandScopeSql('ch', { tenantWideParam: 5, brandIdsParam: 6 });
  check('the fragment references the channels alias', f.sql.includes('ch.brand_id'));
  check('a NULL brand is excluded from a restricted caller', f.sql.includes('ch.brand_id IS NOT NULL'));
  check('tenant-wide is a bound parameter, not an inlined code path', f.sql.includes('$5::boolean'));
  check('the restricted set is a uuid array parameter', f.sql.includes('$6::uuid[]'));
  check('the alias is parameterised', brandScopeSql('zz').sql.includes('zz.brand_id'));
  check('the parameter positions are configurable',
    brandScopeSql('ch', { tenantWideParam: 2, brandIdsParam: 3 }).sql.includes('$2::boolean'));

  const t = brandScopeFromSession({ roles: ['Company Admin'], brandIds: null, allBrandsInCompany: true });
  const r = brandScopeFromSession({ roles: ['Agent'], brandIds: [BRAND_A] });
  check('delegated scope sends true + empty array', JSON.stringify(f.params(t)) === JSON.stringify([true, []]));
  check('restricted sends false + the grant list', JSON.stringify(f.params(r)) === JSON.stringify([false, [BRAND_A]]));
  check('R1: an ungranted admin sends false + empty array (never true)',
    JSON.stringify(f.params(brandScopeFromSession({ roles: ['Company Admin'] }))) === JSON.stringify([false, []]));
  check('an unknown scope degrades to restricted, never tenant-wide',
    JSON.stringify(f.params({ mode: 'nonsense' })) === JSON.stringify([false, []]));
}

/* ============ 6. THE CLAIM IS ATOMIC AND BRAND-SCOPED =============== */
console.log('--- 6. the SQL claim enforces tenant + brand in one statement ---');
{
  const src = readFileSync(new URL('../src/services/conversations.js', import.meta.url), 'utf8');
  const claim = src.slice(src.indexOf('export async function claimFailedOutboundForRetry'));

  check('the claim joins channels to reach brand_id', /LEFT JOIN channels ch ON ch\.id = c\.channel_id/.test(claim));
  check('tenant scope is required on the message', /m\.tenant_id = \$3/.test(claim));
  check('tenant scope is required on the conversation', /c\.tenant_id = \$3/.test(claim));
  check('brand scope is part of the same WHERE clause',
    /AND \(\$5::boolean OR \(ch\.brand_id IS NOT NULL AND ch\.brand_id = ANY\(\$6::uuid\[\]\)\)\)/.test(claim));
  check('brand scope is NOT applied after the fact', !/^\s*if \(!brandVisible/m.test(claim));
  check('a missing scope degrades to restricted, never tenant-wide',
    /scope\?\.mode === BRAND_SCOPE_TENANT/.test(claim) &&
    /tenantWide \? \[\] : \(scope\?\.brandIds \?\? \[\]\)/.test(claim));
}

/* ============ 7. THE ROUTES ARE GATED =============================== */
console.log('--- 7. every conversation route enforces ability and scope ---');
{
  const dash = readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  const retryStart = dash.indexOf("messages/:messageId/retry'");
  const retry = dash.slice(retryStart, dash.indexOf('function _renderDashboard', retryStart));

  check('retry requires conversation.reply before any claim',
    retry.indexOf("can(req.auth?.roles ?? [], 'conversation.reply')") > -1 &&
    retry.indexOf("can(req.auth?.roles ?? [], 'conversation.reply')") < retry.indexOf('claimFailedOutboundForRetry('));
  check('retry resolves a brand scope and passes it to the claim',
    /brandScopeFromSession\(req\.auth\)/.test(retry) && /claimFailedOutboundForRetry\(\{ tenantId, conversationId, messageId, scope \}\)/.test(retry));
  check('a denied retry answers 403 with a stable code',
    /status\(403\)\.json\(\{ error: 'forbidden', code: 'INSUFFICIENT_PERMISSION' \}\)/.test(retry));
  check('a refused claim answers 409, never a Meta call', /NOT_RETRYABLE/.test(retry));

  const auditOutcomes = (retry.match(/action: 'message\.retry'/g) || []).length;
  check('every retry outcome is audited', auditOutcomes >= 4, `audit calls=${auditOutcomes}`);
  for (const outcome of ['denied', 'refused', 'claimed', 'sent', 'send_failed']) {
    check(`audit records outcome "${outcome}"`, retry.includes(`outcome: '${outcome}'`));
  }
  check('the audit metadata carries no customer content',
    !/metadata: \{[^}]*message:/.test(retry) && !/metadata: \{[^}]*text:/.test(retry));

  check('conversation list enforces conversation.read',
    dash.includes("authorizeConversationAccess(req, res, 'conversation.read')"));
  check('conversation list filters by brand in SQL', dash.includes('AND ${sc.sql}'));
  check('conversation detail filters by brand in SQL', dash.includes('AND ${sc.sql}'));
  check('an out-of-scope conversation is 404, not 403 (no existence oracle)',
    /if \(!conv\) return res\.status\(404\)/.test(dash));
  check('the retry handler contains no UI/button logic at all',
    !/retrybtn|<button|innerHTML/.test(retry), retry.match(/retrybtn|<button|innerHTML/)?.[0] ?? '');
  check('the retry handler never renders the reply text into the response',
    !/res\.(send|json)\([^)]*claimed\.text/.test(retry));
}

/* ============ 8. NO IMPLICIT WIDENING ANYWHERE ======================= */
console.log('--- 8. no code path widens scope implicitly ---');
{
  const brandSrc = readFileSync(new URL('../src/api/v1/brandAccess.js', import.meta.url), 'utf8');
  const resolve = brandSrc.slice(brandSrc.indexOf('export function brandScopeFromSession'),
    brandSrc.indexOf('/** Is a channel'));
  check('exactly one branch produces tenant mode', (resolve.match(/mode: BRAND_SCOPE_TENANT/g) || []).length === 1);
  // R1: the single tenant-mode branch is guarded by the audited delegation flag.
  check('tenant mode is gated on allBrandsInCompany', /raw === null && auth\?\.allBrandsInCompany === true/.test(resolve));
  // The role list can no longer produce tenant mode at all.
  check('the resolver no longer consults a role list for scope',
    !/hasTenantWideBrandScope/.test(resolve));
// Policy: the PSA denial is still present, but it now fires only AFTER the
// explicit-grant branches, so a PSA with a real delegation is not discarded.
check('the resolver still carries an explicit Platform Super Admin denial',
  resolve.includes('Platform Super Admin'));
  check('the PSA denial is not the first branch (explicit grants are evaluated first)',
    resolve.indexOf('isPlatformSuperAdmin === true') > resolve.indexOf('Array.isArray(raw)'));
check('a PSA with NO grant still resolves to zero brands (the security invariant)',
  brandScopeFromSession({ roles: ['Platform Super Admin'], isPlatformSuperAdmin: true }).brandIds.length === 0);
check('a PSA WITH an explicit company-wide delegation resolves to tenant scope',
  brandScopeFromSession({ roles: ['Platform Super Admin'], brandIds: null, allBrandsInCompany: true, isPlatformSuperAdmin: true }).mode === 'tenant');
  check('every non-array, non-null grant is refused before tenant mode',
    brandScopeFromSession({ roles: ['Company Admin'], brandIds: 1 }).brandIds.length === 0);
  check('R1: sessions.js RESOLVES grants instead of documenting a placeholder',
    !/brand restriction extension point/i.test(readFileSync(new URL('../src/auth/sessions.js', import.meta.url), 'utf8'))
    && /user_brand_grants/.test(readFileSync(new URL('../src/auth/sessions.js', import.meta.url), 'utf8')));
  check('R1: the per-user grant table lives in migration 015, not 001_init',
    /CREATE TABLE IF NOT EXISTS user_brand_grants/.test(
      readFileSync(new URL('../migrations/015_brand_access_grants.sql', import.meta.url), 'utf8'))
    && !/CREATE TABLE[\s\S]{0,80}user_brand/i.test(
      readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')));
}

/* ============ 9. ROLE MAP INTEGRITY ================================ */
console.log('--- 9. the ability map itself ---');
{
  check('Platform Super Admin holds no conversation ability',
    !ROLE_ABILITIES['Platform Super Admin'].some((a) => a.startsWith('conversation.')));
  check('Platform Super Admin holds no brand ability',
    !ROLE_ABILITIES['Platform Super Admin'].some((a) => a.startsWith('brand.')));
  check('isCompanyAdmin / isPlatformSuperAdmin still work',
    isCompanyAdmin(['Company Admin']) && !isCompanyAdmin(['Agent']) &&
    isPlatformSuperAdmin(['Platform Super Admin']) && !isPlatformSuperAdmin(['Company Admin']));
  check('wildcards still expand', can(['Platform Super Admin'], 'platform.create'));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);