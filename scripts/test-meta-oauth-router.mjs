/**
 * Stage 8 Batch 3 — router-level security regressions for the three findings:
 *   1. Reconnect rotates ONE credential row and collapses duplicates.
 *   2. connect() consumes the flow atomically WITH the token hash — a valid
 *      flowId without the matching token connects nothing.
 *   3. The brand chosen at authorization is bound to the connection.
 *
 * Mock DB + mocked Meta network. No production data, no real network calls.
 * Run: node scripts/test-meta-oauth-router.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PUBLIC_BASE_URL = 'https://app.example.com';
process.env.FB_APP_ID = '1234567890';
process.env.FB_APP_SECRET = 'fb-secret';
process.env.OAUTH_STATE_SECRET = 'oauth-state-secret-0123456789abcdef';
process.env.NODE_ENV = 'production';

import express from 'express';
import crypto from 'node:crypto';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

/* ------------------------------------------------------------ mock state */
const B1 = '11111111-1111-4111-8111-111111111111';   // brand one
const B2 = '22222222-2222-4222-8222-222222222222';   // brand two (same tenant)
const BX = '99999999-9999-4999-8999-999999999999';   // brand owned by ANOTHER tenant
const chanUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const DB = {
  brands: new Map([
    [B1, { id: B1, tenant_id: 't-1', name: 'Brand One' }],
    [B2, { id: B2, tenant_id: 't-1', name: 'Brand Two' }],
    [BX, { id: BX, tenant_id: 't-other', name: 'Foreign Brand' }]
  ]),
  flows: [],
  pages: [],
  channels: [],
  credentials: [],
  seq: { flow: 0, page: 0, chan: 0, cred: 0, state: 0 }
};
const reset = () => {
  DB.flows = []; DB.pages = []; DB.channels = []; DB.credentials = [];
};

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (/from brands where id = \$1 and tenant_id = \$2/.test(s)) {
      const b = DB.brands.get(params[0]);
      return { rows: b && b.tenant_id === params[1] ? [b] : [] };
    }
    if (/update oauth_connect_flows\s+set consumed_at = now\(\), last_used_at = now\(\)/.test(s)) {
      const [flowId, tenantId, userId, tokenHash] = params;
      const f = DB.flows.find((r) => r.id === flowId);
      if (!f) return { rows: [] };
      // EVERYTHING is validated in one statement — hash included.
      if (f.tenant_id !== tenantId || f.user_id !== userId || f.token_hash !== tokenHash) return { rows: [] };
      if (f.consumed_at || f.expires <= Date.now()) return { rows: [] };
      f.consumed_at = Date.now();
      return { rows: [f] };
    }
    if (/update oauth_connect_flows\s+set last_used_at = now\(\)/.test(s)) {
      const [flowId, tenantId, userId, tokenHash] = params;
      const f = DB.flows.find((r) => r.id === flowId);
      if (!f || f.tenant_id !== tenantId || f.user_id !== userId || f.token_hash !== tokenHash) return { rows: [] };
      if (f.consumed_at || f.expires <= Date.now()) return { rows: [] };
      return { rows: [f] };
    }
    if (/from oauth_connect_pages where flow_id = \$1 and page_id = \$2/.test(s)) {
      const p = DB.pages.find((r) => r.flow_id === params[0] && r.page_id === params[1]);
      return { rows: p ? [{ token_encrypted: p.token_encrypted, iv: p.iv }] : [] };
    }
    if (/select channel_id, channel_id/.test(s)) { /* unreachable */ }
    if (/update channels set subscription_state = \$2/.test(s)) {
      const [id, state, errCode] = params;
      const c = DB.channels.find((x) => x.id === id);
      if (c) { c.subscription_state = state; c.subscription_error = errCode; }
      return { rows: [] };
    }
    if (/select value_encrypted, iv from provider_credentials/.test(s)) {
      const rows = DB.credentials
        .filter((c) => c.channel_id === params[0] && c.tenant_id === params[1] && c.kind === 'page_access_token')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, 1);
      return { rows };
    }
    // STATUS_SQL projection for a single channel (resubscribe / reverify)
    if (/from channels c[\s\S]*where c\.id = \$1 and c\.tenant_id = \$2/.test(s)) {
      const c = DB.channels.find((x) => x.id === params[0] && x.tenant_id === params[1]);
      if (!c) return { rows: [] };
      const creds = DB.credentials.filter((x) => x.channel_id === c.id);
      return {
        rows: [{
          ...c,
          brand_name: DB.brands.get(c.brand_id)?.name ?? null,
          credential_present: creds.length > 0,
          credential_expires_at: null,
          health_status: null, last_event_at: null, last_error: null,
          subscription_state: c.subscription_state ?? null,
          subscription_error: c.subscription_error ?? null,
          verified_at: null
        }]
      };
    }
    return { rows: [] };
  },
  connect: async () => {
    const st = { mode: 'tx', rolledBack: false };
    return {
      query: async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

        if (s === 'begin') { st.pending = []; return { rows: [], rowCount: 0 }; }
        if (s === 'commit') return { rows: [], rowCount: 0 };
        if (s === 'rollback') {
          st.rolledBack = true;
          for (const op of st.pending ?? []) op();
          return { rows: [], rowCount: 0 };
        }

        if (/select id, tenant_id, brand_id from channels where provider = 'meta'/.test(s)) {
          return { rows: DB.channels.filter((c) => c.external_id === params[0]) };
        }
        if (/update channels set status = 'active', subscription_state = 'pending_subscription'/.test(s)) {
          const c = DB.channels.find((x) => x.id === params[0]);
          if (c && (st.pending ??= []).length === 0) { /* snapshot for rollback */ }
          if (c) { c.status = 'active'; c.brand_id = params[1]; c.subscription_state = 'pending_subscription'; }
          return { rows: [], rowCount: c ? 1 : 0 };
        }
        if (/insert into channels/.test(s)) {
          const row = { id: chanUuid(++DB.seq.chan), tenant_id: params[0], brand_id: params[1], provider: 'meta', external_id: params[2], display_name: params[3], status: 'active', subscription_state: 'pending_subscription' };
          DB.channels.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (/update provider_credentials\s+set value_encrypted = \$3, iv = \$4, expires_at = null, last_rotated_at = now\(\)/.test(s)) {
          const [channelId, tenantId, encVal] = params;
          const cands = DB.credentials.filter((c) => c.channel_id === channelId && c.tenant_id === tenantId && c.kind === 'page_access_token')
            .sort((a, b) => b.seq - a.seq);
          const newest = cands[0];
          if (!newest) return { rows: [], rowCount: 0 };
          newest.value_encrypted = encVal;
          newest.iv = params[3];
          newest.expires_at = null;
          return { rows: [{ id: newest.id }], rowCount: 1 };
        }
        if (/delete from provider_credentials/.test(s)) {
          const before = DB.credentials.length;
          const keep = params[2];
          DB.credentials = DB.credentials.filter((c) => !(c.channel_id === params[0] && c.tenant_id === params[1] && c.kind === 'page_access_token' && c.id !== keep));
          return { rows: [], rowCount: before - DB.credentials.length };
        }
        if (/insert into provider_credentials/.test(s)) {
          const row = { id: `cr-${++DB.seq.cred}`, seq: DB.seq.cred, tenant_id: params[0], channel_id: params[1], kind: 'page_access_token', value_encrypted: params[2], iv: params[3], expires_at: null };
          DB.credentials.push(row);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {}
    };
  }
};

/* ------------------------------------------------------------- meta network */
let subscribeResult = { ok: true };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/oauth/access_token')) {
    return { ok: true, json: async () => ({ access_token: 'EAA-user-token', expires_in: 5183944 }) };
  }
  if (u.includes('/me/accounts')) {
    return { ok: true, json: async () => ({ data: [{ id: 'PAGE-1', name: 'Page One', access_token: 'EAA-page-token', tasks: ['MANAGE'] }] }) };
  }
  if (u.includes('subscribed_apps')) {
    if (subscribeResult.ok) return { ok: true, json: async () => ({ success: true }) };
    return { ok: false, status: 500, json: async () => ({ error: { message: 'Graph API 403 permission denied token EAA-secret', code: 200 } }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
};

const { createIntegrationsMetaRouter } = await import('../src/api/v1/integrationsMeta.js');
const { createIntegrationsRouter } = await import('../src/api/v1/integrations.js');

const users = new Map([['u-1', { id: 'u-1', tenant_id: 't-1' }], ['u-2', { id: 'u-2', tenant_id: 't-1' }], ['u-3', { id: 'u-3', tenant_id: 't-1' }]]);
const sessions = new Map();
const session = (userId, tenantId, roles, brandIds = null) => {
  const t = crypto.randomBytes(12).toString('hex');
  sessions.set(t, { userId, tenantId, roles, brandIds });
  return t;
};

const app = express();
app.use(express.json());
const authMiddleware = (req, _res, next) => {
  const raw = req.headers.cookie ?? '';
  const m = /lwc_session=([^;]+)/.exec(raw);
  const s = m ? sessions.get(m[1]) : null;
  req.db = db;
  // requireV1Auth() honours req.validateSession — no real session store here.
  req.validateSession = async (token) => {
    const sess = sessions.get(token);
    if (!sess) return null;
    return {
      tenantId: sess.tenantId,
      user: users.get(sess.userId),
      roles: sess.roles,
      brandIds: sess.brandIds,
      sessionId: 'sess-test'
    };
  };
  if (!s) return next();   // let requireV1Auth answer 401 itself
  next();
};
app.use('/api/v1/integrations/meta', authMiddleware, createIntegrationsMetaRouter({ pool: db }));
app.use('/api/v1/integrations', authMiddleware, createIntegrationsRouter({ pool: db }));
await new Promise((r) => { app._server = app.listen(0, '127.0.0.1', r); });
const base = `http://127.0.0.1:${app._server.address().port}/api/v1`;

const CSRF = 'csrf-token-for-tests';
const call = async (path, { method = 'GET', token, body, flowToken, csrf = CSRF } = {}) => {
  const headers = { Cookie: `lwc_session=${token}; csrf_token=${csrf}`, 'x-csrf-token': csrf };
  if (body) headers['Content-Type'] = 'application/json';
  if (flowToken) headers['x-flow-token'] = flowToken;
  // NB: the real fetch — globalThis.fetch is mocked for the Meta API only.
  const r = await realFetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, text: JSON.stringify(j) };
};

const ADMIN = session('u-1', 't-1', ['Company Admin']);
const OTHER = session('u-2', 't-1', ['Company Admin']);

// The flow stores page tokens ENCRYPTED, exactly like production.
const PAGE_TOKEN = 'EAA-page-token';
const { encrypt } = await import('../src/db/crypto.js');

async function seedFlow({ brandId = B1, userId = 'u-1' } = {}) {
  const flowToken = crypto.randomBytes(32).toString('base64url');
  const flow = { id: `fl-${++DB.seq.flow}`, token_hash: sha256(flowToken), tenant_id: 't-1', user_id: userId, brand_id: brandId, expires: Date.now() + 600000, consumed_at: null };
  DB.flows.push(flow);
  const enc = encrypt(PAGE_TOKEN);
  DB.pages.push({ flow_id: flow.id, page_id: 'PAGE-1', token_encrypted: enc.value, iv: enc.iv });
  return { flow, flowToken };
}

console.log('\nStage 8 Batch 3 -- OAuth router security regressions\n');

/* ============ Finding 2: atomic token validation + consumption ============ */
console.log('--- Finding 2: flow token hash validated atomically with consumption ---');
{
  reset();
  const { flow, flowToken } = await seedFlow();

  const wrongToken = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken: `${flowToken}x-wrong`, body: { flowId: flow.id, pageId: 'PAGE-1' }
  });
  check('valid flowId + WRONG token -> 403', wrongToken.status === 403 && wrongToken.body?.error?.code === 'OAUTH_FLOW_INVALID', `${wrongToken.status} ${wrongToken.body?.error?.code}`);
  check('wrong token created NO channel', DB.channels.length === 0);
  check('wrong token created NO credential', DB.credentials.length === 0);
  check('wrong token did NOT consume the flow', DB.flows[0].consumed_at === null);

  const noToken = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, body: { flowId: flow.id, pageId: 'PAGE-1' }
  });
  check('no flow token at all -> 403', noToken.status === 403);
  check('flow still unconsumed after missing token', DB.flows[0].consumed_at === null);

  const otherUser = await call('/integrations/meta/connect', {
    method: 'POST', token: OTHER, flowToken, body: { flowId: flow.id, pageId: 'PAGE-1' }
  });
  check('another user cannot consume this flow', otherUser.status === 403);
  check('flow still unconsumed after cross-user attempt', DB.flows[0].consumed_at === null);

  const ok = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken, body: { flowId: flow.id, pageId: 'PAGE-1' }
  });
  check('correct token connects (200)', ok.status === 200, `${ok.status} ${ok.text.slice(0, 120)}`);
  check('flow consumed exactly once', DB.flows[0].consumed_at !== null);

  const replay = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken, body: { flowId: flow.id, pageId: 'PAGE-1' }
  });
  check('replay of a consumed flow -> 403', replay.status === 403);
  check('replay did NOT create a second channel', DB.channels.length === 1);
}

