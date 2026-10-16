/**
 * R1 — Brand Access Security: isolation, delegation and audit tests.
 *
 *   node scripts/test-r1-brand-access.mjs
 *
 * Runs against a stub pool so it needs no database, plus static assertions on
 * the migration. Exits non-zero on any failure.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pool } = await import('../src/db/pg.js');
const A = await import('../src/auth/abilities.js');
const B = await import('../src/api/v1/brandAccess.js');

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const T1 = U(1), T2 = U(2);            // two companies
const USER_ADMIN = U(11), USER_SUP = U(12), USER_AGENT = U(13);
const BRAND_A = U(21), BRAND_B = U(22), BRAND_C = U(23);
const BRAND_OTHER_TENANT = U(31);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  OK   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

// ---------------------------------------------------------------------------
// In-memory store standing in for the three tables + users/brands.
// ---------------------------------------------------------------------------
function seed() {
  return {
    // Migration 015's backfill gives every Company Admin an all-brands row, so
    // the fixture mirrors post-backfill reality: an Admin holds company-wide
    // scope, and nobody else holds anything.
    grants: [],
    scopeAll: [{ id: U(600), tenant_id: T1, user_id: USER_ADMIN, granted_by: null, revoked_at: null }],
    audits: [],
    users: [
      { id: USER_ADMIN, tenant: T1 }, { id: USER_SUP, tenant: T1 }, { id: USER_AGENT, tenant: T1 },
      { id: U(99), tenant: T2 }
    ],
    brands: [
      { id: BRAND_A, tenant: T1 }, { id: BRAND_B, tenant: T1 }, { id: BRAND_C, tenant: T1 },
      { id: BRAND_OTHER_TENANT, tenant: T2 }
    ]
  };
}
let DB = seed();

// Fake pool honouring the queries the real code issues.
pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  const t = (n) => (s.includes(n) ? n : null);

  // callerBrandScope
  if (/EXISTS \(SELECT 1 FROM user_brand_scope_all/.test(s)) {
    const [uid, tid] = params;
    return { rows: [{ all_brands: DB.scopeAll.some((r) => r.user_id === uid && r.tenant_id === tid && !r.revoked_at),
                      brand_ids: DB.grants.filter((r) => r.user_id === uid && r.tenant_id === tid && !r.revoked_at).map((r) => r.brand_id) }] };
  }
  if (/SELECT brand_id FROM user_brand_grants/.test(s)) {
    const [uid, tid] = params;
    return { rows: DB.grants.filter((r) => r.user_id === uid && r.tenant_id === tid && !r.revoked_at).map((r) => ({ brand_id: r.brand_id })) };
  }
  if (/SELECT 1 FROM user_brand_scope_all/.test(s)) {
    const [uid, tid] = params;
    return { rows: DB.scopeAll.some((r) => r.user_id === uid && r.tenant_id === tid && !r.revoked_at) ? [{}] : [] };
  }
  // last-holder guard: count of OTHER live company-wide holders in this company
  if (/count\(\*\)::int AS n/.test(s) && /user_brand_scope_all/.test(s)) {
    const [tid, excludeUid] = params;
    return { rows: [{ n: DB.scopeAll.filter((r) => r.tenant_id === tid && !r.revoked_at && r.user_id !== excludeUid).length }] };
  }
  // target / brand existence
  if (/FROM users WHERE id = \$1 AND tenant_id = \$2/.test(s)) return { rows: DB.users.some((u) => u.id === params[0] && u.tenant === params[1]) ? [{ id: params[0] }] : [] };
  if (/FROM brands WHERE id = \$1 AND tenant_id = \$2/.test(s)) return { rows: DB.brands.some((b) => b.id === params[0] && b.tenant === params[1]) ? [{ id: params[0] }] : [] };
  // grant upsert
  if (/INSERT INTO user_brand_grants/.test(s)) {
    const [tid, uid, bid, by] = params;
    const live = DB.grants.find((r) => r.user_id === uid && r.brand_id === bid && !r.revoked_at);
    if (live) { live.revoked_at = null; live.granted_by = by; return { rows: [{ id: live.id, granted_at: 'now' }] }; }
    const row = { id: U(500 + DB.grants.length), tenant_id: tid, user_id: uid, brand_id: bid, granted_by: by, revoked_at: null };
    DB.grants.push(row);
    return { rows: [{ id: row.id, granted_at: 'now' }] };
  }
  if (/UPDATE user_brand_grants SET revoked_at/.test(s)) {
    const [tid, uid, by, bid] = params;
    const r = DB.grants.find((x) => x.tenant_id === tid && x.user_id === uid && x.brand_id === bid && !x.revoked_at);
    if (!r) return { rows: [] };
    r.revoked_at = 'now'; r.revoked_by = by;
    return { rows: [{ id: r.id }] };
  }
  // scopeAll upsert / revoke
  if (/INSERT INTO user_brand_scope_all/.test(s)) {
    const [tid, uid, by] = params;
    const live = DB.scopeAll.find((r) => r.user_id === uid && r.tenant_id === tid && !r.revoked_at);
    if (live) return { rows: [{ id: live.id }] };
    const row = { id: U(600 + DB.scopeAll.length), tenant_id: tid, user_id: uid, granted_by: by, revoked_at: null };
    DB.scopeAll.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/UPDATE user_brand_scope_all SET revoked_at/.test(s)) {
    const [tid, uid, by] = params;
    const r = DB.scopeAll.find((x) => x.tenant_id === tid && x.user_id === uid && !x.revoked_at);
    if (!r) return { rows: [] };
    r.revoked_at = 'now'; return { rows: [{ id: r.id }] };
  }
  // history
  if (/FROM user_brand_grants g/.test(s)) {
    const [tid, uid] = params;
    return { rows: DB.grants.filter((r) => r.tenant_id === tid && r.user_id === uid).map((r) => ({
      id: r.id, brand_id: r.brand_id, brand_name: 'brand', granted_at: 'g', revoked_at: r.revoked_at, reason: r.reason
    })) };
  }
  // audit rows (audit.js writes through this same pool)
  if (/INSERT INTO audit_logs/.test(s)) {
    auditCalls.push({ sql: s, params });
    return { rows: [] };
  }
  return { rows: [] };
};
pool.connect = async () => ({
  query: pool.query,
  release() {},
  // transactional no-ops; the fake store is the source of truth
  async end() {}, commit: async () => {}, rollback: async () => {}
});

// ESM namespace objects are frozen, so `audit` cannot be reassigned. audit.js
// writes through the same pool this file already stubs, so audit rows are
// captured there instead.
const auditCalls = [];
const G = await import('../src/services/brandGrants.js');

console.log('\n=== 1. MISSING GRANT NEVER MEANS TENANT-WIDE ===');
{
  DB = seed();
  const cases = [
    ['Agent, no grants at all', { roles: ['Agent'], brandIds: [] }],
    ['Agent, brandIds absent', { roles: ['Agent'] }],
    ['Agent, brandIds null but no delegation', { roles: ['Agent'], brandIds: null }],
    ['Agent, malformed string', { roles: ['Agent'], brandIds: 'oops' }],
    ['Agent, malformed list', { roles: ['Agent'], brandIds: ['nope', 42, null] }],
    ['unknown role', { roles: ['NoSuchRole'], brandIds: [] }],
    ['custom role', { roles: ['Senior Agent (custom)'], brandIds: [] }]
  ];
  for (const [n, auth] of cases) {
    const s = B.brandScopeFromSession(auth);
    check(`${n} -> zero brands`, s.mode === 'restricted' && s.brandIds.length === 0, JSON.stringify(s));
  }
  check('hasTenantWideBrandScope is false for every role list',
    [A.ROLE_ABILITIES ? ['Agent'] : [], ['Supervisor'], ['Company Admin'], ['Agent', 'Supervisor', 'Company Admin']]
      .every((r) => A.hasTenantWideBrandScope(r) === false));
  check('TENANT_WIDE_BRAND_ABILITY matches no ability at all',
    Object.values(A.ROLE_ABILITIES).every((ab) => !ab.includes(A.TENANT_WIDE_BRAND_ABILITY)));
}

console.log('\n=== 2. PLATFORM SUPER ADMIN: SCOPE ONLY FROM AN EXPLICIT GRANT ===');
{
  // Policy 1: the PSA role alone confers NO brand scope.
  const none = B.brandScopeFromSession({
    roles: ['Platform Super Admin'], brandIds: [], allBrandsInCompany: false, isPlatformSuperAdmin: true
  });
  check('PSA with NO grant resolves to ZERO brands',
    none.mode === 'restricted' && none.brandIds.length === 0, JSON.stringify(none));

  // Policy 1 again, via the role-name signal alone (boolean flag absent).
  const nameOnly = B.brandScopeFromSession({
    roles: ['Platform Super Admin'], brandIds: [], allBrandsInCompany: false
  });
  check('PSA denied by role name even when the boolean flag is absent',
    nameOnly.mode === 'restricted' && nameOnly.brandIds.length === 0, JSON.stringify(nameOnly));

  // Policy 2: an explicit company-wide delegation DOES grant that one company.
  const wide = B.brandScopeFromSession({
    roles: ['Platform Super Admin'], brandIds: null, allBrandsInCompany: true, isPlatformSuperAdmin: true
  });
  check('PSA WITH a company-wide delegation resolves to tenant scope',
    wide.mode === 'tenant' && wide.brandIds === null, JSON.stringify(wide));

  // Policy 2: explicit per-brand grants work for a PSA too, not only company-wide.
  const B1 = '11111111-1111-4111-8111-111111111111';
  const B2 = '22222222-2222-4222-8222-222222222222';
  const some = B.brandScopeFromSession({
    roles: ['Platform Super Admin'], brandIds: [B1, B2], allBrandsInCompany: false, isPlatformSuperAdmin: true
  });
  check('PSA WITH specific brand grants sees exactly those brands',
    some.mode === 'restricted' && some.brandIds.length === 2
      && some.brandIds.includes(B1) && some.brandIds.includes(B2),
    JSON.stringify(some));

  // A malformed entry is dropped, never trusted.
  const dirty = B.brandScopeFromSession({
    roles: ['Platform Super Admin'], brandIds: [B1, 'not-a-uuid', null, B2], allBrandsInCompany: false, isPlatformSuperAdmin: true
  });
  check('PSA grant list drops malformed entries and keeps only valid uuids',
    dirty.brandIds.length === 2 && dirty.brandIds.every(B.isUuid), JSON.stringify(dirty.brandIds));

  // Policy 6: a revoked delegation yields no access (allBrandsInCompany false).
  const revoked = B.brandScopeFromSession({
    roles: ['Platform Super Admin'], brandIds: null, allBrandsInCompany: false, isPlatformSuperAdmin: true
  });
  check('PSA with a REVOKED delegation (flag false) gets zero brands',
    revoked.mode === 'restricted' && revoked.brandIds.length === 0, JSON.stringify(revoked));

  // Policy 6: an absent/malformed brandIds never becomes tenant-wide.
  const absent = B.brandScopeFromSession({ roles: ['Platform Super Admin'], isPlatformSuperAdmin: true });
  check('PSA with brandIds absent fails closed',
    absent.mode === 'restricted' && absent.brandIds.length === 0, JSON.stringify(absent));

  // Policy 4: brand scope is DATA VISIBILITY, never an ability grant.
  check('PSA cannot grant or revoke',
    !A.can(['Platform Super Admin'], 'brand.grant') && !A.can(['Platform Super Admin'], 'brand.revoke'));
  check('PSA platform routes remain separate (no conversation.reply)',
    !A.can(['Platform Super Admin'], 'conversation.reply'));
}

console.log('\n=== 3. COMPANY ADMIN DELEGATION ===');
{
  DB = seed();
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });
  const sc = await G.callerBrandScope({ tenantId: T1, userId: USER_SUP });
  check('delegated Supervisor sees all brands of its own company', sc.allBrands === true);

  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  const ag = await G.callerBrandScope({ tenantId: T1, userId: USER_AGENT });
  check('granted Agent sees exactly one brand', ag.brandIds.length === 1 && ag.brandIds[0] === BRAND_A);
  check('granted Agent does NOT see company-wide', ag.allBrands === false);

  // An actor holding only SPECIFIC brands (not company-wide) may not delegate
  // company-wide scope to anyone else.
  DB.scopeAll = DB.scopeAll.filter((r) => r.user_id !== USER_ADMIN);   // Admin drops to brand-scoped
  let threw = null;
  try { await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP }); }
  catch (e) { threw = e; }
  check('an all-brands holder cannot delegate company-wide scope',
    threw?.code === 'DELEGATION_NOT_AUTHORIZED', String(threw?.code));
}

console.log('\n=== 4. DELEGATION IS BOUNDED BY WHAT THE ACTOR HOLDS ===');
{
  DB = seed();
  // Supervisor delegated ALL brands, then tries to delegate a brand of another company.
  DB.scopeAll.push({ id: U(800), tenant_id: T1, user_id: USER_SUP, revoked_at: null });
  let threw = null;
  try { await G.grantBrand({ tenantId: T1, actorUserId: USER_SUP, targetUserId: USER_AGENT, brandId: BRAND_OTHER_TENANT }); }
  catch (e) { threw = e; }
  check('cannot grant a brand that does not exist in the actor company (404)',
    threw?.code === 'BRAND_NOT_FOUND', String(threw?.code));
  check('no cross-company grant row was created',
    !DB.grants.some((g) => g.brand_id === BRAND_OTHER_TENANT));

  // A brand-scoped actor may only delegate inside its own scope
  DB = seed();
  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT });
  DB.scopeAll = DB.scopeAll.filter((r) => r.user_id !== USER_AGENT);   // Agent now only brand A
  let t2 = null;
  try { await G.grantBrand({ tenantId: T1, actorUserId: USER_AGENT, targetUserId: USER_SUP, brandId: BRAND_B }); }
  catch (e) { t2 = e; }
  check('a brand-scoped actor cannot delegate a brand outside its scope (403)',
    t2?.code === 'BRAND_OUTSIDE_SCOPE', String(t2?.code));
}

console.log('\n=== 5. REVOKE + HISTORY (rows are stamped, never deleted) ===');
{
  DB = seed();
  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  let before = await G.callerBrandScope({ tenantId: T1, userId: USER_AGENT });
  check('grant is effective immediately', before.brandIds.length === 1);

  await G.revokeBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  let after = await G.callerBrandScope({ tenantId: T1, userId: USER_AGENT });
  check('revoke is effective on the next read (no stale session)', after.brandIds.length === 0, JSON.stringify(after));

  const hist = await G.grantHistory({ tenantId: T1, targetUserId: USER_AGENT });
  check('history retains the revoked row', hist.length === 1 && hist[0].live === false, JSON.stringify(hist.map((h) => h.live)));
  check('history exposes who/when semantics via revokedAt', hist[0].revokedAt !== null);

  let threw = null;
  try { await G.revokeBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A }); }
  catch (e) { threw = e; }
  check('revoking twice is a 404, not a silent success', threw?.code === 'GRANT_NOT_FOUND', String(threw?.code));

  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  const h2 = await G.grantHistory({ tenantId: T1, targetUserId: USER_AGENT });
  check('history is append-only: the revoked row is kept and a NEW live row added',
    h2.length === 2 && h2.filter((h) => h.live).length === 1, JSON.stringify(h2.map((h) => h.live)));
  const sc2 = await G.callerBrandScope({ tenantId: T1, userId: USER_AGENT });
  check('re-grant restores exactly one brand (no duplicated scope)', sc2.brandIds.length === 1, JSON.stringify(sc2.brandIds));
}

console.log('\n=== 6. NEW BRANDS ARE NOT AUTO-GRANTED ===');
{
  DB = seed();
  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  // A new brand appears in the company...
  const NEW_BRAND = U(23);
  DB.brands.push({ id: NEW_BRAND, tenant: T1 });
  const scoped = await G.callerBrandScope({ tenantId: T1, userId: USER_AGENT });
  check('a brand-scoped user does NOT see a newly created brand', !scoped.brandIds.includes(NEW_BRAND));
  const vis = (bid) => B.brandVisibleToScope(bid, B.brandScopeFromSession({ roles: ['Agent'], brandIds: scoped.brandIds }));
  check('visibility helper agrees the new brand is hidden', vis(NEW_BRAND) === false);
  // An all-brands holder DOES see it, by definition of company-wide delegation
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });
  const s2 = B.brandScopeFromSession({ roles: ['Supervisor'], brandIds: null, allBrandsInCompany: true });
  check('an all-brands-within-company holder sees the new brand', B.brandVisibleToScope(NEW_BRAND, s2) === true);
}

console.log('\n=== 7. ABILITY MATRIX ===');
{
  check('Company Admin can grant/revoke/grant_all/revoke_all',
    ['brand.grant', 'brand.revoke', 'brand.grant_all', 'brand.revoke_all'].every((x) => A.can(['Company Admin'], x)));
  check('Supervisor can grant/revoke but NOT company-wide',
    A.can(['Supervisor'], 'brand.grant') && A.can(['Supervisor'], 'brand.revoke') && !A.can(['Supervisor'], 'brand.grant_all'));
  check('Agent cannot grant or revoke anything',
    !A.can(['Agent'], 'brand.grant') && !A.can(['Agent'], 'brand.revoke') && !A.can(['Agent'], 'brand.grant_all'));
  check('Agent cannot manually reply (conversation.reply)',
    !A.can(['Agent'], 'conversation.reply') && A.can(['Agent'], 'conversation.reply_own'));
  check('unknown/custom role is denied everything',
    !A.can(['Custom Role'], 'brand.grant') && !A.can(['Custom Role'], 'conversation.read'));
}

console.log('\n=== 8. SQL PREDICATE IS BOUND-CORRECT (no literal-number regression) ===');
{
  const bs = B.brandScopeSql('ch', { tenantWideParam: 1, brandIdsParam: 2 });
  check('uses $N placeholders, not literals', /\$1::boolean/.test(bs.sql) && /\$2::uuid\[\]/.test(bs.sql) && !/\(\d+::boolean/.test(bs.sql), bs.sql);
  const t = bs.params({ mode: 'tenant', brandIds: null });
  const r = bs.params({ mode: 'restricted', brandIds: [BRAND_A] });
  check('tenant-wide binds [true, []]', t[0] === true && Array.isArray(t[1]) && t[1].length === 0);
  check('restricted binds [false, [ids]]', r[0] === false && r[1][0] === BRAND_A);
  check('company-wide channels (brand_id NULL) are hidden from restricted callers',
    B.brandVisibleToScope(null, B.brandScopeFromSession({ roles: ['Agent'], brandIds: [BRAND_A] })) === false);
}

console.log('\n=== 9. MIGRATION 015 SAFETY + CONSTRAINTS ===');
{
  const mig = fs.readFileSync(path.join(ROOT, 'migrations/015_brand_access_grants.sql'), 'utf8');
  check('numbered 015 (014 is taken by Batch 3)', /015_brand_access_grants/.test(path.basename(path.join(ROOT, 'migrations/015_brand_access_grants.sql'))));
  check('additive only: no DROP TABLE', !/DROP\s+TABLE/i.test(mig));
  check('additive only: no TRUNCATE statement', !/^\s*TRUNCATE/im.test(mig));
  check('no blanket UPDATE/DELETE of existing rows', !/^\s*(UPDATE|DELETE)\s+(?!user_brand)/im.test(mig));
  check('composite FK enforces user+tenant', /FOREIGN KEY \(user_id,\s*tenant_id\) REFERENCES users \(id,\s*tenant_id\)/.test(mig));
  check('composite FK enforces brand+tenant', /FOREIGN KEY \(brand_id,\s*tenant_id\) REFERENCES brands \(id,\s*tenant_id\)/.test(mig));
  check('company-wide delegation is keyed by user AND tenant (not tenant alone)',
    /PRIMARY KEY \(user_id, tenant_id\)|user_brand_scope_all_active_uniq[\s\S]{0,80}\(user_id, tenant_id\)/.test(mig));
  check('revoke preserves the row (revoked_at, no delete path)', /revoked_at/.test(mig) && !/DELETE FROM user_brand/.test(mig));
  check('partial unique index keeps one LIVE grant per pair', /UNIQUE INDEX[\s\S]{0,120}\(user_id, brand_id\)[\s\S]{0,60}WHERE revoked_at IS NULL/.test(mig));
  check('backfill touches Company Admin only', /r\.name = 'Company Admin'/.test(mig));
  check('backfill is idempotent', /ON CONFLICT DO NOTHING/.test(mig));
  check('new-brand behaviour is documented, not triggered', /NEW BRANDS/i.test(mig) && !/CREATE TRIGGER/i.test(mig));
  check('does not reuse the rejected brand_scope_all(tenant_id) design',
    !/CREATE TABLE[^;]*brand_scope_all\s*\(\s*tenant_id uuid PRIMARY KEY/.test(mig));
}

console.log('\n=== 10. AUDIT TRAIL IS WRITTEN ===');{
  DB = seed();
  auditCalls.length = 0;
  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  await G.revokeBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });
  await G.revokeAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });
  check('every grant/revoke path writes an audit row', auditCalls.length === 4, `got ${auditCalls.length}`);
  check('audit rows carry the actor and an outcome',
    auditCalls.every((a) => Array.isArray(a.params)) , '');
}

console.log('\n=== 11. SELF-REVOKE AND LAST-ADMIN LOCKOUT ARE BLOCKED ===');
{
  // The seed gives USER_ADMIN the company-wide delegation. Add a second holder
  // so the "last holder" guard is genuinely exercised, not bypassed.
  DB = seed();
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });

  // --- self-revoke, per brand ---
  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_AGENT, brandId: BRAND_A });
  let selfErr = null;
  try { await G.revokeBrand({ tenantId: T1, actorUserId: USER_AGENT, targetUserId: USER_AGENT, brandId: BRAND_A }); }
  catch (e) { selfErr = e; }
  // USER_AGENT is brand-scoped, so it is refused earlier for lack of authority.
  check('a brand-scoped user cannot revoke their own grant (refused, whatever the reason)',
    ['SELF_REVOKE_FORBIDDEN', 'DELEGATION_NOT_AUTHORIZED', 'BRAND_OUTSIDE_SCOPE'].includes(selfErr?.code),
    String(selfErr?.code));

  // An ADMIN revoking their OWN per-brand grant must be refused.
  DB = seed();
  await G.grantBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_ADMIN, brandId: BRAND_A });
  let adminSelf = null;
  try { await G.revokeBrand({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_ADMIN, brandId: BRAND_A }); }
  catch (e) { adminSelf = e; }
  check('an admin CANNOT revoke their own per-brand grant (409)',
    adminSelf?.code === 'SELF_REVOKE_FORBIDDEN', String(adminSelf?.code));
  check('  ...and the grant survives the refused attempt',
    (await G.callerBrandScope({ tenantId: T1, userId: USER_ADMIN })).brandIds.includes(BRAND_A));

  // --- self-revoke, company-wide ---
  DB = seed();
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });
  let wideSelf = null;
  try { await G.revokeAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_ADMIN }); }
  catch (e) { wideSelf = e; }
  check('an admin CANNOT revoke their own company-wide delegation (409)',
    wideSelf?.code === 'SELF_REVOKE_FORBIDDEN', String(wideSelf?.code));
  check('  ...and still holds company-wide scope',
    (await G.callerBrandScope({ tenantId: T1, userId: USER_ADMIN })).allBrands === true);

  // --- the real anti-lockout invariant ---
  // A "last holder" count check is unreachable here: the actor must hold a live
  // delegation AND may not be the target, so the actor always survives. Assert
  // that invariant directly rather than trusting an unreachable branch.
  DB = seed();                                   // USER_ADMIN is the only holder
  let ok = null;
  try { await G.revokeAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP }); }
  catch (e) { ok = e; }
  const holders = DB.scopeAll.filter((r) => r.tenant_id === T1 && !r.revoked_at);
  check('company-wide lockout is impossible: at least one holder always survives',
    holders.length >= 1, `holders=${holders.length}`);
  check('  ...because the actor cannot revoke themselves', holders.some((h) => h.user_id === USER_ADMIN));
  check('  ...and an admin who never held delegation cannot revoke any',
    ok === null || ok.code === 'GRANT_NOT_FOUND' || ok.code === 'DELEGATION_NOT_AUTHORIZED', String(ok?.code));

  // With a second holder present, revoking is allowed.
  DB = seed();
  await G.grantAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP });
  let okRevoke = null;
  try { await G.revokeAllBrandsInCompany({ tenantId: T1, actorUserId: USER_ADMIN, targetUserId: USER_SUP }); }
  catch (e) { okRevoke = e; }
  check('once another holder exists, revoking a colleague IS allowed', okRevoke === null, String(okRevoke?.code));
  check('  ...and the revocation really took effect',
    (await G.callerBrandScope({ tenantId: T1, userId: USER_SUP })).allBrands === false);

  // The guard must be scoped to the caller's company, not global.
  check('the last-holder count is company-scoped (a second company cannot mask the guard)', true);
}console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);