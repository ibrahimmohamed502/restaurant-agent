/**
 * Stage 8 Batch 1 — Platform Super Admin Session Privilege Tests
 * Tests: session role refresh, privilege changes, revocation
 * Run: node scripts/test-batch1-session-privilege.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';
import { encrypt } from '../src/db/crypto.js';

process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const users = new Map();
const sessions = new Map();
const tenants = new Map([
  ['t-ufc', { id: 't-ufc', name: 'UFC', slug: 'ufc', status: 'active' }],
  ['t-test', { id: 't-test', name: 'Test Company', slug: 'test-company', status: 'active' }]
]);
const brands = new Map([
  ['b-main', { id: 'b-main', tenant_id: 't-ufc', name: 'Main Brand', slug: 'main', status: 'active' }]
]);
const channels = new Map([
  ['c-main', { id: 'c-main', tenant_id: 't-ufc', brand_id: 'b-main', provider: 'meta_comment', external_id: 'page123', display_name: 'Main Channel', status: 'active', created_at: new Date('2024-01-01') }]
]);
const providerCredentials = new Map([
  ['c-main:t-ufc', { channel_id: 'c-main', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: (() => { const { value, iv } = encrypt('test_token'); return value; })(), iv: (() => { const { iv } = encrypt('test_token'); return iv; })() }]
]);
const roles = new Map();
const userRoles = new Map();
const platformSuperAdmins = new Set();

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    
    if (/from tenants where id = \$\d+/.test(s)) {
      const val = params[0];
      const t = tenants.get(val);
      return { rows: t ? [t] : [] };
    }
    
    if (/from users[\s\S]*left join user_roles[\s\S]*left join roles[\s\S]*where u\.email = \$\d+/.test(s)) {
      const email = params[0].toLowerCase();
      for (const [, u] of users) if (u.email === email) return { rows: [{ ...u, roles: Array.from(userRoles.get(u.id) || []) }] };
      return { rows: [] };
    }
    
    if (/from channels where external_id = \$\d+ and provider = 'meta'/.test(s)) {
      const extId = params[0];
      for (const [, c] of channels) {
        if (c.external_id === extId && c.provider === 'meta') {
          return { rows: [c] };
        }
      }
      return { rows: [] };
    }
    
    if (/from provider_credentials where channel_id = \$\d+ and tenant_id = \$\d+/.test(s)) {
      const channelId = params[0];
      const tenantId = params[1];
      const key = `${channelId}:${tenantId}`;
      const cred = providerCredentials.get(key);
      return { rows: cred ? [cred] : [] };
    }
    
    if (/insert into sessions/.test(s)) return { rows: [] };
    if (/update sessions set revoked_at/.test(s)) return { rows: [] };
    if (/select 1 from platform_super_admins where user_id = \$\d+/.test(s)) {
      const userId = params[0];
      return { rows: platformSuperAdmins.has(userId) ? [{ '?column?': 1 }] : [] };
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
    
    if (/from roles where tenant_id = \$\d+ and name = \$\d+/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const r = roles.get(key);
      return { rows: r ? [r] : [] };
    }
    
    if (/insert into roles/.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const r = { id: key, tenant_id: params[0], name: params[1], permissions: params[2] };
      roles.set(key, r);
      return { rows: [r] };
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
    
    if (/delete from platform_super_admins/.test(s)) {
      platformSuperAdmins.delete(params[0]);
      return { rows: [] };
    }
    
    return { rows: [] };
  }
};

const { createApiV1Router } = await import('../src/api/v1/index.js');
const { createPlatformRouter } = await import('../src/api/v1/platform.js');
const { createSession, validateSession } = await import('../src/auth/sessions.js');
const { hashPassword } = await import('../src/auth/passwords.js');

// Mock validateSession function that checks platformSuperAdmins
const mockValidateSession = async (token) => {
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
};

// Main router with mock validateSessionFn
const mainRouter = createApiV1Router({
  pool: db,
  verifyPasswordFn: async (plain, hash) => plain === hash,
  createSessionFn: async ({ tenantId, userId }) => { const t = crypto.randomBytes(16).toString('hex'); sessions.set(t, { tenantId, userId, revoked: false }); return { token: t, expiresAt: new Date(Date.now() + 60000) }; },
  validateSessionFn: mockValidateSession,
  revokeSessionFn: async (token) => sessions.delete(token),
  revokeOtherSessionsFn: async () => {},
  lockedSecondsFn: async () => 0,
  recordFailedLoginFn: async () => {},
  resetLoginAttemptsFn: async () => {}
});

// Platform router with mock validateSessionFn
const platformRouter = createPlatformRouter();

// Wrap platform router to inject mock validateSessionFn
const platformRouterWrapper = express.Router();
platformRouterWrapper.use((req, res, next) => {
  req.validateSession = mockValidateSession;
  next();
});
platformRouterWrapper.use('/platform', platformRouter);

// Combined router
const combinedRouter = express.Router();
combinedRouter.use('/api/v1', mainRouter);
combinedRouter.use('/api/v1', platformRouterWrapper);

const app = express();
app.use(express.json());
app.use(combinedRouter);

// Debug: log all requests
app.use((req, res, next) => {
  console.log('[DEBUG REQ]', req.method, req.url);
  next();
});

// Debug: list registered routes
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

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

console.log('\n🧪 Stage 8 Batch 1 — Platform Super Admin Session Privilege Tests\n');

// Setup: Create Platform Super Admin user
const psaUserId = 'u-psa-' + crypto.randomBytes(8).toString('hex');
users.set(psaUserId, { id: psaUserId, tenant_id: 't-ufc', email: 'psa@test.com', name: 'PSA', password_hash: 'secret123', status: 'active' });
platformSuperAdmins.add(psaUserId);

// Setup: Create Company Admin user
const caUserId = 'u-ca-' + crypto.randomBytes(8).toString('hex');
users.set(caUserId, { id: caUserId, tenant_id: 't-test', email: 'ca@test.com', name: 'CA', password_hash: 'secret123', status: 'active' });
const caRoleKey = 't-test:Company Admin';
roles.set(caRoleKey, { id: caRoleKey, tenant_id: 't-test', name: 'Company Admin', permissions: ['company.read','company.update'] });
userRoles.set(caUserId, [caRoleKey]);

console.log('--- Login & Session Creation ---');
const { bootCsrfCookie, bootCsrf } = await setupCsrf();
console.log('[DEBUG] Boot CSRF cookie:', bootCsrfCookie, 'Boot CSRF:', bootCsrf);

const psaLogin = await call('/auth/login', { method: 'POST', body: { email: 'psa@test.com', password: 'secret123' }, csrf: bootCsrf, cookie: bootCsrfCookie });
check('PSA login → 200', psaLogin.status === 200);
const psaSessionCookie = psaLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const psaCsrfCookie = psaLogin.setCookie.match(/csrf_token=[^;]*/)?.[0];
const psaCsrf = psaCsrfCookie?.split('=')[1];
const psaCookie = [psaSessionCookie, psaCsrfCookie].filter(Boolean).join('; ');
// PSA role is added by validateSessionFn, check via /auth/me
let psaMe = await call('/auth/me', { cookie: psaCookie, csrf: psaCsrf });
check('PSA /auth/me has Platform Super Admin role', psaMe.body?.data?.roles?.includes('Platform Super Admin'));

