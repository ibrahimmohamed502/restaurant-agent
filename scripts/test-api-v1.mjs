/**
 * Stage 5.0 — /api/v1 auth/CSRF/tenant-context tests.
 * Mocked DB + mocked auth deps; spin up an ephemeral Express app; zero network.
 * Run: node scripts/test-api-v1.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
import express from 'express';
import crypto from 'node:crypto';

const users = new Map();
const loginFails = new Map();
const sessions = new Map();
const tenants = new Map([['t1', { id: 't1', name: 'UFC', slug: 'ufc' }]]);
let lastUsersSql = '';
const verifyCalls = [];
const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/FROM users[\s\S]*WHERE u\.email = \$1/.test(s)) {
      lastUsersSql = s;
      const u = users.get(params[0]);
      return { rows: u ? [{ ...u, roles: u.roles }] : [] };
    }
    if (/FROM tenants WHERE id = \$1/.test(s)) return { rows: tenants.has(params[0]) ? [tenants.get(params[0])] : [] };
    return { rows: [] };
  }
};

const { createApiV1Router } = await import('../src/api/v1/index.js');
const router = createApiV1Router({
  pool: db,
  verifyPasswordFn: async (plain, hash) => { verifyCalls.push({ plain, hash }); return plain === hash; },
  createSessionFn: async ({ tenantId, userId }) => { const t = crypto.randomBytes(16).toString('hex'); sessions.set(t, { tenantId, userId }); return { token: t, expiresAt: new Date(Date.now() + 60000) }; },
  validateSessionFn: async (token) => sessions.has(token) ? { tenantId: sessions.get(token).tenantId, user: { id: sessions.get(token).userId, email: 'a@b.co', name: 'A' }, roles: ['Company Admin'] } : null,
  revokeSessionFn: async (token) => sessions.delete(token),
  lockedSecondsFn: async (email) => (loginFails.get(email) || 0) >= 5 ? 60 : 0,
  recordFailedLoginFn: async (email) => loginFails.set(email, (loginFails.get(email) || 0) + 1),
  resetLoginAttemptsFn: async () => {}
});

const app = express();
app.use(express.json());
app.use('/api/v1', router);
app.use((err, _req, res, next) => { if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'malformed JSON body' } }); next(err); });
await new Promise((r) => { app._server = app.listen(0, '127.0.0.1', r); });
const base = `http://127.0.0.1:${app._server.address().port}/api/v1`;

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };
const call = async (path, { method = 'GET', body, cookie, csrf } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j, setCookie: r.headers.get('set-cookie') || '' };
};

// obtain a CSRF cookie first (double-submit bootstrap)
const boot = await fetch(base + '/_health');
const bootCsrfCookie = (boot.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
const bootCsrf = bootCsrfCookie?.split('=')[1];
const post = (path, body, extra = {}) => call(path, { method: 'POST', body, cookie: bootCsrfCookie, csrf: bootCsrf, ...extra });

console.log('\n🧪 Stage 5.0 — /api/v1 foundation\n');
users.set('a@b.co', { id: 'u1', tenant_id: 't1', email: 'a@b.co', name: 'A', password_hash: 'secret123', status: 'active', roles: ['Company Admin'] });
users.set('bad@b.co', { id: 'u2', tenant_id: 't1', email: 'bad@b.co', name: 'B', password_hash: 'other', status: 'active', roles: [] });
users.set('off@b.co', { id: 'u3', tenant_id: 't1', email: 'off@b.co', name: 'C', password_hash: 'secret123', status: 'suspended', roles: [] });
users.set('pending@b.co', { id: 'u4', tenant_id: 't1', email: 'pending@b.co', name: 'D', password_hash: 'secret123', status: 'pending', roles: [] });

// login success
const ok = await post('/auth/login', { email: 'a@b.co', password: 'secret123' });
// (cookie assertions use the boot csrf cookie + login session cookie)
const cookie = ok.setCookie.match(/lwc_session=[^;]*/)?.[0];
const csrfCookie = ok.setCookie.match(/csrf_token=[^;]*/)?.[0];
const csrf = csrfCookie?.split('=')[1];
check('login success → 200 + user payload without sensitive fields', ok.status === 200 && ok.j.data?.user?.email === 'a@b.co' && !JSON.stringify(ok.j).includes('password') && !JSON.stringify(ok.j).includes('session'));
check('login sets httpOnly session cookie + readable csrf cookie', Boolean(cookie) && /HttpOnly/i.test(ok.setCookie) && Boolean(bootCsrfCookie));