/* ============ concurrency ============ */
console.log('\n--- Concurrent connect attempts ---');
{
  reset();
  const { flow, flowToken } = await seedFlow();
  const attempts = await Promise.all(Array.from({ length: 5 }, () =>
    call('/integrations/meta/connect', { method: 'POST', token: ADMIN, flowToken, body: { flowId: flow.id, pageId: 'PAGE-1' } })
  ));
  const wins = attempts.filter((a) => a.status === 200).length;
  check('exactly ONE concurrent request wins', wins === 1, `wins=${wins} statuses=${attempts.map((a) => a.status).join(',')}`);
  check('concurrent attempts created exactly one channel', DB.channels.length === 1, `channels=${DB.channels.length}`);
  check('concurrent attempts created exactly one credential', DB.credentials.length === 1, `creds=${DB.credentials.length}`);
}

/* ============ Finding 3: brand binding ============ */
console.log('\n--- Finding 3: brand binding ---');
{
  reset();
  // 1) substitution attempt on a fresh flow
  const { flow, flowToken } = await seedFlow({ brandId: B1 });
  const swap = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken, body: { flowId: flow.id, pageId: 'PAGE-1', brandId: B2 }
  });
  check('substituting a different brand -> 403 BRAND_MISMATCH', swap.status === 403 && swap.body?.error?.code === 'BRAND_MISMATCH', `${swap.status} ${swap.body?.error?.code}`);
  check('brand substitution connected nothing', DB.channels.length === 0);
  // Consumption happens in the SAME statement that authorizes the connect and
  // precedes any business rule, so a rejected attempt burns its own flow
  // (fail-closed: no probing with one flow). Verified explicitly below.
  check('substitution attempt burned its own flow', flow.consumed_at !== null);

  // 2) the legitimate user retries with a NEW flow, re-sending the SAME brand
  const legit = await seedFlow({ brandId: B1 });
  const same = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken: legit.flowToken, body: { flowId: legit.flow.id, pageId: 'PAGE-1', brandId: B1 }
  });
  check('re-sending the SAME brand is accepted', same.status === 200, `${same.status}`);
  check('channel bound to the authorized brand', DB.channels[0]?.brand_id === B1);

  // 3) brand deleted / ownership changed after authorization
  const f2 = await seedFlow({ brandId: B2 });
  DB.brands.delete(B2);
  const deleted = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken: f2.flowToken, body: { flowId: f2.flow.id, pageId: 'PAGE-1' }
  });
  check('brand removed before connect -> 404 BRAND_NOT_FOUND', deleted.status === 404 && deleted.body?.error?.code === 'BRAND_NOT_FOUND', `${deleted.status} ${deleted.body?.error?.code}`);
  check('no channel created when brand ownership is lost', DB.channels.length === 1);

  // 4) a brand of another tenant cannot be substituted either
  const f3 = await seedFlow({ brandId: B1 });
  const foreign = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken: f3.flowToken, body: { flowId: f3.flow.id, pageId: 'PAGE-1', brandId: BX }
  });
  check('foreign tenant brand cannot be substituted', foreign.status === 403, `${foreign.status}`);
  check('foreign substitution created nothing', DB.channels.length === 1);

  // 5) reconnect may not move an existing channel to a different brand
  const f4 = await seedFlow({ brandId: B2 });
  DB.brands.set(B2, { id: B2, tenant_id: 't-1', name: 'Brand Two' });
  const move = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken: f4.flowToken, body: { flowId: f4.flow.id, pageId: 'PAGE-1' }
  });
  check('reconnect onto a different brand -> 409 BRAND_CONFLICT', move.status === 409 && move.body?.error?.code === 'BRAND_CONFLICT', `${move.status} ${move.body?.error?.code}`);
  check('existing channel kept its original brand', DB.channels[0]?.brand_id === B1);
  check('rejected reconnect wrote no credential', DB.credentials.length === 1, `creds=${DB.credentials.length}`);
}

