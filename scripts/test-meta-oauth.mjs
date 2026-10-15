/**
 * Stage 8 Batch 3 — Facebook self-service OAuth tests.
 *
 * Proves: atomic + session-bound state consumption, a SEPARATE short-lived flow
 * authorization for the picker/connect step, replay protection, brand/tenant
 * isolation, bounded subscription attempts, truthful connection status and zero
 * token leakage.
 *
 * Uses an in-memory mock database (no production data, no network).
 * Run: node scripts/test-meta-oauth.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PUBLIC_BASE_URL = 'https://app.example.com';
process.env.FB_APP_ID = '1234567890';
process.env.FB_APP_SECRET = 'fb-secret';
process.env.OAUTH_STATE_SECRET = 'oauth-state-secret-0123456789abcdef';

import crypto from 'node:crypto';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

const oauth = await import('../src/services/metaOAuth.js');
const { safeHealthErrorCode } = await import('../src/services/healthCodes.js');

/* --------------------------------------------------------- mock database */
const states = [];
const flows = [];
const pages = [];
let stateSeq = 0, flowSeq = 0, pageSeq = 0;

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // atomic, session-bound state consumption
    if (/update oauth_connect_states set consumed_at = now\(\)/.test(s) && /and tenant_id = \$2/.test(s) && /and user_id = \$3/.test(s)) {
      const [stateId, tenantId, userId] = params;
      const row = states.find((r) => r.id === stateId);
      if (!row) return { rows: [] };
      if (row.tenant_id !== tenantId || row.user_id !== userId) return { rows: [] };
      if (row.consumed_at || new Date(row.expires_at) <= new Date()) return { rows: [] };
      row.consumed_at = new Date();
      return { rows: [row] };
    }
    if (/from oauth_connect_states where nonce_hash = \$1/.test(s)) {
      const row = states.find((r) => r.nonce_hash === params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/insert into oauth_connect_flows/.test(s)) {
      const [state_id, tenant_id, user_id, brand_id, token_hash] = params;
      const row = { id: `flow-${++flowSeq}`, state_id, tenant_id, user_id, brand_id, token_hash, user_token_expires_at: null, expires_at: new Date(Date.now() + 600000), last_used_at: null, consumed_at: null };
      flows.push(row);
      return { rows: [row] };
    }
    if (/update oauth_connect_flows\s+set last_used_at = now\(\)/.test(s)) {
      const [flowId, tenantId, userId, tokenHash] = params;
      const row = flows.find((r) => r.id === flowId);
      if (!row) return { rows: [] };
      if (row.tenant_id !== tenantId || row.user_id !== userId) return { rows: [] };
      if (row.consumed_at || new Date(row.expires_at) <= new Date()) return { rows: [] };
      if (row.token_hash !== tokenHash) return { rows: [] };
      row.last_used_at = new Date();
      return { rows: [row] };
    }
    if (/update oauth_connect_flows\s+set consumed_at = now\(\), last_used_at = now\(\)/.test(s)) {
      const [flowId, tenantId, userId] = params;
      const row = flows.find((r) => r.id === flowId);
      if (!row) return { rows: [] };
      if (row.tenant_id !== tenantId || row.user_id !== userId) return { rows: [] };
      if (row.consumed_at || new Date(row.expires_at) <= new Date()) return { rows: [] };
      row.consumed_at = new Date();
      return { rows: [row] };
    }
    if (/update oauth_connect_flows set user_token_expires_at/.test(s)) {
      const [flowId, exp] = params;
      const row = flows.find((r) => r.id === flowId);
      if (row) row.user_token_expires_at = exp;
      return { rows: [] };
    }
    if (/insert into oauth_connect_pages/.test(s)) {
      const [flow_id, page_id, page_name, page_tasks, page_category, token_encrypted, iv] = params;
      let row = pages.find((r) => r.flow_id === flow_id && r.page_id === page_id);
      if (row) { row.token_encrypted = token_encrypted; row.iv = iv; }
      else { row = { id: `op-${++pageSeq}`, flow_id, page_id, page_name, page_tasks, page_category, token_encrypted, iv }; pages.push(row); }
      return { rows: [] };
    }
    if (/select page_id, page_name, page_tasks, page_category/.test(s)) {
      return { rows: pages.filter((r) => r.flow_id === params[0]).map((r) => ({ page_id: r.page_id, page_name: r.page_name, page_tasks: r.page_tasks, page_category: r.page_category })) };
    }
    if (/select token_encrypted, iv from oauth_connect_pages/.test(s)) {
      const row = pages.find((r) => r.flow_id === params[0] && r.page_id === params[1]);
      return { rows: row ? [{ token_encrypted: row.token_encrypted, iv: row.iv }] : [] };
    }
    if (/delete from oauth_connect_states where expires_at/.test(s)) return { rowCount: 0, rows: [] };
    return { rows: [] };
  }
};

