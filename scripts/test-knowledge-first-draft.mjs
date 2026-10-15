/**
 * Stage 8 Batch 1 — First-Time Knowledge Base Draft Creation Tests
 *
 * Verifies the first-time onboarding fix:
 * 1. Initial draft creation for a new company (source exists, nothing published yet)
 * 2. Idempotent re-execution (second POST returns the same draft)
 * 3. Existing published-to-draft workflow still works (UFC regression)
 * 4. RBAC + CSRF enforcement (Agent → 403, missing CSRF → 403)
 * 5. Cross-tenant / cross-brand isolation
 *
 * Run: node scripts/test-knowledge-first-draft.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';

// ValidateKnowledge is imported dynamically AFTER the env stub so db/pg.js
// never sees an unset DATABASE_URL.
const { validateKnowledge } = await import('../src/services/knowledge.js');

/* --------------------------------------------------------------- mock data */

const tenants = new Map([
  ['t-ufc', { id: 't-ufc', name: 'UFC', slug: 'ufc', status: 'active' }],
  ['t-new', { id: 't-new', name: 'New Co', slug: 'new-co', status: 'active' }],
]);
const brands = new Map([
  ['b-ufc', { id: 'b-ufc', tenant_id: 't-ufc', name: 'Life with Cacao', slug: 'lwc', status: 'active' }],
  ['b-new', { id: 'b-new', tenant_id: 't-new', name: 'New Brand', slug: 'main', status: 'active' }],
]);
const users = new Map();
const roles = new Map();
const userRoles = new Map();
const sessions = new Map();

// ks-ufc: published knowledge exists. ks-new: Fix D created the source for the
// new company but NOTHING has been published yet (the onboarding scenario).
const knowledgeSources = new Map([
  ['ks-ufc', { id: 'ks-ufc', tenant_id: 't-ufc', brand_id: 'b-ufc', kind: 'menu', title: 'UFC Menu', created_at: new Date('2026-01-01') }],
  ['ks-new', { id: 'ks-new', tenant_id: 't-new', brand_id: 'b-new', kind: 'menu', title: 'New Co — main menu & info', created_at: new Date('2026-01-02') }],
]);
const knowledgeDrafts = new Map();
const knowledgeDocs = new Map();

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const parseContent = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/* ----------------------------------------------------------------- mock db */

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // --- knowledge_sources: resolve for tenant (+ optional brand) ---
    if (/select .* from knowledge_sources where tenant_id = \$1/.test(s)) {
      const tenantId = params[0];
      const brandId = params[1] || null;
      for (const [, ks] of knowledgeSources) {
        if (ks.tenant_id === tenantId && (!brandId || ks.brand_id === brandId)) return { rows: [ks] };
      }
      return { rows: [] };
    }

    // --- knowledge_documents: current published version for a source ---
    if (/from knowledge_documents/.test(s) && /status = 'published'/.test(s)) {
      const [sourceId, tenantId] = params;
      const docs = Array.from(knowledgeDocs.values())
        .filter((d) => d.source_id === sourceId && d.tenant_id === tenantId && d.status === 'published')
        .sort((a, b) => b.version - a.version);
      return { rows: docs.slice(0, 1) };
    }

    // --- knowledge_drafts: select (getDraft filters status='editing', getAnyDraft does not) ---
    if (/from knowledge_drafts where tenant_id/.test(s) && /source_id/.test(s)) {
      const [tenantId, sourceId] = params;
      const editingOnly = /= 'editing'/.test(s);
      for (const [, d] of knowledgeDrafts) {
        if (d.tenant_id === tenantId && d.source_id === sourceId && (!editingOnly || d.status === 'editing')) {
          return { rows: [d] };
        }
      }
      return { rows: [] };
    }

    // --- knowledge_drafts: insert (saveDraft fresh path) ---
    if (/insert into knowledge_drafts/.test(s)) {
      const id = 'kd-' + crypto.randomBytes(8).toString('hex');
      const content = parseContent(params[3]);
      const draft = {
        id, tenant_id: params[0], source_id: params[1], base_version: params[2],
        content, status: 'editing', created_by: params[4], updated_by: params[4], updated_at: new Date()
      };
      knowledgeDrafts.set(id, draft);
      return { rows: [{ id, base_version: params[2], content, status: 'editing', updated_at: draft.updated_at }] };
    }

    // --- knowledge_drafts: update (saveDraft reusable-row path) ---
    if (/update knowledge_drafts set content/.test(s)) {
      const content = parseContent(params[0]);
      const [tenantId, sourceId] = [params[3], params[4]];
      for (const [, d] of knowledgeDrafts) {
        if (d.tenant_id === tenantId && d.source_id === sourceId) {
          d.content = content;
          d.base_version = params[1];
          d.status = 'editing';
          d.updated_at = new Date();
          return { rows: [{ id: d.id, base_version: d.base_version, content, status: 'editing', updated_at: d.updated_at }] };
        }
      }
      return { rows: [] };
    }

    // Everything else (knowledge_publications history, BEGIN/COMMIT, ...)
    return { rows: [] };
  },
  connect: async () => ({
    query: async (sql, params = []) => db.query(sql, params),
    release: () => {}
  })
};

