/**
 * Stage 5 extensions — /api/v1/auth/password (self-service) + /api/v1/channels
 * (read-only routing view). Mocked DB + mocked auth deps; zero network.
 * Run: node scripts/test-v1-extensions.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
import express from 'express';
import { readFileSync } from 'node:fs';

const users = new Map([
  ['a@b.co', { id: 'u1', tenant_id: 't1', email: 'a@b.co', name: 'A', status: 'active' }]
]);
const sqlLog = [];

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ');
    sqlLog.push(s);
    if (/FROM users[\s\S]*WHERE u\.email = \$1/.test(s)) {
      const u = users.get(params[0]);
      return { rows: u ? [{ ...u, roles: [] }] : [] };
    }
    if (/SELECT id, password_hash FROM users WHERE id = \$1/.test(s)) {
      return { rows: [{ id: 'u1', password_hash: params[0] === 'u1' ? 'current-secret' : '' }] };
    }
    if (/UPDATE users SET password_hash/.test(s)) return { rows: [{ id: 'u1' }] };
    if (/UPDATE sessions SET revoked_at[\s\S]*id <> \$2/.test(s)) return { rows: [] };
    if (/FROM channels c/.test(s)) {
      return {
        rows: [
          {
            id: 'ch1', provider: 'meta', external_id: '738688299520738', display_name: 'CV Elite Hub (test)',
            status: 'active', created_at: new Date().toISOString(), brand_name: 'Life with Cacao',
            health_status: 'ok', last_event_at: new Date().toISOString()
          }
        ]
      };
    }
    return { rows: [] };
  }
};

const SESSION = { tenantId: 't1', user: { id: 'u1', email: 'a@b.co', name: 'A' }, roles: ['Company Admin'], sessionId: 'sess-1' };
const revokedSessions = [];

const { createApiV1Router } = await import('../src/api/v1/index.js');
const router = createApiV1Router({
  pool: db,
  verifyPasswordFn: async (plain, hash) => plain === hash,
  validateSessionFn: async (token) => (token === 'good-session' ? SESSION : null),
  revokeSessionFn: async () => {},
  revokeOtherSessionsFn: async (userId, keepSessionId) => { revokedSessions.push({ userId, keepSessionId }); },
  lockedSecondsFn: async () => 0,
  recordFailedLoginFn: async () => {},
  resetLoginAttemptsFn: async () => {},
  createSessionFn: async () => ({ token: 'x', expiresAt: new Date() })
});

const app = express();
app.use(express.json());
app.use('/api/v1', router);
await new Promise((r) => { app._server = app.listen(0, '127.0.0.1', r); });
const base = `http://127.0.0.1:${app._server.address().port}/api/v1`;

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

// CSRF bootstrap
const boot = await fetch(base + '/_health');
const bootCookie = (boot.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
const bootCsrf = bootCookie?.split('=')[1];
const call = async (path, { method = 'GET', body, cookie, csrf } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const asAdmin = (path, opts = {}) => call(path, { cookie: bootCookie + '; lwc_session=good-session', csrf: bootCsrf, ...opts });

console.log('\n🧪 Stage 5 extensions — password change + channels\n');

// channels — read-only, tenant-scoped, auth required
const ch = await asAdmin('/channels');
check('GET /channels → 200 with tenant channels', ch.status === 200 && ch.j.data?.length === 1 && ch.j.data[0].provider === 'meta');
check('channels response never exposes credentials', !JSON.stringify(ch.j).includes('value_encrypted') && !JSON.stringify(ch.j).includes('token'));
const chSql = sqlLog.filter((s) => /FROM channels c/.test(s)).pop() ?? '';
check('channels SQL never touches provider_credentials', !chSql.includes('provider_credentials') && chSql.includes('c.tenant_id = $1'));
const chAnon = await call('/channels');
check('GET /channels unauthenticated → 401', chAnon.status === 401 && chAnon.j.error.code === 'UNAUTHENTICATED');

// users — /api/v1 envelope contract ({ data } on success, { error } on failure)
// users handlers are tenant-scoped (static contract check on the shared handlers)
const usersSrc = readFileSync(new URL('../src/routes/users.js', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ');
check('users SQL is tenant-scoped', usersSrc.includes('WHERE u.tenant_id = $1') && usersSrc.includes('$2 AND tenant_id = $3'));

const pwNoCsrf0 = await call('/users', { method: 'POST', body: { email: 'a@b.co', name: 'A', password: 'longer-password', roles: [] } });
check('POST /users without CSRF → 403 (envelope router is CSRF-guarded)', pwNoCsrf0.status === 403 && pwNoCsrf0.j.error.code === 'CSRF_INVALID');
const usersAnon = await call('/users');
check('GET /users unauthenticated → 401 JSON (never HTML redirect)', usersAnon.status === 401 && usersAnon.j.error?.code === 'UNAUTHENTICATED');

// password change
const pwNoCsrf = await call('/auth/password', { method: 'POST', body: { currentPassword: 'a', newPassword: 'b' } });
check('POST /auth/password without CSRF → 403 (protection enforced)', pwNoCsrf.status === 403 && pwNoCsrf.j.error.code === 'CSRF_INVALID');

const pwShort = await asAdmin('/auth/password', { method: 'POST', body: { currentPassword: 'current-secret', newPassword: 'short' } });
check('new password < 8 chars → 422', pwShort.status === 422 && pwShort.j.error.code === 'VALIDATION_ERROR');

const pwWrong = await asAdmin('/auth/password', { method: 'POST', body: { currentPassword: 'wrong', newPassword: 'longer-password' } });
check('wrong current password → 401 INVALID_CREDENTIALS', pwWrong.status === 401 && pwWrong.j.error.code === 'INVALID_CREDENTIALS');

const pwOk = await asAdmin('/auth/password', { method: 'POST', body: { currentPassword: 'current-secret', newPassword: 'longer-password' } });
check('valid password change → 200', pwOk.status === 200 && pwOk.j.data?.ok === true);
check('password change revokes OTHER sessions only', revokedSessions.some((r) => r.userId === 'u1' && r.keepSessionId === 'sess-1'));
check('password change updates the hash (no plaintext stored)', sqlLog.some((s) => /UPDATE users SET password_hash = \$1/.test(s)));

const pwAnon = await call('/auth/password', { method: 'POST', cookie: bootCookie, csrf: bootCsrf, body: { currentPassword: 'a', newPassword: 'longer-password' } });
check('POST /auth/password unauthenticated → 401', pwAnon.status === 401);

// delete user — guards + envelope
const delNoCsrf = await call('/users/u9', { method: 'DELETE' });
check('DELETE /users/:id without CSRF → 403 (protection enforced)', delNoCsrf.status === 403 && delNoCsrf.j.error.code === 'CSRF_INVALID');

const delSelf = await asAdmin('/users/u1', { method: 'DELETE' });
check('deleting your OWN account → 400 (guarded)', delSelf.status === 400 && /own account/i.test(String(delSelf.j.error ?? '')));

const delAnon = await call('/users/u9', { method: 'DELETE', cookie: bootCookie, csrf: bootCsrf });
check('DELETE unauthenticated → 401 JSON', delAnon.status === 401 && delAnon.j.error.code === 'UNAUTHENTICATED');

// delete handler is tenant-scoped + hard-delete (static contract check)
const usersSrc2 = readFileSync(new URL('../src/routes/users.js', import.meta.url), 'utf8').replace(/\s+/g, ' ');
check('delete is tenant-scoped hard delete', usersSrc2.includes('DELETE FROM users WHERE id = $1 AND tenant_id = $2'));

// RBAC: a non-admin session is rejected by the v1 users router (server authoritative)
const SUPERVISOR = { tenantId: 't1', user: { id: 'u2', email: 'sup@b.co', name: 'S' }, roles: ['Supervisor'], sessionId: 'sess-2' };
const rbApp = express();
rbApp.use(express.json());
rbApp.use('/api/v1', createApiV1Router({
  pool: db,
  verifyPasswordFn: async (p, h) => p === h,
  validateSessionFn: async (token) => (token === 'sup-session' ? SUPERVISOR : null),
  revokeSessionFn: async () => {},
  revokeOtherSessionsFn: async () => {},
  lockedSecondsFn: async () => 0,
  recordFailedLoginFn: async () => {},
  resetLoginAttemptsFn: async () => {},
  createSessionFn: async () => ({ token: 'x', expiresAt: new Date() })
}));
const rbServer = await new Promise((r) => { const s = rbApp.listen(0, '127.0.0.1', () => r(s)); });
const rbBase = `http://127.0.0.1:${rbServer.address().port}/api/v1`;
const rbUsers = await fetch(rbBase + '/users', { headers: { Cookie: 'lwc_session=sup-session' } });
const rbBody = await rbUsers.json();
check(
  'Supervisor session → 403 FORBIDDEN on /users (RBAC authoritative)',
  rbUsers.status === 403 && rbBody.error?.code === 'FORBIDDEN'
);
rbServer.close();

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
app._server.close();
process.exit(failed === 0 ? 0 : 1);