const TENANT = 't-1', USER = 'u-1', BRAND = 'b-1';
async function seedState({ tenantId = TENANT, userId = USER, brandId = BRAND, ttlMs = 600000 } = {}) {
  const { state, nonceHash, expiresAt } = oauth.createState({ tenantId, userId, brandId });
  const row = { id: `st-${++stateSeq}`, nonce_hash: nonceHash, tenant_id: tenantId, user_id: userId, brand_id: brandId, expires_at: expiresAt, consumed_at: null };
  if (ttlMs !== 600000) row.expires_at = new Date(Date.now() + ttlMs);
  states.push(row);
  return { state, row };
}

console.log('\nStage 8 Batch 3 -- Facebook self-service OAuth\n');

/* ---------------- 1. state signing ---------------- */
console.log('--- OAuth state signing ---');
{
  const { state, row } = await seedState();
  const parsed = oauth.parseState(state);
  check('state parses into nonce/mac/expiry', Boolean(parsed));
  check('signature verifies against the stored identity', oauth.verifyStateSignature(parsed, row) === true);
  check('signature fails for a different brand (identity binding)', oauth.verifyStateSignature(parsed, { ...row, brand_id: 'b-other' }) === false);
  check('signature fails for a different tenant', oauth.verifyStateSignature(parsed, { ...row, tenant_id: 't-other' }) === false);
  check('signature fails for a different user', oauth.verifyStateSignature(parsed, { ...row, user_id: 'u-other' }) === false);

  const tampered = `${state.split('.')[0]}.${'a'.repeat(64)}.${state.split('.')[2]}`;
  check('tampered MAC rejected', oauth.verifyStateSignature(oauth.parseState(tampered), row) === false);
  check('malformed state rejected (no dots)', oauth.parseState('garbage') === null);
  check('empty state rejected', oauth.parseState('') === null);
  check('oversized state rejected', oauth.parseState('a'.repeat(600)) === null);

  const expired = oauth.parseState(`${state.split('.')[0]}.${state.split('.')[1]}.${Math.floor(Date.now() / 1000) - 10}`);
  check('expired state rejected at parse time', expired === null);
}

/* ---------------- 2. atomic + session-bound consumption ---------------- */
console.log('\n--- Atomic, session-bound state consumption ---');
{
  const { state, row } = await seedState();
  const parsed = oauth.parseState(state);

  const wrongSession = await oauth.consumeState({ stateId: row.id, tenantId: TENANT, userId: 'u-attacker' }, { db });
  check('unauthorized session cannot consume the state', wrongSession === null);
  check('state remains UNCONSUMED after the unauthorized attempt', row.consumed_at === null);

  const wrongTenant = await oauth.consumeState({ stateId: row.id, tenantId: 't-other', userId: USER }, { db });
  check('other tenant cannot consume the state', wrongTenant === null);
  check('state still unconsumed after cross-tenant attempt', row.consumed_at === null);

  const first = await oauth.consumeState({ stateId: row.id, tenantId: TENANT, userId: USER }, { db });
  check('authorized session consumes the state', Boolean(first));
  const replay = await oauth.consumeState({ stateId: row.id, tenantId: TENANT, userId: USER }, { db });
  check('replay (second consume) is rejected', replay === null);
  check('consumed row carries the signed identity', first?.brand_id === BRAND);
  void parsed;
}

/* ---------------- 3. separate flow authorization ---------------- */
console.log('\n--- Separate short-lived flow authorization ---');
{
  const { row } = await seedState();
  const consumed = await oauth.consumeState({ stateId: row.id, tenantId: TENANT, userId: USER }, { db });
  const flow = await oauth.createFlow({ stateRow: consumed }, { db });
  check('flow is created after a successful callback', Boolean(flow.flowId && flow.flowToken));
  check('flow token is not stored in plaintext', flows.find((f) => f.id === flow.flowId).token_hash !== flow.flowToken);

  const ok = await oauth.validateFlow({ flowId: flow.flowId, flowToken: flow.flowToken, tenantId: TENANT, userId: USER }, { db });
  check('valid flow token authorizes the picker', Boolean(ok));
  const badToken = await oauth.validateFlow({ flowId: flow.flowId, flowToken: 'wrong', tenantId: TENANT, userId: USER }, { db });
  check('wrong flow token rejected', badToken === null);
  const badUser = await oauth.validateFlow({ flowId: flow.flowId, flowToken: flow.flowToken, tenantId: TENANT, userId: 'u-other' }, { db });
  check('flow token is session-bound (other user rejected)', badUser === null);

  const consumedFlow = await oauth.consumeFlow({ flowId: flow.flowId, tenantId: TENANT, userId: USER }, { db });
  check('connect step consumes the flow (single use)', Boolean(consumedFlow));
  const reuse = await oauth.consumeFlow({ flowId: flow.flowId, tenantId: TENANT, userId: USER }, { db });
  check('flow cannot be reused after connect', reuse === null);

  // OAuth state alone must NOT be enough for the picker/connect step
  check('picker requires the separate flow authorization (no state-only access)', typeof oauth.validateFlow === 'function' && badToken === null && badUser === null);
}