/* ============ Finding 1: credential preservation on reconnect ============ */
console.log('\n--- Finding 1: reconnect rotates ONE credential row ---');
{
  reset();
  // first connect creates channel + credential
  const first = await seedFlow({ brandId: B1 });
  await call('/integrations/meta/connect', { method: 'POST', token: ADMIN, flowToken: first.flowToken, body: { flowId: first.flow.id, pageId: 'PAGE-1' } });
  check('first connect created one credential', DB.credentials.length === 1);
  const channelId = DB.channels[0].id;

  // simulate the REAL production condition: historical duplicate credential rows
  DB.credentials.push({ id: 'cr-dup-1', seq: 0, tenant_id: 't-1', channel_id: channelId, kind: 'page_access_token', value_encrypted: Buffer.from('OLD-1'), iv: 'i1', expires_at: null });
  DB.credentials.push({ id: 'cr-dup-2', seq: 1, tenant_id: 't-1', channel_id: channelId, kind: 'page_access_token', value_encrypted: Buffer.from('OLD-2'), iv: 'i2', expires_at: null });
  check('fixture reproduces duplicate credentials', DB.credentials.length === 3);

  const again = await seedFlow({ brandId: B1 });
  const reconnect = await call('/integrations/meta/connect', { method: 'POST', token: ADMIN, flowToken: again.flowToken, body: { flowId: again.flow.id, pageId: 'PAGE-1' } });
  check('reconnect succeeds', reconnect.status === 200, `${reconnect.status}`);
  check('reconnect reported as reconnected', reconnect.body?.data?.reconnected === true);
  check('reconnect did NOT create a second channel', DB.channels.length === 1);
  check('reconnect left EXACTLY ONE credential row', DB.credentials.length === 1, `creds=${DB.credentials.length}`);
  check('reconnect rotated the stored token', !DB.credentials[0].value_encrypted.toString().includes('OLD-'));
  check('page-token expiry stays NULL', DB.credentials[0].expires_at === null);

  // reconnect must not touch another channel's credentials
  DB.credentials.push({ id: 'cr-other', seq: 99, tenant_id: 't-1', channel_id: 'aaaaaaaa-0000-4000-8000-00000000000a', kind: 'page_access_token', value_encrypted: Buffer.from('KEEP'), iv: 'i9', expires_at: null });
  const third = await seedFlow({ brandId: B1 });
  await call('/integrations/meta/connect', { method: 'POST', token: ADMIN, flowToken: third.flowToken, body: { flowId: third.flow.id, pageId: 'PAGE-1' } });
  check('unrelated channel credential untouched', DB.credentials.some((c) => c.id === 'cr-other'));
}

