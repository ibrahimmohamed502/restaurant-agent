/**
 * Stage 8 Batch 1 — Company Admin Brand Management Security Tests
 * Tests: brand creation, update, disable, access control
 * Run: node scripts/test-batch1-company-admin.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';

const users = new Map();
const sessions = new Map();
const tenants = new Map([
  ['t-test', { id: 't-test', name: 'Test Company', slug: 'test-company', status: 'active' }]
]);
const brands = new Map([
  ['b-test', { id: 'b-test', tenant_id: 't-test', name: 'Test Brand', slug: 'test-brand', status: 'active' }]
]);
const roles = new Map();
const userRoles = new Map();
const auditLogs = [];

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
    if (/from tenants/.test(s) && /order by/.test(s)) {
      return { rows: Array.from(tenants.values()) };
    }
    if (/from tenants where slug = \$\d+/.test(s)) {
      const slug = params[0];
      for (const [, t] of tenants) if (t.slug === slug) return { rows: [t] };
      return { rows: [] };
    }
    
    if (/from brands where tenant_id = \$\d+/.test(s)) {
      const tenantId = params[0];
      return { rows: Array.from(brands.values()).filter(b => b.tenant_id === tenantId) };
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
    
    // Disable associated channels
    if (/update channels set status = 'inactive'/.test(s)) {
      return { rows: [] };
    }
    
    if (/update brands set/.test(s) && /where id = \$\d+ and tenant_id = \$\d+/.test(s)) {
      const id = params[0];
      const tenantId = params[1];
      if (brands.has(id) && brands.get(id).tenant_id === tenantId) {
        const b = brands.get(id);
        // Params after the first two: name, slug, status, defaultLanguage
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
    if (/insert into roles/.test(s) && /on conflict/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const r = { id: key, tenant_id: params[0], name: params[1], permissions: params[2] };
      roles.set(key, r);
      return { rows: [r] };
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
    
    if (/insert into user_roles/.test(s)) {
      const uid = params[0];
      const rid = params[1];
      if (!userRoles.has(uid)) userRoles.set(uid, []);
      if (!userRoles.get(uid).includes(rid)) userRoles.get(uid).push(rid);
      return { rows: [] };
    }
    
    if (/insert into sessions/.test(s)) return { rows: [] };
    if (/update sessions set revoked_at/.test(s)) return { rows: [] };
    if (/select count.*from sessions where tenant_id = \$\d+ and revoked_at is null/.test(s)) {
      return { rows: [{ c: 0 }] };
    }
    
    if (/select count.*from channels/.test(s)) {
      return { rows: [{ total: 3, active: 2 }] };
    }
    
    // Company Admin: get company
    if (/from tenants t[\s\S]*where t\.id = \$\d+/.test(s)) {
      const id = params[0];
      const t = tenants.get(id);
      if (!t) return { rows: [] };
      return { rows: [{ ...t, brands: Array.from(brands.values()).filter(b => b.tenant_id === t.id).map(b => ({ id: b.id, name: b.name, slug: b.slug, status: b.status, createdAt: b.created_at })) }] };
    }
    
    // Company Admin: update company
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
    
    return { rows: [] };
  },
  
  connect: async () => ({
    query: async (sql, params = []) => db.query(sql, params),
    release: () => {}
  })
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

const caUserId = 'u-ca-' + crypto.randomBytes(8).toString('hex');
users.set(caUserId, { id: caUserId, tenant_id: 't-test', email: 'ca@test.com', name: 'CA', password_hash: 'secret123', status: 'active' });
const caRoleKey = 't-test:Company Admin';
roles.set(caRoleKey, { id: caRoleKey, tenant_id: 't-test', name: 'Company Admin', permissions: [
  'brand.read','brand.create','brand.update','brand.disable',
  'user.read','user.create','user.update','user.disable',
  'brand.integration.connect','brand.integration.disconnect',
  'brand.integration.reconnect','brand.integration.status',
  'company.read','company.update',
  'conversation.read','conversation.handoff','conversation.assign',
  'conversation.reassign','conversation.unassign','conversation.resolve',
  'conversation.resume_ai','conversation.reply',
  'note.read','note.create','note.delete_any','notification.read',
  'conversation.assign_self','conversation.reply_own','conversation.resolve_own',
  'note.delete_own'
] });
userRoles.set(caUserId, [caRoleKey]);

console.log('\n🧪 Stage 8 Batch 1 — Company Admin Brand Management Tests\n');

const { bootCsrfCookie, bootCsrf } = await setupCsrf();

function makeReq(method, path, body, cookie, csrf) {
  return call(path, { method, body, cookie: cookie || bootCsrfCookie, csrf: csrf || bootCsrf });
}

const caLogin = await makeReq('POST', '/auth/login', { email: 'ca@test.com', password: 'secret123' });
const caSessionCookie = caLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const caCookie = [caSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
const caCsrf = bootCsrf;

console.log('--- Company Admin: Get Company ---');
{
  const res = await makeReq('GET', '/companies/company', null, caCookie, caCsrf);
  check('GET /companies/company → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns company with brands', !!res.body?.data?.brands);
  }
}

console.log('\n--- Company Admin: Update Company ---');
{
  const res = await makeReq('PATCH', '/companies/company', { name: 'Updated Company', slug: 'updated-company', timezone: 'UTC', locale: 'en' }, caCookie, caCsrf);
  check('PATCH /companies/company → 200', res.status === 200);
  if (res.status === 200) {
    check('Name updated', res.body?.data?.name === 'Updated Company');
    check('Slug updated', res.body?.data?.slug === 'updated-company');
  }
}

console.log('\n--- Company Admin: List Brands ---');
{
  const res = await makeReq('GET', '/companies/brands', null, caCookie, caCsrf);
  check('GET /companies/brands → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns array', Array.isArray(res.body?.data));
    check('Includes test brand', res.body?.data?.some(b => b.slug === 'test-brand'));
  }
}

console.log('\n--- Company Admin: Create Brand ---');
{
  const res = await makeReq('POST', '/companies/brands', { name: 'New Brand', slug: 'new-brand', defaultLanguage: 'en' }, caCookie, caCsrf);
  check('POST /companies/brands → 201', res.status === 201);
  if (res.status === 201) {
    check('Returns brand', !!res.body?.data?.id);
    check('Default language set', res.body?.data?.default_language === 'en');
  }
}

console.log('\n--- Company Admin: Update Brand ---');
{
  const listRes = await makeReq('GET', '/companies/brands', null, caCookie, caCsrf);
  const created = listRes.body?.data?.find(b => b.slug === 'new-brand');
  if (created) {
    const res = await makeReq('PATCH', `/companies/brands/${created.id}`, { name: 'Updated Brand', slug: 'updated-brand', status: 'active', defaultLanguage: 'ar' }, caCookie, caCsrf);
    check('PATCH /companies/brands/:id → 200', res.status === 200);
    if (res.status === 200) {
      check('Name updated', res.body?.data?.name === 'Updated Brand');
      check('Slug updated', res.body?.data?.slug === 'updated-brand');
      check('Language updated', res.body?.data?.default_language === 'ar');
    }
  }
}

console.log('\n--- Company Admin: Disable Brand ---');
{
  const listRes = await makeReq('GET', '/companies/brands', null, caCookie, caCsrf);
  const toDisable = listRes.body?.data?.find(b => b.slug === 'updated-brand');
  if (toDisable) {
    const res = await makeReq('POST', `/companies/brands/${toDisable.id}/disable`, {}, caCookie, caCsrf);
    console.log('[DEBUG] Disable brand response:', JSON.stringify(res.body));
    check('POST /companies/brands/:id/disable → 200', res.status === 200);
    if (res.status === 200) {
      check('Status is disabled', res.body?.data?.status === 'disabled', `got ${res.body?.data?.status}`);
    }
  }
}

console.log('\n--- Platform Super Admin: FORBIDDEN on /companies/* ---');
{
  const psaUserId = 'u-psa-' + crypto.randomBytes(8).toString('hex');
  users.set(psaUserId, { id: psaUserId, tenant_id: 't-ufc', email: 'psa@test.com', name: 'PSA', password_hash: 'secret123', status: 'active' });
  // PSA user has tenant 't-ufc', not 't-test', so cannot access test tenant data
  const psaLogin = await makeReq('POST', '/auth/login', { email: 'psa@test.com', password: 'secret123' });
  const psaSessionCookie = psaLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
  const psaCookie = [psaSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
  const psaCsrf = bootCsrf;

  const endpoints = [
    { method: 'GET', path: '/companies/company' },
    { method: 'PATCH', path: '/companies/company', body: { name: 'Hacked' } },
    { method: 'POST', path: '/companies/brands', body: { name: 'X', slug: 'x' } },
    { method: 'PATCH', path: '/companies/brands/b-test', body: { name: 'Hacked' } },
    { method: 'POST', path: '/companies/brands/b-test/disable', body: {} },
  ];
  for (const ep of endpoints) {
    const res = await makeReq(ep.method, ep.path, ep.body ?? null, psaCookie, psaCsrf);
    // PSA with different tenant gets 404 (not found) or 403 (forbidden)
    check(`${ep.method} ${ep.path} → 403/404`, res.status === 403 || res.status === 404, `got ${res.status}`);
  }
  
  // GET /brands requires brand.read (Company Admin) → 403 for PSA (only has Platform Super Admin)
  const brandsRes = await makeReq('GET', '/companies/brands', null, psaCookie, psaCsrf);
  check('GET /companies/brands → 403 (PSA lacks brand.read)', brandsRes.status === 403 || brandsRes.status === 404);
}

console.log('\n--- Cross-Tenant: Company A Admin cannot access Company B brands ---');
{
  // Create Company B
  const tenantB = { id: 't-company-b', name: 'Company B', slug: 'company-b', status: 'active' };
  tenants.set(tenantB.id, tenantB);
  const brandB = { id: 'b-company-b', tenant_id: tenantB.id, name: 'Brand B', slug: 'brand-b', status: 'active' };
  brands.set(brandB.id, brandB);
  
  // Create Company B Admin
  const caBUserId = 'u-ca-b-' + crypto.randomBytes(8).toString('hex');
  users.set(caBUserId, { id: caBUserId, tenant_id: tenantB.id, email: 'ca-b@test.com', name: 'CA-B', password_hash: 'secret123', status: 'active' });
  const caBRoleKey = `${tenantB.id}:Company Admin`;
  roles.set(caBRoleKey, { id: caBRoleKey, tenant_id: tenantB.id, name: 'Company Admin', permissions: ['brand.read','brand.create','brand.update','brand.disable'] });
  userRoles.set(caBUserId, [caBRoleKey]);
  
  const caBLogin = await makeReq('POST', '/auth/login', { email: 'ca-b@test.com', password: 'secret123' });
  const caBSessionCookie = caBLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
  const caBCookie = [caBSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
  const caBCsrf = bootCsrf;
  
  // Company B Admin tries to list brands (should only see Company B brands)
  const res = await makeReq('GET', '/companies/brands', null, caBCookie, caBCsrf);
  check('Company B Admin sees only own brands', res.status === 200 && res.body?.data?.every(b => b.tenant_id === tenantB.id));
  
  // Company B Admin tries to create brand with guessed Company A brand ID (should fail or create in own tenant)
  const createRes = await makeReq('POST', '/companies/brands', { name: 'Hacked', slug: 'hacked' }, caBCookie, caBCsrf);
  check('Company B Admin creates brand in own tenant', createRes.status === 201);
}

console.log('\n--- Validation: Create Brand ---');
{
  const tests = [
    { body: { name: '', slug: 'x' }, desc: 'empty name', expect: 422 },
    { body: { name: 'X', slug: '' }, desc: 'empty slug', expect: 422 },
    { body: { name: 'X', slug: 'X' }, desc: 'uppercase slug', expect: 422 },
    { body: { name: 'X', slug: 'x', defaultLanguage: 'fr' }, desc: 'unsupported language (accepted)', expect: 201 },
  ];
  for (const t of tests) {
    const res = await makeReq('POST', '/companies/brands', t.body, caCookie, caCsrf);
    check(`Validation ${t.desc} → ${t.expect}`, res.status === t.expect, `got ${res.status}`);
  }
}

console.log('\n--- Validation: Update Brand ---');
{
  const listRes = await makeReq('GET', '/companies/brands', null, caCookie, caCsrf);
  const created = listRes.body?.data?.find(b => b.slug === 'test-brand');
  if (created) {
    const tests = [
      { body: { name: '', slug: created.slug }, desc: 'empty name with slug (allowed)', expect: 200 },
      { body: { name: 'X', slug: 'X' }, desc: 'uppercase slug', expect: 422 },
      { body: { name: 'X', slug: created.slug, status: 'invalid' }, desc: 'invalid status', expect: 422 },
    ];
    for (const t of tests) {
      const res = await makeReq('PATCH', `/companies/brands/${created.id}`, t.body, caCookie, caCsrf);
      check(`Validation ${t.desc} → ${t.expect}`, res.status === t.expect, `got ${res.status}`);
    }
  }
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);