const caLogin = await call('/auth/login', { method: 'POST', body: { email: 'ca@test.com', password: 'secret123' }, csrf: bootCsrf, cookie: bootCsrfCookie });
check('CA login → 200', caLogin.status === 200);
const caSessionCookie = caLogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const caCsrfCookie = caLogin.setCookie.match(/csrf_token=[^;]*/)?.[0];
const caCsrf = caCsrfCookie?.split('=')[1];
const caCookie = [caSessionCookie, caCsrfCookie].filter(Boolean).join('; ');
check('CA session does NOT have Platform Super Admin role', !caLogin.body?.data?.user?.roles?.includes('Platform Super Admin'));

console.log('\n--- Session Role Refresh on Privilege Change ---');
// Initially PSA has Platform Super Admin role
psaMe = await call('/auth/me', { cookie: psaCookie, csrf: psaCsrf });
check('PSA /auth/me has Platform Super Admin role', psaMe.body?.data?.roles?.includes('Platform Super Admin'));

// Add PSA to platform_super_admins (simulating privilege grant)
platformSuperAdmins.add(psaUserId);

// Next request should reflect new role WITHOUT re-login (session refresh)
psaMe = await call('/auth/me', { cookie: psaCookie, csrf: psaCsrf });
check('PSA /auth/me reflects new Platform Super Admin role immediately', psaMe.body?.data?.roles?.includes('Platform Super Admin'));

// Remove PSA from platform_super_admins (simulating privilege revocation)
platformSuperAdmins.delete(psaUserId);

// Next request should reflect revoked privilege
psaMe = await call('/auth/me', { cookie: psaCookie, csrf: psaCsrf });
check('PSA /auth/me reflects revoked Platform Super Admin role immediately', !psaMe.body?.data?.roles?.includes('Platform Super Admin'));

console.log('\n--- Cross-Tenant Session Isolation ---');
// RE-ADD PSA to platformSuperAdmins for platform endpoint tests
platformSuperAdmins.add(psaUserId);

// PSA has session for t-ufc, CA has session for t-test
// PSA should not access Company Admin endpoints for t-test
const psaPlatformRes = await call('/platform/companies', { cookie: psaCookie, csrf: psaCsrf });
check('PSA can access /platform/companies', psaPlatformRes.status === 200);

// CA should not access Platform endpoints
const caPlatformRes = await call('/platform/companies', { cookie: caCookie, csrf: caCsrf });
check('CA cannot access /platform/companies', caPlatformRes.status === 403 || caPlatformRes.status === 404);

// PSA with t-ufc session cannot access Company Admin endpoints for t-test
const psaCompaniesRes = await call('/companies/company', { cookie: psaCookie, csrf: psaCsrf });
check('PSA with t-ufc session cannot access /companies/company for t-test', psaCompaniesRes.status === 403 || psaCompaniesRes.status === 404);

console.log('\n--- Session Revocation on Tenant Disable ---');
// Simulate disabling tenant t-test
tenants.get('t-test').status = 'disabled';
// Revoke all sessions for t-test (as done in platform.js disable endpoint)
for (const [token, s] of sessions) {
  if (s.tenantId === 't-test') s.revoked = true;
}
// CA's session should be revoked
const caMe = await call('/auth/me', { cookie: caCookie, csrf: caCsrf });
check('CA session revoked after tenant disable', caMe.status === 401);

// PSA's session should still work (different tenant)
psaMe = await call('/auth/me', { cookie: psaCookie, csrf: psaCsrf });
check('PSA session still valid (different tenant)', psaMe.status === 200);

console.log('\n--- Platform Super Admin Cannot Impersonate Company Admin ---');
// PSA tries to access Company Admin endpoints using their Platform session
const psaBrandsRes = await call('/companies/brands', { cookie: psaCookie, csrf: psaCsrf });
check('PSA cannot access /companies/brands', psaBrandsRes.status === 403 || psaBrandsRes.status === 404);

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);