// Mock query additions inserted above connect? Need to add handlers before default return.
// We add brand/tenant lookups here by monkey-patching db.query wrapper.
const originalQuery = db.query.bind(db);
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/select name from brands where id/.test(s)) {
    const b = brands.get(params[0]);
    return b ? { rows: [{ name: b.name }] } : { rows: [] };
  }
  if (/select name from tenants where id/.test(s)) {
    const t = tenants.get(params[0]);
    return t ? { rows: [{ name: t.name }] } : { rows: [] };
  }
  return originalQuery(sql, params);
};

/* ------------------------------------------------------------- router wiring */

const { createApiV1Router } = await import('../src/api/v1/index.js');

const router = createApiV1Router({
  pool: db,
  verifyPasswordFn: async (plain, hash) => plain === hash,
  createSessionFn: async ({ tenantId, userId }) => {
    const t = crypto.randomBytes(16).toString('hex');
    sessions.set(t, { tenantId, userId, revoked: false });
    return { token: t, expiresAt: new Date(Date.now() + 60000) };
  },
  // Injected session validation: bypasses DB session queries entirely.
  validateSessionFn: async (token) => {
    const s = sessions.get(token);
    if (!s || s.revoked) return null;
    const u = users.get(s.userId);
    if (!u) return null;
    const roleNames = (userRoles.get(s.userId) || [])
      .map((rid) => roles.get(rid)?.name)
      .filter(Boolean);
    return {
      tenantId: s.tenantId,
      user: { id: u.id, email: u.email, name: u.name },
      roles: roleNames,
      sessionId: 'sess-' + u.id
    };
  },
  revokeSessionFn: async (token) => sessions.delete(token),
  revokeOtherSessionsFn: async () => {},
  lockedSecondsFn: async () => 0,
  recordFailedLoginFn: async () => {},
  resetLoginAttemptsFn: async () => {}
});

const app = express();
app.use('/api/v1', router);

await new Promise((r) => { app._server = app.listen(0, '127.0.0.1', r); });
const base = `http://127.0.0.1:${app._server.address().port}/api/v1`;

/* ----------------------------------------------------------- request helper */

// Double-submit CSRF: the same token must appear in the csrf_token cookie and
// the x-csrf-token header (csrfGuard compares them with timingSafeEqual).
const CSRF = 'csrf-' + crypto.randomBytes(16).toString('hex');
const withCsrf = (sessionCookie) => `${sessionCookie}; csrf_token=${CSRF}`;

const call = async (path, { method = 'GET', body, cookie, csrf } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, setCookie: r.headers.get('set-cookie') || '' };
};

/* ------------------------------------------------------------------ fixtures */