/* ============ Finding 1/3 on resubscribe & reverify ============ */
console.log('\n--- resubscribe / reverify brand + credential handling ---');
{
  const channelId = DB.channels[0].id;
  subscribeResult = { ok: false };
  const retry = await call(`/integrations/${channelId}/resubscribe`, { method: 'POST', token: ADMIN, body: {} });
  check('resubscribe on a failed subscription returns the sanitized code', retry.status === 200 && retry.body?.data?.subscriptionState === 'subscription_failed', `${retry.status} ${retry.text.slice(0, 100)}`);
  check('resubscribe never returns a token', !retry.text.includes('EAA-page-token'));

  // foreign channel id -> not found (tenant scoped)
  const foreignId = '00000000-0000-4000-8000-000000000999';
  const notFound = await call(`/integrations/${foreignId}/resubscribe`, { method: 'POST', token: ADMIN, body: {} });
  check('resubscribe on a foreign channel -> 404', notFound.status === 404);

  // brand ownership revalidated: remove the brand, then resubscribe
  DB.brands.delete(B1);
  const lostBrand = await call(`/integrations/${channelId}/reverify`, { method: 'POST', token: ADMIN, body: {} });
  check('reverify blocked when the brand is no longer accessible', lostBrand.status === 404, `${lostBrand.status}`);
  DB.brands.set(B1, { id: B1, tenant_id: 't-1', name: 'Brand One' });
  subscribeResult = { ok: true };
}

