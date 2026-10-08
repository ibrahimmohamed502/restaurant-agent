/**
 * Unit tests for src/facebook.js (Stage 4.2 — Meta outbound provider preparation).
 * Mocks global fetch — NO real Facebook requests are sent.
 * Run: node scripts/test-metaClient.mjs
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMetaClient,
  replyToComment,
  sendMessengerReply,
  sendTypingIndicator,
  getUserFirstName,
  META_CREDENTIAL_MISSING
} from '../src/facebook.js';

const EXPLICIT = 'EXPLICIT_TOKEN_XYZ_NEVER_LOG';
const ENVTOK = 'ENV_TOKEN_ABC_NEVER_LOG';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.error('  ❌', name); }
}

const calls = [];
const originalFetch = globalThis.fetch;
const origWarn = console.warn;
let warnLog = [];

function mockFetch(handler) {
  calls.length = 0;
  warnLog = [];
  console.warn = (...args) => { warnLog.push(args.join(' ')); };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(url, opts);
  };
}
function restore() {
  globalThis.fetch = originalFetch;
  console.warn = origWarn;
}

const okHandler = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ id: 'resp_123', first_name: 'Ahmed', message_id: 'mid_1' })
});

console.log('\n🧪 Stage 4.2 — MetaClient unit tests\n');

/* 1: explicit token used instead of env */
process.env.FB_PAGE_ACCESS_TOKEN = ENVTOK;
mockFetch(okHandler);
await createMetaClient({ accessToken: EXPLICIT }).replyToComment('c1', 'hi');
check('1. explicit token used over env token', calls[0].opts.headers.Authorization === `Bearer ${EXPLICIT}`);

/* 2: legacy env fallback when no explicit token */
mockFetch(okHandler);
await createMetaClient().replyToComment('c1', 'hi');
check('2. legacy env fallback used when no explicit token supplied', calls[0].opts.headers.Authorization === `Bearer ${ENVTOK}`);

/* 3: missing both credentials fails safely */
delete process.env.FB_PAGE_ACCESS_TOKEN;
{
  let code = null, sent = calls.length;
  try { createMetaClient(); } catch (e) { code = e.code; }
  check('3. missing both credentials fails with META_CREDENTIAL_MISSING (no request sent)',
    code === META_CREDENTIAL_MISSING && calls.length === sent);
}

/* 4-7: all operations support explicit credential */
process.env.FB_PAGE_ACCESS_TOKEN = ENVTOK;
mockFetch(okHandler);
const client = createMetaClient({ accessToken: EXPLICIT });

await client.replyToComment('comment_1', 'hello');
check('4. replyToComment uses explicit credential + correct endpoint',
  calls[0].url.includes('/comment_1/comments') && calls[0].opts.headers.Authorization === `Bearer ${EXPLICIT}`);

await client.sendMessengerReply('psid_1', 'hi');
check('5. sendMessengerReply uses explicit credential + /me/messages',
  calls[1].url.endsWith('/me/messages') && calls[1].opts.headers.Authorization === `Bearer ${EXPLICIT}`);

await client.sendTypingIndicator('psid_1');
check('6. sendTypingIndicator uses explicit credential', calls[2].opts.headers.Authorization === `Bearer ${EXPLICIT}`);

const name = await client.getUserFirstName('psid_1');
check('7. getUserFirstName uses explicit credential + returns name',
  calls[3].opts.headers.Authorization === `Bearer ${EXPLICIT}` && name === 'Ahmed');

/* 8: token does not appear in errors, and URL never embeds it */
mockFetch(async () => ({
  ok: false,
  status: 400,
  json: async () => ({ error: { message: 'Invalid OAuth access token - signature invalid', code: 190, type: 'OAuthException' } })
}));
{
  let err = null;
  try { await createMetaClient({ accessToken: EXPLICIT }).replyToComment('c1', 'hi'); } catch (e) { err = e; }
  check('8. thrown error does NOT contain the token',
    !!err && !err.message.includes(EXPLICIT) && !err.message.includes(ENVTOK));
  check('8b. request URL does NOT embed the token (header auth used)',
    calls.every((c) => !c.url.includes(EXPLICIT) && !c.url.includes(ENVTOK)));
}

/* 9: token does not appear in logs/debug output */
mockFetch(async () => { throw new Error('network boom'); });
await createMetaClient({ accessToken: EXPLICIT }).sendTypingIndicator('psid_1'); // catches internally → console.warn
check('9. internal catch logs do NOT contain the token', !warnLog.join(' ').includes(EXPLICIT) && !warnLog.join(' ').includes(ENVTOK));

/* 10: legacy named exports remain backward compatible (same signatures, env fallback) */
process.env.FB_PAGE_ACCESS_TOKEN = ENVTOK;
mockFetch(okHandler);
await replyToComment('c1', 'hi');
await sendMessengerReply('psid_1', 'hi');
await sendTypingIndicator('psid_1');
const n2 = await getUserFirstName('psid_1');
check('10. legacy named exports remain backward compatible (same signatures)',
  calls.length === 4 && n2 === 'Ahmed' && calls.every((c) => c.opts.headers.Authorization === `Bearer ${ENVTOK}`));

/* 11: webhook routing NOT wired to the new client/resolver */
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const webhookSrc = readFileSync(path.join(root, 'src', 'webhook.js'), 'utf8');
  check('11. webhook.js NOT wired to createMetaClient/channelResolver (routing unchanged)',
    !webhookSrc.includes('createMetaClient') && !webhookSrc.includes('channelResolver'));
}

restore();
console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
