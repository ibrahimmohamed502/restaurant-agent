/**
 * Stage 8 Batch 2 — Integrations API tests (read-only listing & status).
 *
 * Covers: provider-neutral shape, tenant isolation, brand isolation,
 * RBAC enforcement, unauthenticated/CSRF behaviour and — critically —
 * that NO credential value can ever reach a response.
 *
 * Run: node scripts/test-integrations-api.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import express from 'express';
import crypto from 'node:crypto';

// ids are uuids in production (gen_random_uuid) — the API validates that shape.
const ID = {
  bA1: 'a0000000-0000-4000-8000-000000000001',
  bA2: 'a0000000-0000-4000-8000-000000000002',
  bB1: 'b0000000-0000-4000-8000-000000000001',
  chAMeta: 'c0000000-0000-4000-8000-000000000001',
  chADM: 'c0000000-0000-4000-8000-000000000002',
  chADisabled: 'c0000000-0000-4000-8000-000000000003',
  chBMeta: 'd0000000-0000-4000-8000-000000000001'
};

const tenants = new Map([
  ['t-a', { id: 't-a', name: 'Company A', slug: 'company-a' }],
  ['t-b', { id: 't-b', name: 'Company B', slug: 'company-b' }]
]);
const brands = new Map([
  [ID.bA1, { id: ID.bA1, tenant_id: 't-a', name: 'Brand One', slug: 'one' }],
  [ID.bA2, { id: ID.bA2, tenant_id: 't-a', name: 'Brand Two', slug: 'two' }],
  [ID.bB1, { id: ID.bB1, tenant_id: 't-b', name: 'Other Brand', slug: 'other' }]
]);
const users = new Map();
const roles = new Map();
const userRoles = new Map();
const sessions = new Map();

const SECRET_TOKEN_MATERIAL = 'EAAB_super-secret-page-token-DO-NOT-LEAK';
const channels = new Map([
  [ID.chAMeta, { id: ID.chAMeta, tenant_id: 't-a', brand_id: ID.bA1, provider: 'meta', external_id: 'PAGE_A', display_name: 'Company A Page', status: 'active', created_at: new Date('2026-01-01') }],
  [ID.chADM, { id: ID.chADM, tenant_id: 't-a', brand_id: ID.bA2, provider: 'meta_dm', external_id: 'PAGE_A', display_name: 'Messenger DMs', status: 'active', created_at: new Date('2026-01-02') }],
  [ID.chADisabled, { id: ID.chADisabled, tenant_id: 't-a', brand_id: null, provider: 'meta_comment', external_id: 'PAGE_A2', display_name: 'Old Page', status: 'disabled', created_at: new Date('2026-01-03') }],
  [ID.chBMeta, { id: ID.chBMeta, tenant_id: 't-b', brand_id: ID.bB1, provider: 'meta', external_id: 'PAGE_B', display_name: 'Company B Page', status: 'active', created_at: new Date('2026-01-04') }]
]);
const credentials = new Map([
  [ID.chAMeta, { value_encrypted: Buffer.from(SECRET_TOKEN_MATERIAL).toString('hex'), iv: 'aabb', expires_at: new Date('2027-01-01') }],
  [ID.chBMeta, { value_encrypted: Buffer.from('other-company-secret').toString('hex'), iv: 'ccdd', expires_at: null }]
]);
// A raw provider error is deliberately hostile: token-looking string + customer id.
const RAW_PROVIDER_ERROR = 'Graph API 400 {"error":{"message":"Invalid OAuth token EAAABsecret for user 987654@fb"}}';
const health = new Map([
  [ID.chAMeta, { status: 'ok', last_event_at: new Date('2026-10-01'), last_error: null }],
  [ID.chADM, { status: 'weird_status', last_event_at: null, last_error: RAW_PROVIDER_ERROR }],
  [ID.chBMeta, { status: 'degraded', last_event_at: null, last_error: 'meta_rate_limit' }]
]);

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // brand ownership check (integrations.js)
    if (/from brands where id = \$1 and tenant_id = \$2/.test(s)) {
      const b = brands.get(params[0]);
      return { rows: b && b.tenant_id === params[1] ? [b] : [] };
    }

    // integrations listing (tenant + optional brand narrowing + optional brand scope)
    if (/from channels c/.test(s) && /c\.tenant_id = \$1/.test(s) && /\$2::uuid is null or c\.brand_id = \$2/.test(s)) {
      const [tenantId, brandId, scopeIds] = params;
      const rows = [...channels.values()]
        .filter((c) => c.tenant_id === tenantId && (!brandId || c.brand_id === brandId))
        .filter((c) => !scopeIds || (c.brand_id && scopeIds.includes(c.brand_id)))
        .map((c) => decorate(c));
      return { rows };
    }

    // single channel status (tenant-scoped)
    if (/from channels c/.test(s) && /c\.id = \$1 and c\.tenant_id = \$2/.test(s)) {
      const c = channels.get(params[0]);
      return { rows: c && c.tenant_id === params[1] ? [decorate(c)] : [] };
    }

    return { rows: [] };
  }
};

function decorate(c) {
  const cred = credentials.get(c.id) ?? null;
  const h = health.get(c.id) ?? null;
  const brand = c.brand_id ? brands.get(c.brand_id) : null;
  return {
    id: c.id,
    provider: c.provider,
    external_id: c.external_id,
    display_name: c.display_name,
    status: c.status,
    brand_id: c.brand_id,
    created_at: c.created_at,
    brand_name: brand?.name ?? null,
    credential_present: Boolean(cred),
    credential_expires_at: cred?.expires_at ?? null,
    health_status: h?.status ?? null,
    last_event_at: h?.last_event_at ?? null,
    last_error: h?.last_error ?? null
  };
}

const { createApiV1Router } = await import('../src/api/v1/index.js');

const router = createApiV1Router({
  pool: db,
  verifyPasswordFn: async () => false,
  createSessionFn: async () => ({ token: 'unused', expiresAt: new Date(Date.now() + 1000) }),
  validateSessionFn: async (token) => {
    const s = sessions.get(token);
    if (!s || s.revoked) return null;
    const u = users.get(s.userId);
    if (!u) return null;
    const names = (userRoles.get(s.userId) || []).map((rid) => roles.get(rid)?.name).filter(Boolean);
    return {
      tenantId: s.tenantId,
      user: { id: u.id, email: u.email, name: u.name },
      roles: names,
      sessionId: 'sess-' + u.id,
      // optional brand restriction carried by the session (null = tenant-wide)
      brandIds: s.brandIds ?? null
    };
  },
  revokeSessionFn: async () => {},
  revokeOtherSessionsFn: async () => {},
  lockedSecondsFn: async () => 0,
  recordFailedLoginFn: async () => {},
  resetLoginAttemptsFn: async () => {}
});

const app = express();
app.use('/api/v1', router);
await new Promise((r) => { app._server = app.listen(0, '127.0.0.1', r); });
const base = `http://127.0.0.1:${app._server.address().port}/api/v1`;

const CSRF = 'csrf-' + crypto.randomBytes(12).toString('hex');
const call = async (path, { method = 'GET', cookie, csrf } = {}) => {
  const headers = {};
  if (cookie) headers.Cookie = `${cookie}; csrf_token=${CSRF}`;
  if (csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(base + path, { method, headers });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, text: JSON.stringify(body) };
};

function makeUser({ id, tenantId, roleName, roleId, brandIds = null }) {
  users.set(id, { id, tenant_id: tenantId, email: `${id}@test`, name: id });
  if (roleName) {
    roles.set(roleId, { id: roleId, tenant_id: tenantId, name: roleName, permissions: [] });
    userRoles.set(id, [roleId]);
  } else {
    userRoles.set(id, []);
  }
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { tenantId, userId: id, revoked: false, brandIds });
  return token;
}

const adminA = makeUser({ id: 'admin-a', tenantId: 't-a', roleName: 'Company Admin', roleId: 'r-ca-a' });
const supervisorA = makeUser({ id: 'sup-a', tenantId: 't-a', roleName: 'Supervisor', roleId: 'r-sup-a' });
const agentA = makeUser({ id: 'agent-a', tenantId: 't-a', roleName: 'Agent', roleId: 'r-agent-a' });
const noRole = makeUser({ id: 'norole-a', tenantId: 't-a' });
const adminB = makeUser({ id: 'admin-b', tenantId: 't-b', roleName: 'Company Admin', roleId: 'r-ca-b' });
// Restricted to Brand One only (b-a1) - drives brand-level authorization tests.
const scopedA = makeUser({ id: 'scoped-a', tenantId: 't-a', roleName: 'Supervisor', roleId: 'r-sup-b', brandIds: [ID.bA1] });
// Fail-closed scope shapes (empty, all-invalid, malformed non-array, mixed).
const zeroScopeA = makeUser({ id: 'zero-a', tenantId: 't-a', roleName: 'Supervisor', roleId: 'r-sup-c', brandIds: [] });
const invalidScopeA = makeUser({ id: 'invalid-a', tenantId: 't-a', roleName: 'Supervisor', roleId: 'r-sup-d', brandIds: ['not-a-uuid', 42, null] });
const malformedScopeA = makeUser({ id: 'malformed-a', tenantId: 't-a', roleName: 'Supervisor', roleId: 'r-sup-e', brandIds: 'brand-one' });
const mixedScopeA = makeUser({ id: 'mixed-a', tenantId: 't-a', roleName: 'Supervisor', roleId: 'r-sup-f', brandIds: [ID.bA1, 'garbage', ID.bA2] });

console.log('\nStage 8 Batch 2 -- Integrations API (read-only)\n');

/* ---------- 1. listing ---------- */
console.log('--- Listing ---');
{
  const res = await call('/integrations', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('GET /integrations -> 200', res.status === 200, `got ${res.status}: ${res.text}`);
  const data = res.body?.data;
  const ids = (data?.integrations ?? []).map((i) => i.id).sort();
  check('Only own-tenant channels are returned', JSON.stringify(ids) === JSON.stringify([ID.chADM, ID.chAMeta, ID.chADisabled].sort()), JSON.stringify(ids));
  const metaRow = data?.integrations?.find((i) => i.id === ID.chAMeta);
  check('Provider label resolved from the registry', metaRow?.providerLabel === 'Meta (Facebook & Messenger)', metaRow?.providerLabel);
  check('Channel provider value preserved', metaRow?.provider === 'meta');
  check('Brand is resolved', metaRow?.brand?.id === ID.bA1 && metaRow?.brand?.name === 'Brand One');
  check('Credential presence exposed as boolean only', metaRow?.credentials?.present === true);
  check('Credential expiry exposed as metadata', typeof metaRow?.credentials?.expiresAt === 'string');
  check('Health status surfaced', metaRow?.health?.status === 'ok');
  check('Channel without credentials reports present=false', data?.integrations?.find((i) => i.id === ID.chADisabled)?.credentials?.present === false);
  check('Channel without health row defaults to unknown', data?.integrations?.find((i) => i.id === ID.chADisabled)?.health?.status === 'unknown');
  check('Provider catalog returned (provider-neutral)', Array.isArray(data?.providers) && data.providers.some((p) => p.key === 'meta'));
  check('Disabled channels are visible with their status', data?.integrations?.find((i) => i.id === ID.chADisabled)?.status === 'disabled');
}

/* ---------- 2. credential leakage ---------- */
console.log('\n--- Credential leakage ---');
{
  const res = await call('/integrations', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('No credential value in the list response', !res.text.includes(SECRET_TOKEN_MATERIAL));
  check('No encrypted blob in the list response', !res.text.includes(Buffer.from(SECRET_TOKEN_MATERIAL).toString('hex')));
  check('No iv leaked', !/"iv"/i.test(res.text));
  check('No token-ish field names in the payload', !/"(value_encrypted|access_token|page_access_token|secret)"\s*:/i.test(res.text));

  const status = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('GET /integrations/:id/status -> 200', status.status === 200, `got ${status.status}: ${status.text}`);
  check('Status endpoint exposes no credential value', !status.text.includes(SECRET_TOKEN_MATERIAL));
  check('Status endpoint reports presence', status.body?.data?.integration?.credentials?.present === true);
  check('Status endpoint carries provider label', status.body?.data?.integration?.providerLabel === 'Meta (Facebook & Messenger)');
  check('Status endpoint reports health', status.body?.data?.integration?.health?.status === 'ok');
  const degraded = await call(`/integrations/${ID.chBMeta}/status`, { cookie: `lwc_session=${adminB}`, csrf: CSRF });
  check('Approved diagnostic code is surfaced verbatim', degraded.body?.data?.integration?.health?.lastError === 'META_RATE_LIMIT', String(degraded.body?.data?.integration?.health?.lastError));
}

/* ---------- 3. tenant isolation ---------- */
console.log('\n--- Tenant isolation ---');
{
  const b = await call('/integrations', { cookie: `lwc_session=${adminB}`, csrf: CSRF });
  const ids = (b.body?.data?.integrations ?? []).map((i) => i.id);
  check('Company B sees only its own channel', JSON.stringify(ids) === JSON.stringify([ID.chBMeta]), JSON.stringify(ids));
  check('Company B never sees Company A channels', !b.text.includes(ID.chAMeta) && !b.text.includes('PAGE_A'));

  const cross = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${adminB}`, csrf: CSRF });
  check('Cross-tenant channel status -> 404', cross.status === 404, `got ${cross.status}`);
  check('Cross-tenant 404 uses CHANNEL_NOT_FOUND (no existence leak)', cross.body?.error?.code === 'CHANNEL_NOT_FOUND', cross.body?.error?.code);

  // a browser-supplied tenant parameter must have no effect
  const spoof = await call('/integrations?tenantId=t-b', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  const spoofIds = (spoof.body?.data?.integrations ?? []).map((i) => i.id).sort();
  check('Browser-supplied tenantId is ignored', JSON.stringify(spoofIds) === JSON.stringify([ID.chADM, ID.chAMeta, ID.chADisabled].sort()), JSON.stringify(spoofIds));
}

/* ---------- 4. brand isolation ---------- */
console.log('\n--- Brand isolation ---');
{
  const own = await call(`/integrations?brandId=${ID.bA1}`, { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Brand filter returns that brand only', (own.body?.data?.integrations ?? []).map((i) => i.id).join() === ID.chAMeta);

  const cross = await call(`/integrations?brandId=${ID.bB1}`, { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Cross-tenant brandId -> 404 BRAND_NOT_FOUND', cross.status === 404 && cross.body?.error?.code === 'BRAND_NOT_FOUND', `got ${cross.status} ${cross.body?.error?.code}`);
  check('Cross-tenant brandId leaks no data', !cross.text.includes('PAGE_B'));

  const bad = await call('/integrations?brandId=not-a-uuid', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Malformed brandId -> 400 VALIDATION_ERROR', bad.status === 400 && bad.body?.error?.code === 'VALIDATION_ERROR', `got ${bad.status}`);

  const badId = await call('/integrations/not-a-uuid/status', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Malformed channel id -> 400 VALIDATION_ERROR', badId.status === 400 && badId.body?.error?.code === 'VALIDATION_ERROR', `got ${badId.status}`);
}

/* ---------- 5. RBAC ---------- */
console.log('\n--- RBAC ---');
{
  const sup = await call('/integrations', { cookie: `lwc_session=${supervisorA}`, csrf: CSRF });
  check('Supervisor may read integrations', sup.status === 200, `got ${sup.status}`);
  const agent = await call('/integrations', { cookie: `lwc_session=${agentA}`, csrf: CSRF });
  check('Agent may read integrations (status ability)', agent.status === 200, `got ${agent.status}`);
  const none = await call('/integrations', { cookie: `lwc_session=${noRole}`, csrf: CSRF });
  check('User without the ability -> 403', none.status === 403 && none.body?.error?.code === 'FORBIDDEN', `got ${none.status} ${none.body?.error?.code}`);
  const noneStatus = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${noRole}`, csrf: CSRF });
  check('Status endpoint is equally protected', noneStatus.status === 403, `got ${noneStatus.status}`);
}