/* ============ RBAC + brand-scope negative controls ============ */
console.log('\n--- RBAC and brand-scope restrictions at action time ---');
{
  const AGENT = session('u-2', 't-1', ['Agent']);
  const SCOPED = session('u-3', 't-1', ['Company Admin'], ['33333333-3333-4333-8333-333333333333']);

  const asAgent = await call('/integrations/meta/connect', {
    method: 'POST', token: AGENT, flowToken: crypto.randomBytes(32).toString('base64url'),
    body: { flowId: crypto.randomBytes(8).toString('hex'), pageId: 'PAGE-1' }
  });
  check('a role without brand.integration.connect -> 403 FORBIDDEN', asAgent.status === 403 && asAgent.body?.error?.code === 'FORBIDDEN', `${asAgent.status} ${asAgent.body?.error?.code}`);

  const channelId = DB.channels[0].id;
  const agentRetry = await call(`/integrations/${channelId}/resubscribe`, { method: 'POST', token: AGENT, body: {} });
  check('a role without brand.integration.reconnect -> 403 FORBIDDEN', agentRetry.status === 403 && agentRetry.body?.error?.code === 'FORBIDDEN', `${agentRetry.status} ${agentRetry.body?.error?.code}`);

  // brand scope that does NOT contain the channel's brand
  const outOfScope = await call(`/integrations/${channelId}/resubscribe`, { method: 'POST', token: SCOPED, body: {} });
  check('resubscribe outside the caller brand scope -> 404', outOfScope.status === 404, `${outOfScope.status}`);

  const scopedVerify = await call(`/integrations/${channelId}/reverify`, { method: 'POST', token: SCOPED, body: {} });
  check('reverify outside the caller brand scope -> 404', scopedVerify.status === 404, `${scopedVerify.status}`);

  // a restricted scope cannot connect a page to a brand it cannot see
  const scopedFlow = await seedFlow({ brandId: B1, userId: 'u-3' });
  const scopedConnect = await call('/integrations/meta/connect', {
    method: 'POST', token: SCOPED, flowToken: scopedFlow.flowToken, body: { flowId: scopedFlow.flow.id, pageId: 'PAGE-1' }
  });
  check('connect to a brand outside the caller scope -> 404 BRAND_NOT_FOUND', scopedConnect.status === 404 && scopedConnect.body?.error?.code === 'BRAND_NOT_FOUND', `${scopedConnect.status} ${scopedConnect.body?.error?.code}`);

  // a malformed scope fails closed (empty brand list)
  const BROKEN = session('u-3', 't-1', ['Company Admin'], 'not-an-array');
  const brokenFlow = await seedFlow({ brandId: B1, userId: 'u-3' });
  const brokenConnect = await call('/integrations/meta/connect', {
    method: 'POST', token: BROKEN, flowToken: brokenFlow.flowToken,
    body: { flowId: brokenFlow.flow.id, pageId: 'PAGE-1' }
  });
  check('malformed brand scope fails closed -> 403/404, never a connection', [403, 404].includes(brokenConnect.status), `${brokenConnect.status}`);
  check('malformed scope connected nothing', DB.channels.length === 1);
}

