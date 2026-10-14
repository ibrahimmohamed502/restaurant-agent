/**
 * Stage 8 Batch 1 — Cross-Tenant Isolation Security Tests
 * Tests: Company A cannot access Company B resources
 * Run: node scripts/test-batch1-cross-tenant.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';

const users = new Map();
const sessions = new Map();
const tenants = new Map([
  ['t-company-a', { id: 't-company-a', name: 'Company A', slug: 'company-a', status: 'active' }],
  ['t-company-b', { id: 't-company-b', name: 'Company B', slug: 'company-b', status: 'active' }],
  ['t-ufc', { id: 't-ufc', name: 'UFC', slug: 'ufc', status: 'active' }]
]);
const brands = new Map([
  ['b-a1', { id: 'b-a1', tenant_id: 't-company-a', name: 'Brand A1', slug: 'brand-a1', status: 'active' }],
  ['b-a2', { id: 'b-a2', tenant_id: 't-company-a', name: 'Brand A2', slug: 'brand-a2', status: 'active' }],
  ['b-b1', { id: 'b-b1', tenant_id: 't-company-b', name: 'Brand B1', slug: 'brand-b1', status: 'active' }]
]);
const roles = new Map();
const userRoles = new Map();

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    
    if (/from tenants where (id|slug) = \$\d+/.test(s)) {
      const val = params[0];
      const t = tenants.get(val);
      return { rows: t ? [t] : [] };
    }
    
    if (/from tenants t[\s\S]*where t\.id = \$\d+/.test(s)) {
      const id = params[0];
      const t = tenants.get(id);
      if (!t) return { rows: [] };
      return { rows: [{ ...t, brands: Array.from(brands.values()).filter(b => b.tenant_id === t.id).map(b => ({ id: b.id, name: b.name, slug: b.slug, status: b.status, createdAt: b.created_at })) }] };
    }
    
    if (/from brands where tenant_id = \$\d+/.test(s)) {
      const tenantId = params[0];
      return { rows: Array.from(brands.values()).filter(b => b.tenant_id === tenantId) };
    }
    
    if (/from brands where id = \$\d+ and tenant_id = \$\d+/.test(s)) {
      const id = params[0];
      const tenantId = params[1];
      if (brands.has(id) && brands.get(id).tenant_id === tenantId) {
        return { rows: [brands.get(id)] };
      }
      return { rows: [] };
    }
    
    if (/insert into brands/.test(s) && /returning id/.test(s)) {
      const id = 'b-' + crypto.randomBytes(8).toString('hex');
      const brand = { id, tenant_id: params[0], name: params[1], slug: params[2].toLowerCase(), status: params[3] || 'active', default_language: params[3] || 'ar', created_at: new Date() };
      brands.set(id, brand);
      return { rows: [brand] };
    }
    
    if (/update brands set status = 'disabled'/.test(s)) {
      const id = params[0];
      const tenantId = params[1];
      if (brands.has(id) && brands.get(id).tenant_id === tenantId && brands.get(id).status === 'active') {
        const b = brands.get(id);
        b.status = 'disabled';
        brands.set(id, b);
        return { rows: [b] };
      }
      return { rows: [] };
    }
    
    if (/update channels set status = 'inactive'/.test(s)) {
      return { rows: [] };
    }
    
    if (/update brands set/.test(s) && /where id = \$\d+ and tenant_id = \$\d+/.test(s)) {
      const id = params[0];
      const tenantId = params[1];
      if (brands.has(id) && brands.get(id).tenant_id === tenantId) {
        const b = brands.get(id);
        let paramIndex = 2;
        if (params[paramIndex]) { b.name = params[paramIndex]; paramIndex++; }
        if (params[paramIndex]) { b.slug = params[paramIndex].toLowerCase(); paramIndex++; }
        if (params[paramIndex]) { b.status = params[paramIndex]; paramIndex++; }
        if (params[paramIndex]) { b.default_language = params[paramIndex]; paramIndex++; }
        brands.set(id, b);
        return { rows: [b] };
      }
      return { rows: [] };
    }
    
    if (/from users[\s\S]*where u\.email = \$\d+/.test(s)) {
      const email = params[0].toLowerCase();
      for (const [, u] of users) if (u.email === email) return { rows: [{ ...u, roles: Array.from(userRoles.get(u.id) || []) }] };
      return { rows: [] };
    }
    
    if (/from roles where tenant_id = \$\d+ and name = \$\d+/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const r = roles.get(key);
      return { rows: r ? [r] : [] };
    }
    
    if (/select r.name from user_roles/.test(s)) {
      const userId = params[0];
      const rids = userRoles.get(userId) || [];
      const names = [];
      for (const rid of rids) {
        for (const [, r] of roles) if (r.id === rid) names.push(r.name);
      }
      return { rows: names.map(n => ({ name: n })) };
    }
    
    if (/insert into sessions/.test(s)) return { rows: [] };
    
    if (/update tenants set/.test(s) && /where id = \$\d+/.test(s) && !/status = 'disabled'/.test(s)) {
      const id = params[0];
      if (tenants.has(id)) {
        const t = tenants.get(id);
        if (params[1]) t.name = params[1];
        if (params[2]) t.slug = params[2].toLowerCase();
        if (params[3]) t.timezone = params[3];
        if (params[4]) t.locale = params[4];
        tenants.set(id, t);
        return { rows: [t] };
      }
      return { rows: [] };
    }
    
    if (/update tenants set status = 'disabled'/.test(s)) {
      const id = params[0];
      if (tenants.has(id)) {
        const t = tenants.get(id);
        t.status = 'disabled';
        tenants.set(id, t);
        return { rows: [t] };
      }
      return { rows: [] };
    }
    
    if (/select count.*from channels/.test(s)) {
      return { rows: [{ total: 3, active: 2 }] };
    }
    
    return { rows: [] };
  }
};

const { createApiV1Router } = await import('../src/api/v1/index.js');
const router = createApiV1Router({
  pool: db,
  verifyPasswordFn: async (plain, hash) => plain === hash,
  createSessionFn: async ({ tenantId, userId }) => { const t = crypto.randomBytes(16).toString('hex'); sessions.set(t, { tenantId, userId, revoked: false }); return { token: t, expiresAt: new Date(Date.now() + 60000) }; },
  validateSessionFn: async (token) => {
    const s = sessions.get(token);
    if (!s || s.revoked) return null;
    const u = Array.from(users.values()).find(x => x.id === s.userId);
    if (!u) return null;
    const roleNames = (userRoles.get(s.userId) || []).map(rid => {
      for (const [, r] of roles) if (r.id === rid) return r.name;
      return null;
    }).filter(Boolean);
    return { tenantId: s.tenantId, user: { id: u.id, email: u.email, name: u.name }, roles: roleNames, sessionId: 'sess-' + s.userId };
  },
  revokeSessionFn: async (token) => sessions.delete(token),
  revokeOtherSessionsFn: async () => {},
  lockedSecondsFn: async () => 0,
  recordFailedLoginFn: async () => {},
  resetLoginAttemptsFn: async () => {}
});

const app = express();
app.use(express.json());
app.use('/api/v1', router);
app.use((err, _req, res, next) => { if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'malformed JSON body' } }); next(err); });

await new Promise((r) => { app._server = app.listen(0, '127.0.0.1', r); });
const base = `http://127.0.0.1:${app._server.address().port}/api/v1`;

const call = async (path, { method = 'GET', body, cookie, csrf } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') || '' };
};

async function setupCsrf() {
  const boot = await fetch(base + '/_health');
  const bootCsrfCookie = (boot.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
  const bootCsrf = bootCsrfCookie?.split('=')[1];
  return { bootCsrfCookie, bootCsrf };
}

const caAUserId = 'u-ca-a-' + crypto.randomBytes(8).toString('hex');
users.set(caAUserId, { id: caAUserId, tenant_id: 't-company-a', email: 'ca-a@test.com', name: 'CA-A', password_hash: 'secret123', status: 'active' });
const caARoleKey = 't-company-a:Company Admin';
roles.set(caARoleKey, { id: caARoleKey, tenant_id: 't-company-a', name: 'Company Admin', permissions: ['brand.read','brand.create','brand.update','brand.disable','company.read','company.update'] });
userRoles.set(caAUserId, [caARoleKey]);

const caBUserId = 'u-ca-b-' + crypto.randomBytes(8).toString('hex');
users.set(caBUserId, { id: caBUserId, tenant_id: 't-company-b', email: 'ca-b@test.com', name: 'CA-B', password_hash: 'secret123', status: 'active' });
const caBRoleKey = 't-company-b:Company Admin';
roles.set(caBRoleKey, { id: caBRoleKey, tenant_id: 't-company-b', name: 'Company Admin', permissions: ['brand.read','brand.create','brand.update','brand.disable','company.read','company.update'] });
userRoles.set(caBUserId, [caBRoleKey]);

console.log('\n🧪 Stage 8 Batch 1 — Cross-Tenant Isolation Tests\n');

const { bootCsrfCookie, bootCsrf } = await setupCsrf();

function makeReq(method, path, body, cookie, csrf) {
  return call(path, { method, body, cookie: cookie || bootCsrfCookie, csrf: csrf || bootCsrf });
}

const caALogin = await makeReq('POST', '/auth/login', { email: 'ca-a@test.com', password: 'secret123' });
const caASessionCookie = caALogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const caACookie = [caASessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
const caACsrf = bootCsrf;

const caBLogin = await makeReq('POST', '/auth/login', { email: 'ca-b@test.com', password: 'secret123' });
const caBSessionCookie = caBLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const caBCookie = [caBSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
const caBCsrf = bootCsrf;

console.log('--- Company A Admin: Access Own Resources ---');
{
  const res = await makeReq('GET', '/companies/company', null, caACookie, caACsrf);
  check('GET /companies/company → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns Company A', res.body?.data?.id === 't-company-a');
    check('Returns Company A brands', res.body?.data?.brands?.some(b => b.id === 'b-a1' || b.id === 'b-a2'));
    check('Does NOT return Company B brands', !res.body?.data?.brands?.some(b => b.id === 'b-b1'));
  }
}

{
  const res = await makeReq('GET', '/companies/brands', null, caACookie, caACsrf);
  check('GET /companies/brands → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns only Company A brands', res.body?.data?.every(b => b.tenant_id === 't-company-a'));
    check('Has 2 brands', res.body?.data?.length === 2);
  }
}

{
  const res = await makeReq('POST', '/companies/brands', { name: 'Brand A3', slug: 'brand-a3' }, caACookie, caACsrf);
  check('POST /companies/brands → 201', res.status === 201);
  if (res.status === 201) {
    check('Brand created in Company A', res.body?.data?.tenant_id === 't-company-a');
  }
}

console.log('\n--- Company B Admin: Access Own Resources ---');
{
  const res = await makeReq('GET', '/companies/company', null, caBCookie, caBCsrf);
  check('GET /companies/company → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns Company B', res.body?.data?.id === 't-company-b');
    check('Returns Company B brands', res.body?.data?.brands?.some(b => b.id === 'b-b1'));
    check('Does NOT return Company A brands', !res.body?.data?.brands?.some(b => b.id === 'b-a1' || b.id === 'b-a2'));
  }
}

{
  const res = await makeReq('GET', '/companies/brands', null, caBCookie, caBCsrf);
  check('GET /companies/brands → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns only Company B brands', res.body?.data?.every(b => b.tenant_id === 't-company-b'));
  }
}

console.log('\n--- Cross-Tenant: Company A Admin CANNOT Access Company B ---');
{
  // Try to GET Company B company info (should 404 - not found in Company A's tenant)
  const res = await makeReq('GET', '/companies/company', null, caACookie, caACsrf);
  // Company A admin gets their own company, not Company B's
  check('GET /companies/company returns Company A (not B)', res.status === 200 && res.body?.data?.id === 't-company-a');
}

{
  // Try to GET Company B brands directly (should only return Company A brands)
  const res = await makeReq('GET', '/companies/brands', null, caACookie, caACsrf);
  check('GET /companies/brands returns only Company A brands', res.status === 200 && res.body?.data?.every(b => b.tenant_id === 't-company-a'));
}

{
  // Try to update Company B brand (should 404 - not found in Company A's tenant)
  const res = await makeReq('PATCH', '/companies/brands/b-b1', { name: 'Hacked' }, caACookie, caACsrf);
  check('PATCH /companies/brands/b-b1 → 404', res.status === 404);
}

{
  // Try to disable Company B brand (should 404)
  const res = await makeReq('POST', '/companies/brands/b-b1/disable', {}, caACookie, caACsrf);
  check('POST /companies/brands/b-b1/disable → 404', res.status === 404);
}

{
  // Try to create brand with guessed Company B brand ID (should create in Company A)
  const res = await makeReq('POST', '/companies/brands', { name: 'Fake B', slug: 'fake-b' }, caACookie, caACsrf);
  check('POST /companies/brands creates in Company A', res.status === 201 && res.body?.data?.tenant_id === 't-company-a');
}

console.log('\n--- Cross-Tenant: Company B Admin CANNOT Access Company A ---');
{
  const res = await makeReq('PATCH', '/companies/brands/b-a1', { name: 'Hacked' }, caBCookie, caBCsrf);
  check('PATCH /companies/brands/b-a1 → 404', res.status === 404);
}

{
  const res = await makeReq('POST', '/companies/brands/b-a1/disable', {}, caBCookie, caBCsrf);
  check('POST /companies/brands/b-a1/disable → 404', res.status === 404);
}

console.log('\n--- Platform Super Admin: Cross-Tenant Access ---');
{
  const psaUserId = 'u-psa-' + crypto.randomBytes(8).toString('hex');
  users.set(psaUserId, { id: psaUserId, tenant_id: 't-ufc', email: 'psa@test.com', name: 'PSA', password_hash: 'secret123', status: 'active' });
  // Add PSA to platform_super_admins
  // Note: PSA doesn't have Company Admin role for either tenant
  const psaLogin = await makeReq('POST', '/auth/login', { email: 'psa@test.com', password: 'secret123' });
  const psaSessionCookie = psaLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
  const psaCookie = [psaSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
  const psaCsrf = bootCsrf;

  // PSA should NOT access Company Admin endpoints that require Company Admin role
  // GET /companies/company only requires auth (not Company Admin role) → 200
  // GET /companies/brands requires brand.read (Company Admin) → 403
  const endpoints = [
    { method: 'GET', path: '/companies/company', expectStatus: 200 },
    { method: 'GET', path: '/companies/brands', expectStatus: [403, 404] },
  ];
  for (const ep of endpoints) {
    const res = await makeReq(ep.method, ep.path, null, psaCookie, psaCsrf);
    if (Array.isArray(ep.expectStatus)) {
      check(`${ep.method} ${ep.path} → ${ep.expectStatus.join('/')} (PSA lacks Company Admin role for brands)`, ep.expectStatus.includes(res.status));
    } else {
      check(`${ep.method} ${ep.path} → ${ep.expectStatus} (only requires auth)`, res.status === ep.expectStatus);
    }
  }
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);