function makeUser({ id, tenantId, email, name, roleName, roleId }) {
  users.set(id, { id, tenant_id: tenantId, email, name, password_hash: 'x', status: 'active' });
  roles.set(roleId, { id: roleId, tenant_id: tenantId, name: roleName, permissions: [] });
  userRoles.set(id, [roleId]);
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { tenantId, userId: id, revoked: false });
  return token;
}

const adminToken = makeUser({
  id: 'u-admin', tenantId: 't-new', email: 'admin@newco.test', name: 'Admin',
  roleName: 'Company Admin', roleId: 'r-ca-new'
});
const agentToken = makeUser({
  id: 'u-agent', tenantId: 't-new', email: 'agent@newco.test', name: 'Agent',
  roleName: 'Agent', roleId: 'r-agent-new'
});
const ufcToken = makeUser({
  id: 'u-ufc', tenantId: 't-ufc', email: 'admin@ufc.test', name: 'UFC Admin',
  roleName: 'Company Admin', roleId: 'r-ca-ufc'
});

const adminCookie = withCsrf(`lwc_session=${adminToken}`);
const agentCookie = withCsrf(`lwc_session=${agentToken}`);
const ufcCookie = withCsrf(`lwc_session=${ufcToken}`);

console.log('\n🧪 Stage 8 Batch 1 — First-Time Knowledge Base Draft Tests\n');