/* ============ leakage review ============ */
console.log('\n--- Token leakage in error paths ---');
{
  reset();
  const { flow, flowToken } = await seedFlow({ brandId: B1 });
  subscribeResult = { ok: false };
  const res = await call('/integrations/meta/connect', { method: 'POST', token: ADMIN, flowToken, body: { flowId: flow.id, pageId: 'PAGE-1' } });
  check('failed subscription still connects the page (visible state)', res.status === 200 && res.body?.data?.connected === false);
  check('response has no page token', !res.text.includes('EAA-page-token'));
  check('response has no flow token', !res.text.includes(flowToken));
  check('response has no code/state secret', !res.text.includes(flowToken.slice(0, 12)));
  const unknownPage = await call('/integrations/meta/connect', {
    method: 'POST', token: ADMIN, flowToken: crypto.randomBytes(32).toString('base64url'), body: { flowId: 'nope', pageId: 'PAGE-X' }
  });
  check('unknown flow returns only a safe error code', unknownPage.status === 403 && unknownPage.body?.error?.code === 'OAUTH_FLOW_INVALID');
  check('unknown flow leaks nothing', !unknownPage.text.includes('EAA-'));
  subscribeResult = { ok: true };
}

app._server.close();
globalThis.fetch = realFetch;
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);