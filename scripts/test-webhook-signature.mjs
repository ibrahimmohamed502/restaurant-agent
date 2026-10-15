/**
 * Stage 8 Batch 3 — Meta webhook signature compatibility suite.
 *
 * Covers the fail-closed remediation and proves legitimate Meta traffic is
 * unaffected.
 *
 * Run: node scripts/test-webhook-signature.mjs
 */
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import crypto from 'node:crypto';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

const SECRET = 'test-app-secret';
const { verifySignature } = await import('../src/webhook.js');

/** Build a request-like object exactly as express would hand it to the guard. */
function makeReq({ body = '{"object":"page"}', signature, secret = SECRET } = {}) {
  const rawBody = Buffer.from(body);
  const headers = {};
  if (signature !== undefined) headers['x-hub-signature-256'] = signature;
  return { headers, rawBody, body: JSON.parse(body) };
}

const sign = (body, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');

console.log('\nStage 8 Batch 3 -- Meta webhook signature (fail-closed)\n');

/* ---------------- fail-closed when the secret is missing ---------------- */
console.log('--- Fail-closed behaviour ---');
{
  process.env.FB_APP_SECRET = SECRET;
  const saved = process.env.FB_APP_SECRET;
  delete process.env.FB_APP_SECRET;
  const withValidLookingSig = makeReq({ signature: sign('{"object":"page"}') });
  check('secret unset -> signature NOT accepted even with a well-formed signature',
    verifySignature(withValidLookingSig) === false);
  check('secret unset -> plain request rejected', verifySignature(makeReq({})) === false);
  process.env.FB_APP_SECRET = saved;
}

/* ---------------- legitimate traffic ---------------- */
console.log('\n--- Legitimate Meta traffic still accepted ---');
{
  process.env.FB_APP_SECRET = SECRET;
  const body = '{"object":"page","entry":[{"id":"P1"}]}';
  check('correct signature over the raw body -> accepted', verifySignature(makeReq({ body, signature: sign(body) })) === true);
}

/* ---------------- rejections ---------------- */
console.log('\n--- Rejections ---');
{
  process.env.FB_APP_SECRET = SECRET;
  const body = '{"object":"page"}';
  check('missing header -> rejected', verifySignature(makeReq({ body })) === false);
  check('wrong signature -> rejected', verifySignature(makeReq({ body, signature: sign(body, 'other-secret') })) === false);
  check('signature computed over different bytes (tampered body) -> rejected',
    verifySignature(makeReq({ body: '{"object":"instagram"}', signature: sign(body) })) === false);
  check('malformed signature (wrong length) -> rejected without throwing',
    verifySignature(makeReq({ body, signature: 'sha256=abc' })) === false);
  check('signature without the sha256= prefix -> rejected',
    verifySignature(makeReq({ body, signature: crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex') })) === false);
  check('missing raw body -> rejected',
    verifySignature({ headers: { 'x-hub-signature-256': sign(body) }, rawBody: undefined }) === false);
  check('empty signature -> rejected', verifySignature(makeReq({ body, signature: '' })) === false);
}

/* ---------------- static contract preserved ---------------- */
console.log('\n--- Static contract (regression guard) ---');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/webhook.js', import.meta.url), 'utf8');
  check('still verifies x-hub-signature-256', src.includes('x-hub-signature-256'));
  check('still uses timingSafeEqual', src.includes('crypto.timingSafeEqual'));
  check('POST route still rejects early with 401', src.includes("sendStatus(401)"));
  check('GET verification handshake untouched (WEBHOOK_VERIFY_TOKEN)', src.includes('WEBHOOK_VERIFY_TOKEN'));
  check('no fail-open return true remains', !/if \(!secret\) return true/.test(src));
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  check('production startup validation present', server.includes('function assertProductionConfig'));
  check('startup validation runs before listen', server.indexOf('assertProductionConfig();') < server.indexOf('app.listen('));
  check('startup validation enforces FB_APP_SECRET in production', /NODE_ENV === 'production' && !process\.env\.FB_APP_SECRET/.test(server));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);