/* ---- Test 1: Initial draft creation for new company ---- */
console.log('--- Test 1: Initial draft creation for new company (no published knowledge) ---');
let newDraftId = null;
{
  const ov = await call('/knowledge', { cookie: adminCookie });
  check('GET /knowledge → 200 (source exists, no content yet)', ov.status === 200, `got ${ov.status}: ${JSON.stringify(ov.body)}`);
  check('Overview: published=null, draft=null', ov.body?.data?.published === null && ov.body?.data?.draft === null);
  check('Permissions: canEdit=true for Company Admin', ov.body?.data?.permissions?.canEdit === true);

  const res = await call('/knowledge/draft', { method: 'POST', cookie: adminCookie, csrf: CSRF });
  check('POST /knowledge/draft → 200', res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
  if (res.status === 200) {
    check('Draft created=true', res.body?.data?.created === true, `created=${res.body?.data?.created}`);
    check('Draft baseVersion=0', res.body?.data?.draft?.baseVersion === 0, `baseVersion=${res.body?.data?.draft?.baseVersion}`);
    check('Draft status=editing', res.body?.data?.draft?.status === 'editing');
    const c = res.body?.data?.draft?.content;
    check('Draft content is an object', c && typeof c === 'object' && !Array.isArray(c));
    check('Draft has non-empty restaurantName', typeof c?.restaurantName === 'string' && c.restaurantName.length > 0, `restaurantName=${c?.restaurantName}`);
    check('Initial content passes validateKnowledge', validateKnowledge(c).ok === true, JSON.stringify(validateKnowledge(c).errors));
    newDraftId = res.body?.data?.draft?.id ?? null;
  }

  const ov2 = await call('/knowledge', { cookie: adminCookie });
  check('Overview now exposes the draft', Boolean(ov2.body?.data?.draft?.id), JSON.stringify(ov2.body?.data?.draft));
}

/* ---- Test 2: Idempotent re-execution ---- */
console.log('\n--- Test 2: Idempotent re-execution ---');
{
  const res = await call('/knowledge/draft', { method: 'POST', cookie: adminCookie, csrf: CSRF });
  check('Second POST /knowledge/draft → 200', res.status === 200, `got ${res.status}`);
  check('Draft created=false (idempotent)', res.body?.data?.created === false, `created=${res.body?.data?.created}`);
  check('Same draft returned', res.body?.data?.draft?.id === newDraftId, `${res.body?.data?.draft?.id} !== ${newDraftId}`);
}

/* ---- Test 3: Existing published-to-draft workflow (UFC regression) ---- */
console.log('\n--- Test 3: Existing published-to-draft workflow (UFC) ---');
{
  knowledgeDocs.set('doc-ufc', {
    id: 'doc-ufc', source_id: 'ks-ufc', tenant_id: 't-ufc', version: 3, status: 'published',
    structured: { restaurantName: 'Life with Cacao', about: 'Test', currency: 'KD', halal: 'Halal', branches: [], menus: {} },
    updated_at: new Date()
  });

  const res = await call('/knowledge/draft', { method: 'POST', cookie: ufcCookie, csrf: CSRF });
  check('POST /knowledge/draft (UFC) → 200', res.status === 200, `got ${res.status}: ${JSON.stringify(res.body)}`);
  if (res.status === 200) {
    check('Draft created from published', res.body?.data?.created === true, `created=${res.body?.data?.created}`);
    check('Draft content copied from published', res.body?.data?.draft?.content?.restaurantName === 'Life with Cacao', JSON.stringify(res.body?.data?.draft?.content));
    check('Draft baseVersion matches published version', res.body?.data?.draft?.baseVersion === 3, `baseVersion=${res.body?.data?.draft?.baseVersion}`);
    check('Draft status=editing', res.body?.data?.draft?.status === 'editing');
  }
}

/* ---- Test 4: RBAC + CSRF enforcement ---- */
console.log('\n--- Test 4: RBAC and CSRF enforcement ---');
{
  const res = await call('/knowledge/draft', { method: 'POST', cookie: agentCookie, csrf: CSRF });
  check('Agent POST /knowledge/draft → 403', res.status === 403, `got ${res.status}: ${JSON.stringify(res.body)}`);
  check('Agent rejected with FORBIDDEN', res.body?.error?.code === 'FORBIDDEN', `code=${res.body?.error?.code}`);

  // Mutation without the CSRF header must be rejected (guard still active).
  const noCsrf = await call('/knowledge/draft', { method: 'POST', cookie: adminCookie });
  check('Missing CSRF header → 403 CSRF_INVALID', noCsrf.status === 403 && noCsrf.body?.error?.code === 'CSRF_INVALID', `got ${noCsrf.status} ${noCsrf.body?.error?.code}`);
}

/* ---- Test 5: Cross-tenant / cross-brand isolation ---- */
console.log('\n--- Test 5: Cross-tenant / cross-brand isolation ---');
{
  // UFC admin must see THEIR draft (published copy), never New Co's.
  const ufcRes = await call('/knowledge/draft', { method: 'POST', cookie: ufcCookie, csrf: CSRF });
  check('UFC admin re-POST → 200 (own draft)', ufcRes.status === 200, `got ${ufcRes.status}`);
  check('UFC draft is the published copy, not New Co draft', ufcRes.body?.data?.draft?.content?.restaurantName === 'Life with Cacao', JSON.stringify(ufcRes.body?.data?.draft?.content));
  check('UFC draft id differs from New Co draft id', ufcRes.body?.data?.draft?.id !== newDraftId, `${ufcRes.body?.data?.draft?.id} === ${newDraftId}`);

  // New Co admin must NOT reach UFC's brand knowledge source.
  const cross = await call('/knowledge/draft?brandId=b-ufc', { method: 'POST', cookie: adminCookie, csrf: CSRF });
  check('New Co admin + UFC brand → 404 KNOWLEDGE_SOURCE_NOT_FOUND', cross.status === 404 && cross.body?.error?.code === 'KNOWLEDGE_SOURCE_NOT_FOUND', `got ${cross.status} ${cross.body?.error?.code}`);

  // The cross-tenant attempt must not have created anything.
  const draftsForUfcBrand = Array.from(knowledgeDrafts.values()).filter((d) => d.source_id === 'ks-ufc');
  check('No draft leaked/created for UFC source by New Co', draftsForUfcBrand.length === 1, `count=${draftsForUfcBrand.length}`);
}

app._server.close();
console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