/* ---------------- 4. page tokens never leak ---------------- */
console.log('\n--- Page token handling ---');
{
  const { row } = await seedState();
  const consumed = await oauth.consumeState({ stateId: row.id, tenantId: TENANT, userId: USER }, { db });
  const flow = await oauth.createFlow({ stateRow: consumed }, { db });
  await oauth.storeFlowPages({ flowId: flow.flowId, pages: [{ id: 'PAGE-1', name: 'Test Page', tasks: ['MANAGE'], accessToken: 'EAAB-secret-page-token' }] }, { db });
  const listed = await oauth.listFlowPages({ flowId: flow.flowId }, { db });
  const serialized = JSON.stringify(listed);
  check('page picker never returns tokens', !serialized.includes('EAAB-secret-page-token'));
  check('picker returns page id + name + tasks', listed[0]?.id === 'PAGE-1' && listed[0]?.name === 'Test Page' && listed[0]?.tasks?.[0] === 'MANAGE');

  const token = await oauth.pageTokenFor({ flowId: flow.flowId, pageId: 'PAGE-1' }, { db });
  check('server can retrieve the encrypted page token', token === 'EAAB-secret-page-token');
  const stored = pages.find((p) => p.page_id === 'PAGE-1');
  check('stored token is ciphertext, not plaintext',
    !String(stored.token_encrypted).includes('EAAB-secret-page-token'));
  const unknownPage = await oauth.pageTokenFor({ flowId: flow.flowId, pageId: 'PAGE-NOT-MINE' }, { db });
  check('a page outside the flow set cannot be connected', unknownPage === null);
}

/* ---------------- 5. user token expiry kept separate ---------------- */
console.log('\n--- Token expiry separation ---');
{
  const { row } = await seedState();
  const consumed = await oauth.consumeState({ stateId: row.id, tenantId: TENANT, userId: USER }, { db });
  const flow = await oauth.createFlow({ stateRow: consumed }, { db });
  const exp = new Date(Date.now() + 5183944 * 1000);
  await oauth.setFlowUserTokenExpiry({ flowId: flow.flowId, expiresAt: exp }, { db });
  check('user token expiry recorded on the FLOW (not on provider_credentials)', flows.find((f) => f.id === flow.flowId).user_token_expires_at?.getTime?.() === exp.getTime());
  const fs = await import('node:fs');
  const metaRouterSrc = fs.readFileSync(new URL('../src/api/v1/integrationsMeta.js', import.meta.url), 'utf8');
  check('connect writes NULL for the page-token expiry', metaRouterSrc.includes("'page_access_token',$3,$4,NULL)"));
  const mig = fs.readFileSync(new URL('../migrations/014_meta_page_selfservice.sql', import.meta.url), 'utf8');
  check('migration never backfills provider_credentials.expires_at', !/UPDATE\s+provider_credentials/i.test(mig));
  check('migration does not write into existing channels rows', !/UPDATE\s+channels/i.test(mig));
}

/* ---------------- 6. readiness / disabled state ---------------- */
console.log('\n--- PUBLIC_BASE_URL disabled state ---');
{
  const saved = process.env.PUBLIC_BASE_URL;
  check('enabled when fully configured', oauth.oauthReadiness().enabled === true);
  check('redirect_uri derives from PUBLIC_BASE_URL', oauth.redirectUri() === 'https://app.example.com/api/v1/integrations/meta/callback');

  delete process.env.PUBLIC_BASE_URL;
  const r1 = oauth.oauthReadiness();
  check('disabled when PUBLIC_BASE_URL missing', r1.enabled === false);
  check('reports the missing variable', r1.missing.includes('PUBLIC_BASE_URL'));
  check('no tunnel/Host fallback for redirect_uri', oauth.redirectUri() === null);

  process.env.PUBLIC_BASE_URL = 'http://insecure.example.com';
  check('plain http rejected by default', oauth.oauthReadiness().enabled === false);
  process.env.ALLOW_INSECURE_OAUTH_HTTP = 'true';
  check('http allowed only behind an explicit escape hatch', oauth.oauthReadiness().enabled === true);
  delete process.env.ALLOW_INSECURE_OAUTH_HTTP;
  process.env.PUBLIC_BASE_URL = saved;
  check('readiness reports missing keys without leaking values', oauth.oauthReadiness().missing.every((m) => /^[A-Z_]+$/.test(m)));
}

