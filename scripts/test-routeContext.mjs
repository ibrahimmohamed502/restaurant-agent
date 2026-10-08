/**
 * Unit tests for src/services/routeContext.js (Stage 4.3B.1).
 * Mocks resolveMetaChannel + createMetaClient — no DB, no real Meta requests.
 * Run: node scripts/test-routeContext.mjs
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouteContext, ROUTE_ERRORS } from '../src/services/routeContext.js';
import { RESOLVE_ERRORS } from '../src/services/channelResolver.js';

const SECRET = 'TEST_DB_CREDENTIAL_SECRET_NEVER_LOG';
const PAGE = 'test_page_cv_001';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.error('  ❌', name); }
}

const goodResolve = async () => ({
  channelId: 'ch-cv-001',
  tenantId: 't-ufc',
  brandId: 'b-lwc',
  provider: 'meta',
  externalId: PAGE,
  displayName: 'CV Test Page',
  status: 'active',
  credential: SECRET
});

let capturedToken = null;
const fakeClientFactory = (opts) => {
  capturedToken = opts?.accessToken;
  return { isMetaClient: true, replyToComment: () => {}, sendMessengerReply: () => {}, sendTypingIndicator: () => {}, getUserFirstName: () => {} };
};

console.log('\n🧪 Stage 4.3B.1 — routeContext unit tests\n');

/* 1: known page → correct context */
capturedToken = null;
{
  const ctx = await buildRouteContext(PAGE, { resolveFn: goodResolve, clientFactory: fakeClientFactory });
  check('1. known page → correct context (pageId/channelId/tenantId/brandId/displayName/metaClient)',
    ctx.pageId === PAGE &&
    ctx.channelId === 'ch-cv-001' &&
    ctx.tenantId === 't-ufc' &&
    ctx.brandId === 'b-lwc' &&
    ctx.displayName === 'CV Test Page' &&
    ctx.metaClient?.isMetaClient === true);
}

/* 2: entry as webhook object ({id, time, changes}) → uses entry.id */
{
  const ctx = await buildRouteContext({ id: PAGE, time: 123, changes: [] }, { resolveFn: goodResolve, clientFactory: fakeClientFactory });
  check('2. webhook entry object → resolves via entry.id', ctx.pageId === PAGE);
}

/* 3: missing pageId → fail closed (MISSING_PAGE_ID) */
{
  let code = null;
  try { await buildRouteContext({ time: 123 }, { resolveFn: goodResolve, clientFactory: fakeClientFactory }); } catch (e) { code = e.code; }
  check('3. missing pageId → fail closed (MISSING_PAGE_ID)', code === ROUTE_ERRORS.MISSING_PAGE_ID);
}

/* 4: unknown page → fail closed (UNKNOWN_META_PAGE) */
{
  const failResolve = async () => { const e = new Error('no meta channel configured for page x'); e.code = RESOLVE_ERRORS.UNKNOWN_META_PAGE; throw e; };
  let code = null;
  try { await buildRouteContext('unknown_page', { resolveFn: failResolve, clientFactory: fakeClientFactory }); } catch (e) { code = e.code; }
  check('4. unknown page → fail closed (UNKNOWN_META_PAGE)', code === RESOLVE_ERRORS.UNKNOWN_META_PAGE);
}

/* 5: inactive channel → fail closed (CHANNEL_INACTIVE) */
{
  const failResolve = async () => { const e = new Error('meta channel ch-x is disabled'); e.code = RESOLVE_ERRORS.CHANNEL_INACTIVE; throw e; };
  let code = null;
  try { await buildRouteContext(PAGE, { resolveFn: failResolve, clientFactory: fakeClientFactory }); } catch (e) { code = e.code; }
  check('5. inactive channel → fail closed (CHANNEL_INACTIVE)', code === RESOLVE_ERRORS.CHANNEL_INACTIVE);
}

/* 6: missing credential → fail closed (CREDENTIAL_MISSING) */
{
  const failResolve = async () => { const e = new Error('no page_access_token credential for channel ch-x'); e.code = RESOLVE_ERRORS.CREDENTIAL_MISSING; throw e; };
  let code = null;
  try { await buildRouteContext(PAGE, { resolveFn: failResolve, clientFactory: fakeClientFactory }); } catch (e) { code = e.code; }
  check('6. missing credential → fail closed (CREDENTIAL_MISSING)', code === RESOLVE_ERRORS.CREDENTIAL_MISSING);
}

/* 7: generic decryption/resolver failure → fail closed with safe message (no raw text) */
{
  const failResolve = async () => { throw new Error(`decryption blew up with secret ${SECRET} inside`); };
  let err = null;
  try { await buildRouteContext(PAGE, { resolveFn: failResolve, clientFactory: fakeClientFactory }); } catch (e) { err = e; }
  check('7. generic failure → fail closed (RESOLVE_FAILED) WITHOUT raw message',
    err?.code === ROUTE_ERRORS.RESOLVE_FAILED && !err.message.includes(SECRET));
}

/* 8: credential never appears in returned errors across all failure paths */
{
  const leaks = [];
  const paths = [
    () => buildRouteContext({}, { resolveFn: goodResolve, clientFactory: fakeClientFactory }),
    () => buildRouteContext('unknown', { resolveFn: async () => { const e = new Error('x'); e.code = RESOLVE_ERRORS.UNKNOWN_META_PAGE; throw e; }, clientFactory: fakeClientFactory }),
    () => buildRouteContext(PAGE, { resolveFn: async () => { const e = new Error('x'); e.code = RESOLVE_ERRORS.CREDENTIAL_MISSING; throw e; }, clientFactory: fakeClientFactory }),
    () => buildRouteContext(PAGE, { resolveFn: async () => { throw new Error(`boom ${SECRET}`); }, clientFactory: fakeClientFactory })
  ];
  for (const p of paths) {
    try { await p(); } catch (e) { if (e.message.includes(SECRET)) leaks.push(e.code); }
  }
  check('8. credential never appears in returned errors', leaks.length === 0);
}

/* 9: createMetaClient receives the resolved DB credential (no env fallback) */
{
  const ctx = await buildRouteContext(PAGE, { resolveFn: goodResolve, clientFactory: fakeClientFactory });
  check('9. clientFactory received the resolved DB credential', capturedToken === SECRET && ctx.metaClient?.isMetaClient);
}

console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