// regression: createSession returns { token, expiresAt } in production — the cookie
// must carry the RAW token string, never the serialized object
check('login cookie carries the raw session token (createSession return is destructured)', Boolean(cookie) && !cookie.includes('%7B') && !cookie.includes('j=') && sessions.has(cookie.split('=')[1]));
const meAfterLogin = await call('/auth/me', { cookie });
check('GET /auth/me with the login session cookie → 200 (end-to-end session validation)', meAfterLogin.status === 200 && meAfterLogin.j.data?.user?.email === 'a@b.co' && meAfterLogin.j.data?.tenantId === 't1');

// login failure: wrong password, unknown email, inactive → identical 401
const bad1 = await post('/auth/login', { email: 'a@b.co', password: 'nope' });
const bad2 = await post('/auth/login', { email: 'ghost@b.co', password: 'x' });
const bad3 = await post('/auth/login', { email: 'off@b.co', password: 'secret123' });
check('login failures → identical 401 INVALID_CREDENTIALS (no account enumeration)', bad1.status === 401 && bad2.status === 401 && bad3.status === 401 && bad1.j.error.code === 'INVALID_CREDENTIALS' && bad2.j.error.code === 'INVALID_CREDENTIALS');

// validation
const val = await post('/auth/login', { email: 'not-an-email', password: '' });
check('login validation → 422 VALIDATION_ERROR with field details', val.status === 422 && val.j.error.code === 'VALIDATION_ERROR' && val.j.error.details?.email === 'invalid_email');

// rate limiting
let limited = null;
for (let i = 0; i < 6; i++) { const r = await post('/auth/login', { email: 'x@y.co', password: 'z' }); if (r.status === 429) limited = r; }
check('repeated failures → 429 RATE_LIMITED', limited?.status === 429 && limited.j.error.code === 'RATE_LIMITED');

// --- schema regression: /auth/login must query the real users.status column ---
check('login SQL selects users.status (matches migration 001 schema)', /u\.status/.test(lastUsersSql) && !/u\.is_active/.test(lastUsersSql) && !/is_active/.test(lastUsersSql));
check('active user reaches password verification (hash passed to verifier)', verifyCalls.some((c) => c.hash === 'secret123'));
verifyCalls.length = 0;
const suspendedUser = await post('/auth/login', { email: 'off@b.co', password: 'secret123' });
const nonActiveUser = await post('/auth/login', { email: 'pending@b.co', password: 'secret123' });
check('non-active users (suspended/pending) → 401 INVALID_CREDENTIALS, not 500', suspendedUser.status === 401 && nonActiveUser.status === 401 && suspendedUser.j.error.code === 'INVALID_CREDENTIALS' && nonActiveUser.j.error.code === 'INVALID_CREDENTIALS');
check('non-active users never reach password verification', verifyCalls.length === 0);
const dummy = await post('/auth/login', { email: 'dummy-nonexistent@example.invalid', password: 'diagnostic-probe' });
check('invalid dummy credentials → 401 INVALID_CREDENTIALS, never 500 INTERNAL', dummy.status === 401 && dummy.j.error.code === 'INVALID_CREDENTIALS');

