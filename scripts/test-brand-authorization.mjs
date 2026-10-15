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

/* ============ 2. TENANT-WIDE IS DERIVED, NEVER DEFAULTED ============= */
console.log('--- 2. tenant-wide scope requires an explicit ability ---');
{
  check('Company Admin is tenant-wide by policy', hasTenantWideBrandScope(['Company Admin']));
  check('Supervisor is tenant-wide by policy', hasTenantWideBrandScope(['Supervisor']));
  check('Agent is tenant-wide by policy (it holds brand.read)',
    hasTenantWideBrandScope(['Agent']));
  check('Platform Super Admin is NOT tenant-wide', !hasTenantWideBrandScope(['Platform Super Admin']));
  check('an unknown role is NOT tenant-wide', !hasTenantWideBrandScope(['Head of Growth']));
  check('the policy ability is brand.read', TENANT_WIDE_BRAND_ABILITY === 'brand.read');

  // The critical default: an absent grant must NOT widen access.
  check('absent grant + unauthorised role -> zero brands',
    brandScopeFromSession({ roles: ['Platform Super Admin'] }).mode === BRAND_SCOPE_RESTRICTED &&
    brandScopeFromSession({ roles: ['Platform Super Admin'] }).brandIds.length === 0);
  check('absent grant + unknown role -> zero brands',
    brandScopeFromSession({ roles: ['Head of Growth'] }).brandIds.length === 0);
  check('absent grant + authorised role -> tenant-wide',
    brandScopeFromSession({ roles: ['Company Admin'] }).mode === BRAND_SCOPE_TENANT);
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
  check('a grant list overrides tenant-wide policy',
    brandScopeFromSession({ roles: ['Company Admin'], brandIds: [BRAND_A] }).mode === BRAND_SCOPE_RESTRICTED);
}

/* ============ 4. VISIBILITY SEMANTICS =============================== */
console.log('--- 4. visibility, including company-wide channels ---');
{
  const tenant = brandScopeFromSession({ roles: ['Company Admin'] });
  check('tenant-wide sees every brand', brandVisibleToScope(BRAND_A, tenant) && brandVisibleToScope(BRAND_B, tenant));
  check('tenant-wide also sees company-wide (NULL brand) channels', brandVisibleToScope(null, tenant));

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

  const t = brandScopeFromSession({ roles: ['Company Admin'] });
  const r = brandScopeFromSession({ roles: ['Agent'], brandIds: [BRAND_A] });
  check('tenant-wide sends true + empty array', JSON.stringify(f.params(t)) === JSON.stringify([true, []]));
  check('restricted sends false + the grant list', JSON.stringify(f.params(r)) === JSON.stringify([false, [BRAND_A]]));
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
  for (const outcome of ['denied', 'refused', 'claimed', 'sent', 'failed']) {
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
  check('only hasTenantWideBrandScope can return tenant mode', (resolve.match(/BRAND_SCOPE_TENANT/g) || []).length === 1);
  check('a malformed grant returns before the role check', resolve.indexOf('BRAND_SCOPE_RESTRICTED, brandIds: []') < resolve.indexOf('hasTenantWideBrandScope'));
  // The role check must be the ONLY producer of tenant mode, and it must be the
  // final branch — nothing after it can widen scope.
  const afterRoleCheck = resolve.slice(resolve.indexOf('hasTenantWideBrandScope'));
  check('the role check is the only place tenant mode is produced',
    (resolve.match(/mode: BRAND_SCOPE_TENANT/g) || []).length === 1);
  check('the role check is the final branch of the function',
    !/hasTenantWideBrandScope[\s\S]*?\}\s*return[^}]*BRAND_SCOPE_TENANT/.test(
      resolve.slice(resolve.indexOf('hasTenantWideBrandScope') + 1)));
  check('every non-array, non-null grant is refused before the role check',
    brandScopeFromSession({ roles: ['Company Admin'], brandIds: 1 }).brandIds.length === 0);
  check('sessions.js still documents brandIds as an unimplemented extension point',
    /brand restriction extension point/i.test(readFileSync(new URL('../src/auth/sessions.js', import.meta.url), 'utf8')));
  check('no per-user brand grant table was invented',
    !/CREATE TABLE[\s\S]{0,80}user_brand/i.test(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')));
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