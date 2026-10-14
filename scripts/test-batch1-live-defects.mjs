/**
 * Stage 8 Batch 1 — Regression tests for live acceptance defects.
 *
 * Defect 1: /brands API failed with "column default_language does not exist"
 *           → migration 012 adds the column.
 * Defect 2: /companies showed untranslated i18n keys
 *           → platform.loading/brands/users/status/created/actions were missing.
 *
 * Run: node scripts/test-batch1-live-defects.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const users = new Map();
const sessions = new Map();
const tenants = new Map([
  ['t-ufc', { id: 't-ufc', name: 'UFC', slug: 'ufc', status: 'active' }],
]);
const brands = new Map([
  ['b-main', { id: 'b-main', tenant_id: 't-ufc', name: 'Main Brand', slug: 'main', status: 'active', default_language: 'ar', created_at: new Date() }],
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

    if (/from brands where tenant_id = \$\d+/.test(s)) {
      const tenantId = params[0];
      return { rows: Array.from(brands.values()).filter(b => b.tenant_id === tenantId) };
    }
    if (/insert into brands/.test(s) && /returning/.test(s)) {
      const id = 'b-' + crypto.randomBytes(8).toString('hex');
      const brand = {
        id, tenant_id: params[0], name: params[1], slug: params[2],
        status: 'active', default_language: params[3] || 'ar', created_at: new Date()
      };
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
    if (/from users[\s\S]*where u\.email = \$\d+/.test(s)) {
      const email = params[0].toLowerCase();
      for (const [, u] of users) if (u.email === email) return { rows: [{ ...u, roles: Array.from(userRoles.get(u.id) || []) }] };
      return { rows: [] };
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
    if (/insert into audit_logs/.test(s)) {
      auditLogs.push({ action: params[0], object_type: params[1], tenant_id: params[2], actor_user_id: params[3], metadata: params[4] });
      return { rows: [] };
    }
    return { rows: [] };
  },
  connect: async () => ({
    query: async (sql, params) => db.query(sql, params),
    release: () => {}
  })
};

const { createApiV1Router } = await import('../src/api/v1/index.js');

const router = createApiV1Router({
  pool: db,
  verifyPasswordFn: async (plain, hash) => plain === hash,
  createSessionFn: async ({ tenantId, userId }) => {
    const t = crypto.randomBytes(16).toString('hex');
    sessions.set(t, { tenantId, userId, revoked: false });
    return { token: t, expiresAt: new Date(Date.now() + 60000) };
  },
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

// Setup test user (Company Admin with brand permissions)
const userId = 'u-ca-' + crypto.randomBytes(8).toString('hex');
users.set(userId, { id: userId, tenant_id: 't-ufc', email: 'ca@test.com', name: 'CA', password_hash: 'secret123', status: 'active' });
const roleKey = 't-ufc:Company Admin';
roles.set(roleKey, {
  id: roleKey, tenant_id: 't-ufc', name: 'Company Admin',
  permissions: ['brand.read','brand.create','brand.update','brand.disable','company.read','company.update']
});
userRoles.set(userId, [roleKey]);

console.log('\n🧪 Stage 8 Batch 1 — Live Defect Regression Tests\n');

// Boot CSRF
const boot = await call('/_health');
const csrfCookie = boot.setCookie.match(/csrf_token=[^;]*/)?.[0];
const csrf = csrfCookie?.split('=')[1];

// Login
const login = await call('/auth/login', { method: 'POST', body: { email: 'ca@test.com', password: 'secret123' }, cookie: csrfCookie, csrf });
check('Login → 200', login.status === 200, `got ${login.status}`);
const sessionCookie = login.setCookie.match(/lwc_session=[^;]*/)?.[0];
const authCookie = [sessionCookie, csrfCookie].filter(Boolean).join('; ');

// ---- Defect 1: Brands API returns default_language ----
console.log('\n--- Defect 1: Brands API with default_language ---');
{
  const res = await call('/companies/brands', { cookie: authCookie, csrf });
  check('GET /companies/brands → 200', res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
  if (res.status === 200) {
    check('Returns array', Array.isArray(res.body?.data));
    check('Brand has default_language field', res.body?.data?.every(b => 'default_language' in b) === true || res.body?.data?.length === 0);
    check('Brand has status field', res.body?.data?.every(b => 'status' in b) === true || res.body?.data?.length === 0);
  }
}

// ---- Defect 2: Migration 012 adds default_language column ----
console.log('\n--- Defect 2: Migration 012 file exists and is correct ---');
{
  const migPath = new URL('../migrations/012_add_brand_default_language.sql', import.meta.url);
  let sql = '';
  try { sql = readFileSync(migPath, 'utf8'); } catch { /* ignore */ }
  check('Migration 012 file exists', sql.length > 0);
  check('Migration 012 adds default_language column', /ALTER TABLE brands[\s\S]*ADD COLUMN[\s\S]*default_language/i.test(sql));
  check('Migration 012 uses IF NOT EXISTS', /IF NOT EXISTS/i.test(sql));
  check('Migration 012 sets default value', /DEFAULT 'ar'/i.test(sql));
}

// ---- Defect 3: i18n translation keys present ----
console.log('\n--- Defect 3: i18n translation keys ---');
for (const locale of ['en', 'ar']) {
  const msgPath = new URL(`../apps/web/messages/${locale}.json`, import.meta.url);
  let messages = {};
  try { messages = JSON.parse(readFileSync(msgPath, 'utf8')); } catch { /* ignore */ }
  const p = messages.platform || {};
  check(`[${locale}] platform.loading present`, typeof p.loading === 'string' && p.loading.length > 0);
  check(`[${locale}] platform.brands present`, typeof p.brands === 'string' && p.brands.length > 0);
  check(`[${locale}] platform.users present`, typeof p.users === 'string' && p.users.length > 0);
  check(`[${locale}] platform.status is string (not nested object)`, typeof p.status === 'string');
  check(`[${locale}] platform.created present`, typeof p.created === 'string' && p.created.length > 0);
  check(`[${locale}] platform.actions present`, typeof p.actions === 'string' && p.actions.length > 0);
  check(`[${locale}] platform.statusLabels nested object preserved`, typeof p.statusLabels === 'object' && p.statusLabels !== null);
}

// ---- Defect 4: Brand creation with default_language works ----
console.log('\n--- Defect 4: Brand creation with default_language ---');
{
  const res = await call('/companies/brands', {
    method: 'POST',
    body: { name: 'New Brand', slug: 'new-brand', defaultLanguage: 'en' },
    cookie: authCookie,
    csrf
  });
  check('POST /companies/brands → 201', res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
  if (res.status === 201) {
    check('Created brand has default_language', res.body?.data?.default_language === 'en');
    check('Created brand has status', res.body?.data?.status === 'active');
  }
}

// ---- Defect 5: Unauthorized still blocked ----
console.log('\n--- Defect 5: Unauthorized access still blocked ---');
{
  const res = await call('/companies/brands', { cookie: 'lwc_session=invalid', csrf: 'x' });
  check('Unauthenticated → 401', res.status === 401, `got ${res.status}`);
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
