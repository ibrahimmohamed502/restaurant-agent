/**
 * Stage 8 Batch 1 — Platform Super Admin Security Tests
 * Mocked DB + mocked auth deps; zero network.
 * Run: node scripts/test-batch1-platform-admin.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';

const users = new Map();
const sessions = new Map();
const tenants = new Map([
  ['t-ufc', { id: 't-ufc', name: 'UFC', slug: 'ufc', status: 'active' }],
  ['t-test', { id: 't-test', name: 'Test Company', slug: 'test-company', status: 'active' }]
]);
const brands = new Map([
  ['b-main', { id: 'b-main', tenant_id: 't-ufc', name: 'Main Brand', slug: 'main', status: 'active' }],
  ['b-test', { id: 'b-test', tenant_id: 't-test', name: 'Test Brand', slug: 'test-brand', status: 'active' }]
]);
const roles = new Map();
const userRoles = new Map();
const platformSuperAdmins = new Set();
const auditLogs = [];

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

const db = {
  query: async (sql, params = []) => {
    console.log('[DEBUG MOCK DB] query called with SQL:', sql.substring(0, 100));
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    console.log('[DEBUG MOCK DB] normalized SQL:', s.substring(0, 200));
    console.log('[DEBUG MOCK DB] regex test update tenants set:', /update tenants set/.test(s));
    console.log('[DEBUG MOCK DB] regex test where id:', /where id = \$\d+/.test(s));
    console.log('[DEBUG MOCK DB] regex test not disabled:', !/status = 'disabled'/.test(s));
    console.log('[DEBUG MOCK DB] TOP LEVEL - checking all handlers...');
    
    if (/from tenants where (id|slug) = \$\d+/.test(s)) {
      console.log('[DEBUG MOCK DB] MATCHED: tenants by id/slug');
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
    if (/insert into tenants/.test(s) && /returning id/.test(s)) {
      const id = 't-' + crypto.randomBytes(8).toString('hex');
      const tenant = { id, name: params[0], slug: params[1], status: params[2] || 'active', created_at: new Date() };
      console.log('[DEBUG MOCK DB] INSERT tenant:', id, tenant.name, tenant.slug);
      tenants.set(id, tenant);
      console.log('[DEBUG MOCK DB] Tenants map size:', tenants.size);
      return { rows: [tenant] };
    }
    if (/update tenants set/.test(s) && /where id = \$\d+/.test(s) && !/set status = 'disabled'/.test(s)) {
      const id = params[0];
      if (tenants.has(id)) {
        const t = tenants.get(id);
        if (params[1]) t.name = params[1];
        if (params[2]) t.slug = params[2].toLowerCase();
        tenants.set(id, t);
        return { rows: [t] };
      }
      return { rows: [] };
    }
    
    if (/from brands where tenant_id = \$\d+/.test(s)) {
      const tenantId = params[0];
      return { rows: Array.from(brands.values()).filter(b => b.tenant_id === tenantId) };
    }
    if (/insert into brands/.test(s) && /returning id/.test(s)) {
      const id = 'b-' + crypto.randomBytes(8).toString('hex');
      const brand = { id, tenant_id: params[0], name: params[1], slug: params[2].toLowerCase(), status: params[3] || 'active', created_at: new Date() };
      brands.set(id, brand);
      return { rows: [brand] };
    }
    if (/update brands set/.test(s) && /where id = \$\d+ and tenant_id = \$\d+/.test(s)) {
      const id = params[params.length - 2];
      const tenantId = params[params.length - 1];
      if (brands.has(id) && brands.get(id).tenant_id === tenantId) {
        const b = brands.get(id);
        if (params[0]) b.name = params[0];
        if (params[1]) b.slug = params[1].toLowerCase();
        if (params[2]) b.status = params[2];
        if (params[3]) b.default_language = params[3];
        brands.set(id, b);
        return { rows: [b] };
      }
      return { rows: [] };
    }
    if (/update brands set status = 'disabled'/.test(s)) {
      const id = params[0];
      if (brands.has(id)) {
        const b = brands.get(id);
        b.status = 'disabled';
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
    if (/insert into users/.test(s) && /returning id/.test(s)) {
      const id = 'u-' + crypto.randomBytes(8).toString('hex');
      const user = { id, tenant_id: params[0], email: params[1].toLowerCase(), name: params[2], password_hash: params[3], status: params[4] };
      users.set(id, user);
      return { rows: [user] };
    }
    if (/select count.*from users where tenant_id = \$\d+/.test(s)) {
      const tenantId = params[0];
      let count = 0;
      for (const [, u] of users) if (u.tenant_id === tenantId) count++;
      return { rows: [{ total: count }] };
    }
    
    if (/from roles where tenant_id = \$\d+ and name = \$\d+/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const r = roles.get(key);
      return { rows: r ? [r] : [] };
    }
    if (/select permissions from roles where tenant_id = '\w+' and name = 'company admin'/.test(s) ||
        /select permissions from roles where tenant_id = \$\d+ and name = 'company admin'/.test(s)) {
      const tenantId = params[0];
      for (const [, r] of roles) {
        if (r.tenant_id === tenantId && r.name === 'Company Admin') {
          return { rows: [r] };
        }
      }
      return { rows: [] };
    }
    if (/insert into roles/.test(s) && /on conflict.*do nothing/.test(s)) {
      const key = `${params[0]}:Company Admin`;
      if (roles.has(key)) {
        return { rows: [] };
      }
      const perms = JSON.parse(params[1]);
      const r = { id: key, tenant_id: params[0], name: 'Company Admin', permissions: perms };
      roles.set(key, r);
      return { rows: [r] };
    }
    if (/insert into roles/.test(s) && /on conflict/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const r = { id: key, tenant_id: params[0], name: params[1], permissions: params[2] };
      roles.set(key, r);
      return { rows: [r] };
    }
    if (/insert into roles/.test(s) && /returning id/.test(s)) {
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
    
    if (/insert into platform_super_admins/.test(s)) {
      platformSuperAdmins.add(params[0]);
      return { rows: [] };
    }
    if (/select 1 from platform_super_admins where user_id = \$\d+/.test(s)) {
      return { rows: platformSuperAdmins.has(params[0]) ? [{ '?column?': 1 }] : [] };
    }
    
    if (/insert into sessions/.test(s)) return { rows: [] };
    if (/insert into teams \(tenant_id, name\) values \(\$1,\$2\) on conflict do nothing/.test(s)) {
      return { rows: [] };
    }
    if (/update sessions set revoked_at/.test(s) && /where tenant_id = \$\d+/) {
      const tenantId = params[0];
      let count = 0;
      for (const [token, s] of sessions) if (s.tenantId === tenantId && !s.revoked) { s.revoked = true; count++; }
      return { rows: [{ count }] };
    }
    if (/update sessions set revoked_at/.test(s) && /where token_hash = \$\d+/) {
      const h = params[0];
      for (const [token, s] of sessions) if (hashToken(token) === h) { s.revoked = true; break; }
      return { rows: [] };
    }
    if (/select count.*from sessions where tenant_id = \$\d+ and revoked_at is null/.test(s)) {
      const tenantId = params[0];
      let count = 0;
      for (const [, s] of sessions) if (s.tenantId === tenantId && !s.revoked) count++;
      return { rows: [{ c: count }] };
    }
    
    if (/insert into audit_logs/.test(s)) {
      auditLogs.push({ action: params[0], object_type: params[1], tenant_id: params[2], actor_user_id: params[3], metadata: params[4] });
      return { rows: [] };
    }
    if (/select \* from audit_logs where action = \$\d+/.test(s)) {
      const action = params[0];
      return { rows: auditLogs.filter(a => a.action === action).map((a, i) => ({ ...a, id: i })) };
    }
    
    if (/select count.*from brands where tenant_id = \$\d+/.test(s)) {
      const tenantId = params[0];
      let count = 0;
      for (const [, b] of brands) if (b.tenant_id === tenantId) count++;
      return { rows: [{ count: count }] };
    }
    
    if (/select count.*from conversations/.test(s)) {
      return { rows: [{ total: 5 }] };
    }
    
    if (/select count.*from channels/.test(s)) {
      return { rows: [{ total: 3, active: 2 }] };
    }
    
    // Platform Super Admin: list companies
    if (/from tenants t[\s\S]*left join.*brands[\s\S]*left join.*users[\s\S]*order by t\.created_at desc/.test(s)) {
      return { rows: Array.from(tenants.values()).map(t => ({
        id: t.id, name: t.name, slug: t.slug, status: t.status, created_at: t.created_at,
        brands_count: Array.from(brands.values()).filter(b => b.tenant_id === t.id).length,
        users_count: Array.from(users.values()).filter(u => u.tenant_id === t.id).length
      })) };
    }
    
    // Platform Super Admin: get company detail (with brands json_agg)
    if (/from tenants t[\s\S]*where t\.id = \$\d+/.test(s) && /json_agg/.test(s)) {
      const id = params[0];
      const t = tenants.get(id);
      if (!t) return { rows: [] };
      return { 
        rows: [{
          ...t,
          brands: Array.from(brands.values())
            .filter(b => b.tenant_id === t.id)
            .map(b => ({ id: b.id, name: b.name, slug: b.slug, status: b.status, createdAt: b.created_at })),
          users_count: Array.from(users.values()).filter(u => u.tenant_id === t.id).length
        }] 
      };
    }
    
    // Platform Super Admin: metrics
    if (/select count.*from tenants[\s\S]*filter.*where status = 'active'/.test(s) || /count\(\*\)::int as total.*filter.*where status = 'active'/.test(s)) {
      const total = tenants.size;
      const active = Array.from(tenants.values()).filter(t => t.status === 'active').length;
      return { rows: [{ total, active }] };
    }
    if (/select count.*from users[\s\S]*filter.*where status = 'active'/.test(s) || /count\(\*\)::int as total.*filter.*where status = 'active'/.test(s)) {
      const total = users.size;
      const active = Array.from(users.values()).filter(u => u.status === 'active').length;
      return { rows: [{ total, active }] };
    }
    
    // Platform Super Admin: update company
    console.log('[DEBUG MOCK DB] Checking UPDATE handler...');
    const updateTenantsMatch = /update tenants set/.test(s);
    const whereIdMatch = /where id = \$\d+/.test(s);
    const notDisabledMatch = !/status = 'disabled'/.test(s);
    console.log('[DEBUG MOCK DB] UPDATE match:', { updateTenantsMatch, whereIdMatch, notDisabledMatch, s: s.substring(0, 100) });
    if (updateTenantsMatch && whereIdMatch && notDisabledMatch) {
      console.log('[DEBUG MOCK DB] UPDATE tenants SQL matched!');
      console.log('[DEBUG MOCK DB] UPDATE tenants params:', params);
      console.log('[DEBUG MOCK DB] tenants map keys:', Array.from(tenants.keys()));
      // Handle UPDATE tenants SET name = $1, slug = $2 WHERE id = $3 RETURNING ...
      // Params order: [id, name, slug] (id is first)
      const id = params[0];
      console.log('[DEBUG MOCK DB] UPDATE tenants looking for id:', id, 'tenants.has:', tenants.has(id));
      if (tenants.has(id)) {
        const t = tenants.get(id);
        if (params[1]) t.name = params[1];
        if (params[2]) t.slug = params[2].toLowerCase();
        tenants.set(id, t);
        console.log('[DEBUG MOCK DB] UPDATE tenant updated:', t.id, t.name, t.slug);
        return { rows: [t] };
      }
      console.log('[DEBUG MOCK DB] UPDATE tenant not found, returning 404');
      return { rows: [] };
    }
    
    // Platform Super Admin: disable company
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
    
    console.log('[DEBUG MOCK DB] No handler matched for SQL:', s.substring(0, 200));
    return { rows: [] };
  },
  
  connect: async () => {
    // Return a mock client that supports transactions
    const client = {
      query: async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        
        if (/begin/.test(s)) return { rows: [] };
        if (/commit/.test(s)) return { rows: [] };
        if (/rollback/.test(s)) return { rows: [] };
        
        // Delegate to main query handler
        return db.query(sql, params);
      },
      release: () => {}
    };
    return client;
  }
};

const { createApiV1Router } = await import('../src/api/v1/index.js');
const { createPlatformRouter } = await import('../src/api/v1/platform.js');

// Mock audit function for testing
const mockAudit = async ({ tenantId = null, actorUserId = null, action, objectType = null, objectId = null, ip = null, metadata = {} }) => {
  console.log('[DEBUG AUDIT MOCK] Called with:', { tenantId, actorUserId, action, objectType, objectId, caller: 'MOCK', mockId: 'MOCK_AUDIT_FN' });
  auditLogs.push({ tenant_id: tenantId, actor_user_id: actorUserId, action, object_type: objectType, object_id: objectId, ip, metadata: JSON.stringify(metadata) });
  return { mock: true };
};

// Main router with mock validateSessionFn
const mainRouter = createApiV1Router({
  pool: db,
  platformAuditFn: mockAudit,
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
    if (platformSuperAdmins.has(s.userId)) roleNames.push('Platform Super Admin');
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
app.use('/api/v1', mainRouter);
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

const psaUserId = 'u-psa-' + crypto.randomBytes(8).toString('hex');
users.set(psaUserId, { id: psaUserId, tenant_id: 't-ufc', email: 'psa@test.com', name: 'PSA', password_hash: 'secret123', status: 'active' });
platformSuperAdmins.add(psaUserId);

const caUserId = 'u-ca-' + crypto.randomBytes(8).toString('hex');
users.set(caUserId, { id: caUserId, tenant_id: 't-test', email: 'ca@test.com', name: 'CA', password_hash: 'secret123', status: 'active' });

const testTenant = tenants.get('t-test');
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

console.log('\n🧪 Stage 8 Batch 1 — Platform Super Admin Security Tests\n');

const { bootCsrfCookie, bootCsrf } = await setupCsrf();

function makeReq(method, path, body, cookie, csrf) {
  console.log(`[DEBUG] makeReq: cookie="${cookie?.substring(0, 50)}...", csrf="${csrf}"`);
  return call(path, { method, body, cookie: cookie || bootCsrfCookie, csrf: csrf || bootCsrf });
}

console.log('--- Platform Super Admin: Login & Session ---');
{
  const ok = await makeReq('POST', '/auth/login', { email: 'psa@test.com', password: 'secret123' });
  check('PSA login success → 200', ok.status === 200);
  const psaCookie = ok.setCookie.match(/lwc_session=[^;]*/)?.[0];
  const psaCsrfCookie = ok.setCookie.match(/csrf_token=[^;]*/)?.[0];
  const psaCsrf = psaCsrfCookie?.split('=')[1];
  const psaSessionToken = psaCookie?.split('=')[1];
  check('PSA session created', Boolean(psaSessionToken));
  check('PSA has Platform Super Admin role', Boolean(psaUserId && platformSuperAdmins.has(psaUserId)));
}