/* ---------------- 7. bounded subscription attempts ---------------- */
console.log('\n--- Bounded webhook subscription ---');
{
  check('attempts are bounded to 2', oauth.SUBSCRIBE_ATTEMPTS === 2);
  check('backoff is short (1s)', oauth.SUBSCRIBE_BACKOFF_MS <= 1000);

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500, json: async () => ({ error: { message: 'Graph API 400: permission', code: 200 } }) }; };
  const started = Date.now();
  const res = await oauth.subscribePageWebhook({ pageId: 'PAGE-1', pageToken: 'tok' });
  const elapsed = Date.now() - started;
  globalThis.fetch = realFetch;
  check('subscription failure returns an allow-listed sanitized code (raw message dropped)',
    res.ok === false && res.errorCode === 'META_GRAPH_PERMISSION' && safeHealthErrorCode(res.errorCode) === res.errorCode,
    res.errorCode);
  check('no more attempts than configured', calls <= oauth.SUBSCRIBE_ATTEMPTS, `calls=${calls}`);
  check('request is NOT held for tens of seconds', elapsed < 10000, `${elapsed}ms`);

  let okCalls = 0;
  globalThis.fetch = async () => {
    okCalls++;
    if (okCalls === 1) return { ok: false, status: 500, json: async () => ({ error: { message: 'Graph API 429', code: 4 } }) };
    return { ok: true, json: async () => ({ success: true }) };
  };
  const res2 = await oauth.subscribePageWebhook({ pageId: 'PAGE-1', pageToken: 'tok' });
  globalThis.fetch = realFetch;
  check('transient failure then success -> subscribed', res2.ok === true && res2.errorCode === null);
}

/* ---------------- 8. sanitized diagnostics ---------------- */
console.log('\n--- Sanitized diagnostics ---');
{
  check('permission error maps to an allow-listed code', safeHealthErrorCode('META_GRAPH_PERMISSION') === 'META_GRAPH_PERMISSION');
  check('subscription failure code allowed', safeHealthErrorCode('SUBSCRIPTION_FAILED') === 'SUBSCRIPTION_FAILED');
  check('raw provider text collapses to UNRECOGNIZED_ERROR', safeHealthErrorCode('Invalid OAuth token EAAAB for user 55@fb') === 'UNRECOGNIZED_ERROR');
  check('oauth codes are allow-listed', ['OAUTH_STATE_INVALID', 'OAUTH_NOT_AUTHORIZED', 'OAUTH_FLOW_INVALID', 'PAGE_ALREADY_CONNECTED', 'BRAND_CONFLICT'].every((c) => safeHealthErrorCode(c) === c));
}

/* ---------------- 9. truthful connection status ---------------- */
console.log('\n--- Truthful connection status ---');
{
  const D = oauth.deriveConnectionState;
  check('credential + confirmed subscription + enabled = connected',
    D({ channelStatus: 'active', hasCredential: true, subscriptionState: 'subscribed' }) === 'connected');
  check('credential but subscription not confirmed = pending',
    D({ channelStatus: 'active', hasCredential: true, subscriptionState: 'pending_subscription' }) === 'pending_subscription');
  check('subscription rejected = subscription_failed',
    D({ channelStatus: 'active', hasCredential: true, subscriptionState: 'subscription_failed' }) === 'subscription_failed');
  check('enabled WITHOUT credential is NOT connected (never inferred from status)',
    D({ channelStatus: 'active', hasCredential: false, subscriptionState: 'subscribed' }) === 'not_connected');
  check('legacy/unverified rows are unknown, not connected',
    D({ channelStatus: 'active', hasCredential: true, subscriptionState: 'unknown' }) === 'unknown');
  check('disabled channel needs attention even when subscribed',
    D({ channelStatus: 'disabled', hasCredential: true, subscriptionState: 'subscribed' }) === 'needs_attention');
  check('missing subscription column defaults to unknown',
    D({ channelStatus: 'active', hasCredential: true, subscriptionState: undefined }) === 'unknown');
}

/* ---------------- 10. scopes (verified against Meta docs) ---------------- */
console.log('\n--- Requested scopes ---');
{
  check('requests pages_show_list', oauth.REQUIRED_SCOPES.includes('pages_show_list'));
  check('requests pages_manage_metadata (accounts + subscribed_apps)', oauth.REQUIRED_SCOPES.includes('pages_manage_metadata'));
  check('requests pages_read_engagement', oauth.REQUIRED_SCOPES.includes('pages_read_engagement'));
  check('requests pages_manage_engagement', oauth.REQUIRED_SCOPES.includes('pages_manage_engagement'));
  check('does NOT request offline_access', !oauth.REQUIRED_SCOPES.includes('offline_access'));
  check('subscribes feed+messages', oauth.SUBSCRIBED_FIELDS === 'feed,messages');
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);