// me + logout
const me = await call('/auth/me', { cookie });
check('GET /auth/me → 200 with user+tenant (no secrets)', me.status === 200 && me.j.data.tenantId === 't1' && !JSON.stringify(me.j).includes('password_hash'));
const meAnon = await call('/auth/me');
check('GET /auth/me unauthenticated → 401', meAnon.status === 401 && meAnon.j.error.code === 'UNAUTHENTICATED');
const logout = await post('/auth/logout', {}, { cookie: bootCsrfCookie + '; ' + cookie, csrf: bootCsrf });
const meAfter = await call('/auth/me', { cookie });
check('logout revokes session (subsequent /me → 401)', logout.status === 200 && meAfter.status === 401);

// CSRF: mutation without token
const noCsrf = await call('/auth/logout', { method: 'POST', cookie });
check('mutation without CSRF token → 403 CSRF_INVALID', noCsrf.status === 403 && noCsrf.j.error.code === 'CSRF_INVALID');
const badCsrf = await call('/auth/logout', { method: 'POST', cookie, csrf: 'deadbeef' });
check('mutation with wrong CSRF token → 403', badCsrf.status === 403 && badCsrf.j.error.code === 'CSRF_INVALID');

// CSRF cold start (login blocker regression): protection stays enforced, but a
// first-touch GET must issue the cookie so the login page can warm up.
const coldLogin = await call('/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'secret123' } });
check('cold login (no CSRF cookie/header) → 403 CSRF_INVALID (protection still enforced)', coldLogin.status === 403 && coldLogin.j.error.code === 'CSRF_INVALID');
const bootstrap = await fetch(base + '/auth/me');
const bootCookie = (bootstrap.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
check('cold GET through API issues csrf_token cookie (bootstrap available)', Boolean(bootCookie));
const warmLogin = await call('/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'secret123' }, cookie: bootCookie, csrf: bootCookie?.split('=')[1] });
check('first login submit after CSRF bootstrap → 200 (no cold-start failure)', warmLogin.status === 200 && warmLogin.j.data?.user?.email === 'a@b.co');

// tenant context from session only
const relogin = await post('/auth/login', { email: 'a@b.co', password: 'secret123' });
const cookie2 = relogin.setCookie.match(/lwc_session=[^;]*/)?.[0];
const cur = await call('/tenants/current', { cookie: cookie2 });
check('GET /tenants/current → session tenant (client cannot choose tenant)', cur.status === 200 && cur.j.data.slug === 'ufc');
const spoof = await fetch(base + '/tenants/current?tenantId=t1', { headers: { Cookie: cookie2 } });
check('tenant query param ignored (auth-derived only)', spoof.status === 200);

// security headers
const h = await fetch(base + '/_health', { redirect: 'manual' });
check('security headers present (nosniff/frame-deny/CSP)', h.headers.get('x-content-type-options') === 'nosniff' && h.headers.get('x-frame-options') === 'DENY' && (h.headers.get('content-security-policy') || '').includes("default-src 'none'"));

// malformed JSON
const bad = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
check('malformed JSON → 400 BAD_JSON (no stack trace)', bad.status === 400 && !JSON.stringify(await bad.json()).includes('at '));

// RBAC helper exists and denies unknown roles
const { requireV1Role } = await import('../src/api/v1/index.js');
let denied = false;
const probe = express();
probe.use((req, _res, next) => { req.v1 = { tenantId: 't1', roles: [] }; next(); });
probe.get('/x', requireV1Role('Company Admin'), (_req, res) => res.json({ ok: true }));
probe.get('/x', (_req, res) => { denied = true; res.json({ ok: true }); });
const p = await new Promise((r) => { const s = probe.listen(0, '127.0.0.1', () => r(s)); });
const rb = await fetch(`http://127.0.0.1:${p.address().port}/x`);
check('RBAC guard denies users without the role (403)', rb.status === 403);
p.close();

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
app._server.close();
process.exit(failed === 0 ? 0 : 1);