const psaLogin = await makeReq('POST', '/auth/login', { email: 'psa@test.com', password: 'secret123' });
const psaSessionCookie = psaLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const psaCookie = [psaSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
const psaCsrf = bootCsrf;

const caLogin = await makeReq('POST', '/auth/login', { email: 'ca@test.com', password: 'secret123' });
const caSessionCookie = caLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const caCookie = [caSessionCookie, bootCsrfCookie].filter(Boolean).join('; ');
const caCsrf = bootCsrf;

console.log('\n--- Platform Super Admin: Create Company ---');
{
  const res = await makeReq('POST', '/platform/companies', { name: 'New Company', slug: 'new-company', adminEmail: 'admin@newco.test', adminName: 'Admin', adminPassword: 'SecurePass123' }, psaCookie, psaCsrf);
  check('POST /platform/companies → 201', res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
  if (res.status === 201) {
    check('Response includes company', !!res.body?.data?.company?.id);
    check('Response includes brand', !!res.body?.data?.brand?.id);
    check('Response includes admin user', !!res.body?.data?.admin?.id);
    check('Admin user has correct email', res.body?.data?.admin?.email === 'admin@newco.test');
  }
}

console.log('\n--- Platform Super Admin: List Companies ---');
{
  const res = await makeReq('GET', '/platform/companies', null, psaCookie, psaCsrf);
  check('GET /platform/companies → 200', res.status === 200);
  if (res.status === 200) {
    check('Returns array', Array.isArray(res.body?.data));
    check('Includes test company', res.body?.data?.some(c => c.slug === 'test-company'));
    check('Includes created company', res.body?.data?.some(c => c.slug === 'new-company'));
  }
}

console.log('\n--- Platform Super Admin: Get Company Detail ---');
{
  const listRes = await makeReq('GET', '/platform/companies', null, psaCookie, psaCsrf);
  const created = listRes.body?.data?.find(c => c.slug === 'new-company');
  if (created) {
    const res = await makeReq('GET', `/platform/companies/${created.id}`, null, psaCookie, psaCsrf);
    check('GET /platform/companies/:id → 200', res.status === 200);
    check('Returns company with brands', !!res.body?.data?.brands);
    check('Brand count matches', res.body?.data?.brands?.length >= 1);
  }
}

console.log('\n--- Platform Super Admin: Update Company ---');
{
  const listRes = await makeReq('GET', '/platform/companies', null, psaCookie, psaCsrf);
  const created = listRes.body?.data?.find(c => c.slug === 'new-company');
  if (created) {
    console.log('[DEBUG] Created company:', created);
    const res = await makeReq('PATCH', `/platform/companies/${created.id}`, { name: 'Updated Company Name', slug: 'updated-company' }, psaCookie, psaCsrf);
    console.log('[DEBUG] PATCH response:', res.status, res.body);
    check('PATCH /platform/companies/:id → 200', res.status === 200);
    if (res.status === 200) {
      check('Name updated', res.body?.data?.name === 'Updated Company Name');
      check('Slug updated', res.body?.data?.slug === 'updated-company');
    }
  }
}

console.log('\n--- Platform Super Admin: Disable Company ---');
{
  const listRes = await makeReq('GET', '/platform/companies', null, psaCookie, psaCsrf);
  const toDisable = listRes.body?.data?.find(c => c.slug === 'updated-company');
  if (toDisable) {
    const res = await makeReq('POST', `/platform/companies/${toDisable.id}/disable`, {}, psaCookie, psaCsrf);
    check('POST /platform/companies/:id/disable → 200', res.status === 200);
    if (res.status === 200) {
      check('Status is disabled', res.body?.data?.status === 'disabled');
    }
  }
}

console.log('\n--- Platform Super Admin: Platform Metrics ---');
{
  const res = await makeReq('GET', '/platform/metrics', null, psaCookie, psaCsrf);
  check('GET /platform/metrics → 200', res.status === 200);
  if (res.status === 200) {
    check('Has companies metrics', typeof res.body?.data?.companies?.total === 'number');
    check('Has users metrics', typeof res.body?.data?.users?.total === 'number');
    check('Has conversations metrics', typeof res.body?.data?.conversations?.total === 'number');
    check('Has channels metrics', typeof res.body?.data?.channels?.total === 'number');
  }
}

console.log('\n--- Company Admin: FORBIDDEN on /platform/* ---');
{
  const endpoints = [
    { method: 'GET', path: '/platform/companies' },
    { method: 'POST', path: '/platform/companies', body: { name: 'X', slug: 'x', adminEmail: 'a@b.c', adminName: 'A', adminPassword: 'Pass1234' } },
    { method: 'GET', path: '/platform/metrics' },
    { method: 'GET', path: `/platform/companies/${testTenant.id}` },
    { method: 'PATCH', path: `/platform/companies/${testTenant.id}`, body: { name: 'Hacked' } },
    { method: 'POST', path: `/platform/companies/${testTenant.id}/disable`, body: {} },
  ];
  for (const ep of endpoints) {
    const res = await makeReq(ep.method, ep.path, ep.body ?? null, caCookie, caCsrf);
    check(`${ep.method} ${ep.path} → 403 FORBIDDEN`, res.status === 403, `got ${res.status}`);
  }
}

console.log('\n--- Unauthenticated: FORBIDDEN on /platform/* ---');
{
  const res = await makeReq('GET', '/platform/companies', null, 'lwc_session=invalid', 'x');
  check('Unauthenticated → 401', res.status === 401);
}

console.log('\n--- Validation: Create Company ---');
{
  const tests = [
    { body: { name: '', slug: 'x', adminEmail: 'a@b.c', adminName: 'A', adminPassword: 'Pass1234' }, desc: 'empty name' },
    { body: { name: 'X', slug: '', adminEmail: 'a@b.c', adminName: 'A', adminPassword: 'Pass1234' }, desc: 'empty slug' },
    { body: { name: 'X', slug: 'X', adminEmail: 'a@b.c', adminName: 'A', adminPassword: 'Pass1234' }, desc: 'uppercase slug' },
    { body: { name: 'X', slug: 'x', adminEmail: 'invalid', adminName: 'A', adminPassword: 'Pass1234' }, desc: 'invalid email' },
    { body: { name: 'X', slug: 'x', adminEmail: 'a@b.c', adminName: 'A', adminPassword: 'short' }, desc: 'short password' },
    { body: { name: 'X', slug: 'x', adminEmail: 'a@b.c', adminName: '', adminPassword: 'Pass1234' }, desc: 'empty admin name' },
  ];
  for (const t of tests) {
    const res = await makeReq('POST', '/platform/companies', t.body, psaCookie, psaCsrf);
    check(`Validation rejects ${t.desc} → 422`, res.status === 422, `got ${res.status}`);
  }
}

console.log('\n--- Audit Log: Company Create ---');
{
  const logs = auditLogs.filter(a => a.action === 'platform.company.create');
  check('Audit log entry exists for company create', logs.length > 0);
  if (logs.length > 0) {
    check('Audit has correct object_type', logs[0].object_type === 'tenant');
    check('Audit has tenant_id', !!logs[0].tenant_id);
    check('Audit has actor', !!logs[0].actor_user_id);
  }
}

console.log('\n--- Audit Log: Company Disable ---');
{
  const logs = auditLogs.filter(a => a.action === 'platform.company.disable');
  check('Audit log entry exists for company disable', logs.length > 0);
  if (logs.length > 0) {
    check('Audit has correct object_type', logs[0].object_type === 'tenant');
    check('Audit has tenant_id', !!logs[0].tenant_id);
    check('Audit has actor', !!logs[0].actor_user_id);
  }
}

console.log('\n--- Regression: ON CONFLICT DO NOTHING preserves custom permissions ---');
{
  // Pre-seed a tenant with a Company Admin role that has CUSTOM permissions (not the default explicit set)
  const customTenantId = 't-custom-perms';
  const customPerms = ['brand.read', 'brand.create', 'user.read']; // Minimal custom set
  tenants.set(customTenantId, { id: customTenantId, name: 'Custom Perms Co', slug: 'custom-perms', status: 'active', created_at: new Date() });
  brands.set('b-custom', { id: 'b-custom', tenant_id: customTenantId, name: 'Main', slug: 'main', status: 'active', created_at: new Date() });
  const customRoleKey = `${customTenantId}:Company Admin`;
  roles.set(customRoleKey, { id: customRoleKey, tenant_id: customTenantId, name: 'Company Admin', permissions: customPerms });
  
  // Create a new company - this will trigger the role creation logic for the NEW tenant
  // But first, let's verify the custom tenant's role is preserved
  const { rows: customRoleCheck } = await db.query(
    `SELECT permissions FROM roles WHERE tenant_id = $1 AND name = 'Company Admin'`,
    [customTenantId]
  );
  check('Custom permissions preserved before create', JSON.stringify(customRoleCheck[0]?.permissions) === JSON.stringify(customPerms));
  
  // Now create a NEW company (different tenant) - this should work normally with default perms
  const res = await makeReq('POST', '/platform/companies', { name: 'Another Co', slug: 'another-co', adminEmail: 'admin@another.test', adminName: 'Admin', adminPassword: 'SecurePass123' }, psaCookie, psaCsrf);
  check('POST /platform/companies with new tenant → 201', res.status === 201);
  
  if (res.status === 201) {
    const newTenantId = res.body.data.company.id;
    // Verify the NEW tenant got the explicit default permissions (30 perms)
    const { rows: newRoleCheck } = await db.query(
      `SELECT permissions FROM roles WHERE tenant_id = $1 AND name = 'Company Admin'`,
      [newTenantId]
    );
    check('New tenant gets explicit default permissions (30)', newRoleCheck[0]?.permissions?.length === 30);
    check('New tenant has no wildcard', !newRoleCheck[0]?.permissions?.includes('*'));
  }
  
  // Verify the custom tenant's role is STILL preserved after the new company creation
  const { rows: customRoleCheck2 } = await db.query(
    `SELECT permissions FROM roles WHERE tenant_id = $1 AND name = 'Company Admin'`,
    [customTenantId]
  );
  check('Custom permissions STILL preserved after new company create', JSON.stringify(customRoleCheck2[0]?.permissions) === JSON.stringify(customPerms));
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);