/* ---------- 6. health diagnostics are codes, never raw text ---------- */
console.log('\n--- Health diagnostics (safe codes only) ---');
{
  const res = await call('/integrations', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  const raw = res.body?.data?.integrations?.find((i) => i.id === ID.chADM);
  check('Raw provider error text never reaches the response', !res.text.includes('Invalid OAuth token'), res.text.slice(0, 200));
  check('Token-like substring never reaches the response', !res.text.includes('EAAABsecret'));
  check('Customer id from the provider error never reaches the response', !res.text.includes('987654@fb'));
  check('Unrecognized error collapses to a constant code', raw?.health?.lastError === 'UNRECOGNIZED_ERROR', String(raw?.health?.lastError));
  check('Unrecognized health status collapses to unknown', raw?.health?.status === 'unknown', String(raw?.health?.status));
  check('Clean channel reports null error', res.body?.data?.integrations?.find((i) => i.id === ID.chAMeta)?.health?.lastError === null);
  check('Known health status is preserved', res.body?.data?.integrations?.find((i) => i.id === ID.chAMeta)?.health?.status === 'ok');

  // direct unit check of the allow-list helper
  const { safeHealthErrorCode, safeHealthStatus, UNRECOGNIZED_ERROR } = await import('../src/services/healthCodes.js');
  check('Helper: approved code passes through', safeHealthErrorCode('credential_missing') === 'CREDENTIAL_MISSING');
  check('Helper: resolver code passes through', safeHealthErrorCode('UNKNOWN_META_PAGE') === 'UNKNOWN_META_PAGE');
  check('Helper: arbitrary text is dropped', safeHealthErrorCode('my page token is abc123 for user 5') === UNRECOGNIZED_ERROR);
  check('Helper: null stays null', safeHealthErrorCode(null) === null);
  check('Helper: long text never echoes', String(safeHealthErrorCode('x'.repeat(500))).length < 40);
  check('Helper: status allow-list', safeHealthStatus('degraded') === 'degraded' && safeHealthStatus('bogus') === 'unknown' && safeHealthStatus(null) === 'unknown');
}

/* ---------- 7. brand-level authorization ---------- */
console.log('\n--- Brand-level authorization (caller restricted to one brand) ---');
{
  // unfiltered listing must be narrowed to the caller's brands
  const list = await call('/integrations', { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  const ids = (list.body?.data?.integrations ?? []).map((i) => i.id);
  check('Unfiltered listing returns only the allowed brand', JSON.stringify(ids) === JSON.stringify([ID.chAMeta]), JSON.stringify(ids));
  check('Channel of a brand outside the scope is hidden', !ids.includes(ID.chADM));
  check('Company-wide channel is hidden from a brand-restricted caller', !ids.includes(ID.chADisabled));
  check('Response reports a restricted scope', list.body?.data?.scope?.mode === 'restricted' && list.body?.data?.scope?.brandCount === 1);

  // tenant-wide caller still sees everything (regression)
  const wide = await call('/integrations', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Tenant-wide caller is unaffected by the restriction', (wide.body?.data?.integrations ?? []).length === 3);
  check('Tenant-wide caller sees a tenant scope', wide.body?.data?.scope?.mode === 'tenant');

  // filter inside the scope is allowed
  const inside = await call(`/integrations?brandId=${ID.bA1}`, { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  check('Filtering by an allowed brand works', inside.status === 200 && (inside.body?.data?.integrations ?? []).map((i) => i.id).join() === ID.chAMeta, `got ${inside.status}`);

  // filter outside the scope is refused, without revealing existence
  const outside = await call(`/integrations?brandId=${ID.bA2}`, { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  check('Filtering by a brand outside the scope → 404 BRAND_NOT_FOUND', outside.status === 404 && outside.body?.error?.code === 'BRAND_NOT_FOUND', `got ${outside.status} ${outside.body?.error?.code}`);
  check('Out-of-scope filter leaks nothing', !outside.text.includes('Messenger DMs'));

  // direct status access is brand-authorized too
  const ok = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  check('Status for an allowed brand → 200', ok.status === 200, `got ${ok.status}`);
  const denied = await call(`/integrations/${ID.chADM}/status`, { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  check('Status for an out-of-scope brand → 404 (no existence leak)', denied.status === 404 && denied.body?.error?.code === 'CHANNEL_NOT_FOUND', `got ${denied.status} ${denied.body?.error?.code}`);
  check('Denied status response contains no channel data', !denied.text.includes('Messenger DMs') && !denied.text.includes('PAGE_A'));
  const companyWide = await call(`/integrations/${ID.chADisabled}/status`, { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  check('Status for a company-wide channel is denied for a restricted caller', companyWide.status === 404, `got ${companyWide.status}`);
  const stillOk = await call(`/integrations/${ID.chADisabled}/status`, { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Company-wide channel remains visible to tenant-wide callers', stillOk.status === 200, `got ${stillOk.status}`);

  // scope comes from the session, never from the browser
  const spoof = await call('/integrations?brandId=&tenantId=t-b', { cookie: `lwc_session=${scopedA}`, csrf: CSRF });
  check('Restricted scope cannot be widened by query params', (spoof.body?.data?.integrations ?? []).map((i) => i.id).join() === ID.chAMeta);
}

/* ---------- 8. brand scope shapes: fail closed ---------- */
console.log('\n--- Brand scope shapes (fail-closed semantics) ---');
{
  const { brandScopeFromSession, BRAND_SCOPE_TENANT, BRAND_SCOPE_RESTRICTED } = await import('../src/api/v1/brandAccess.js');
  const U = 'a0000000-0000-4000-8000-000000000001';

  // unit: scope resolution
  check('undefined scope -> tenant-wide', brandScopeFromSession({ brandIds: undefined }).mode === BRAND_SCOPE_TENANT);
  check('null scope -> tenant-wide', brandScopeFromSession({ brandIds: null }).mode === BRAND_SCOPE_TENANT);
  check('missing v1 -> tenant-wide', brandScopeFromSession({}).mode === BRAND_SCOPE_TENANT);
  check('[] -> restricted, zero brands', (() => { const s = brandScopeFromSession({ brandIds: [] }); return s.mode === BRAND_SCOPE_RESTRICTED && s.brandIds.length === 0; })());
  check('[valid] -> restricted to that brand', (() => { const s = brandScopeFromSession({ brandIds: [U] }); return s.mode === BRAND_SCOPE_RESTRICTED && s.brandIds.join() === U; })());
  check('all-invalid array -> restricted, zero brands', (() => { const s = brandScopeFromSession({ brandIds: ['x', 1, {}] }); return s.mode === BRAND_SCOPE_RESTRICTED && s.brandIds.length === 0; })());
  check('mixed array -> only validated ids', (() => { const s = brandScopeFromSession({ brandIds: [U, 'x', null, U] }); return s.brandIds.length === 1 && s.brandIds[0] === U; })());
  check('string scope -> fail closed, never tenant-wide', (() => { const s = brandScopeFromSession({ brandIds: 'abc' }); return s.mode === BRAND_SCOPE_RESTRICTED && s.brandIds.length === 0; })());
  check('object scope -> fail closed', (() => { const s = brandScopeFromSession({ brandIds: { 0: U, length: 1 } }); return s.mode === BRAND_SCOPE_RESTRICTED && s.brandIds.length === 0; })());
  check('number scope -> fail closed', brandScopeFromSession({ brandIds: 7 }).mode === BRAND_SCOPE_RESTRICTED);

  // endpoint: [] -> zero-brand access
  const empty = await call('/integrations', { cookie: `lwc_session=${zeroScopeA}`, csrf: CSRF });
  check('[] scope: listing returns nothing', empty.status === 200 && (empty.body?.data?.integrations ?? []).length === 0, `got ${empty.status} ${(empty.body?.data?.integrations ?? []).length}`);
  check('[] scope: reported as restricted with brandCount 0', empty.body?.data?.scope?.mode === 'restricted' && empty.body?.data?.scope?.brandCount === 0);
  const emptyFilter = await call(`/integrations?brandId=${ID.bA1}`, { cookie: `lwc_session=${zeroScopeA}`, csrf: CSRF });
  check('[] scope: brandId filter -> 404 BRAND_NOT_FOUND', emptyFilter.status === 404 && emptyFilter.body?.error?.code === 'BRAND_NOT_FOUND', `got ${emptyFilter.status}`);
  const emptyStatus = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${zeroScopeA}`, csrf: CSRF });
  check('[] scope: channel status -> 404', emptyStatus.status === 404 && emptyStatus.body?.error?.code === 'CHANNEL_NOT_FOUND', `got ${emptyStatus.status}`);
  const emptyCompany = await call(`/integrations/${ID.chADisabled}/status`, { cookie: `lwc_session=${zeroScopeA}`, csrf: CSRF });
  check('[] scope: company-wide channel status -> 404', emptyCompany.status === 404, `got ${emptyCompany.status}`);

  // endpoint: all-invalid array -> zero-brand access
  const inv = await call('/integrations', { cookie: `lwc_session=${invalidScopeA}`, csrf: CSRF });
  check('all-invalid scope: listing returns nothing', (inv.body?.data?.integrations ?? []).length === 0);
  const invStatus = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${invalidScopeA}`, csrf: CSRF });
  check('all-invalid scope: channel status -> 404', invStatus.status === 404, `got ${invStatus.status}`);

  // endpoint: malformed non-array -> fail closed
  const mal = await call('/integrations', { cookie: `lwc_session=${malformedScopeA}`, csrf: CSRF });
  check('malformed scope: listing returns nothing (never tenant-wide)', (mal.body?.data?.integrations ?? []).length === 0);
  const malStatus = await call(`/integrations/${ID.chAMeta}/status`, { cookie: `lwc_session=${malformedScopeA}`, csrf: CSRF });
  check('malformed scope: channel status -> 404', malStatus.status === 404, `got ${malStatus.status}`);
  const malCompany = await call(`/integrations/${ID.chADisabled}/status`, { cookie: `lwc_session=${malformedScopeA}`, csrf: CSRF });
  check('malformed scope: company-wide channel status -> 404', malCompany.status === 404, `got ${malCompany.status}`);

  // endpoint: mixed array -> only the valid brand(s)
  const mixed = await call('/integrations', { cookie: `lwc_session=${mixedScopeA}`, csrf: CSRF });
  check('mixed scope: only valid brands are listed', (mixed.body?.data?.integrations ?? []).map((i) => i.id).sort().join() === [ID.chADM, ID.chAMeta].sort().join(), JSON.stringify((mixed.body?.data?.integrations ?? []).map((i) => i.id)));
  const mixedCompany = await call(`/integrations/${ID.chADisabled}/status`, { cookie: `lwc_session=${mixedScopeA}`, csrf: CSRF });
  check('mixed scope: company-wide channel still hidden', mixedCompany.status === 404, `got ${mixedCompany.status}`);

  // tenant-wide caller unaffected
  const wide = await call('/integrations', { cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('Tenant-wide caller unaffected by fail-closed shapes', (wide.body?.data?.integrations ?? []).length === 3 && wide.body?.data?.scope?.mode === 'tenant');
}

/* ---------- 9. auth + CSRF + read-only surface ---------- */
console.log('\n--- Authentication, CSRF and read-only surface ---');
{
  const anon = await call('/integrations');
  check('Unauthenticated -> 401', anon.status === 401 && anon.body?.error?.code === 'UNAUTHENTICATED', `got ${anon.status}`);

  const noCsrf = await call('/integrations', { cookie: `lwc_session=${adminA}` });
  check('CSRF guard still active (GET without header is fine)', noCsrf.status === 200, `got ${noCsrf.status}`);

  // Mutations are explicitly out of scope for this batch: assert none exist.
  const post = await call('/integrations', { method: 'POST', cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('No create mutation exposed (read-only batch)', post.status === 404 || post.status === 405, `got ${post.status}`);
  const del = await call(`/integrations/${ID.chAMeta}`, { method: 'DELETE', cookie: `lwc_session=${adminA}`, csrf: CSRF });
  check('No delete mutation exposed', del.status === 404 || del.status === 405, `got ${del.status}`);
}

app._server.close();
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);