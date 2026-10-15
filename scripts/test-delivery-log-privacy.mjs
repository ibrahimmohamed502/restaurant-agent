/**
 * Log privacy for the outbound delivery path.
 *
 *   node scripts/test-delivery-log-privacy.mjs
 *
 * The delivery path is the one place where a raw provider message, a PSID or a
 * token could realistically reach the container log. This suite asserts that
 * none of them can, and that the sanitizers behave.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync } from 'node:fs';
import { redactId, textSummary, safeErrorCode } from '../src/services/redact.js';
import { escalationLogView } from '../src/notify.js';
import { classifyDeliveryError } from '../src/services/deliveryOutcome.js';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const CUSTOMER_TEXT = 'my card is 4111 1111 1111 1111 and my psid is PSID-SECRET-42';
const PSID = 'PSID-SECRET-42';
const TOKEN = 'EAABwzLixnjYBO7ZBsecretTokenValue1234567890';

console.log('\nStage 8 — delivery log privacy\n');

/** Every module that participates in the outbound delivery path. */
const deliveryFiles = {
    'src/webhook.js': read('../src/webhook.js'),
    'src/facebook.js': read('../src/facebook.js'),
    'src/workers/metaEventPipeline.js': read('../src/workers/metaEventPipeline.js'),
    'src/workers/metaEventWorker.js': read('../src/workers/metaEventWorker.js'),
    'src/notify.js': read('../src/notify.js'),
    'src/services/conversations.js': read('../src/services/conversations.js'),
    'src/services/deliveryOutcome.js': read('../src/services/deliveryOutcome.js')
};

/* ============ 1. NO RAW PROVIDER MESSAGE IS EVER PRINTED ============== */
console.log('--- 1. the delivery path logs codes, not provider text ---');
{
  for (const [file, src] of Object.entries(deliveryFiles)) {
    const rawErrLogs = src.match(/console\.(?:warn|error|log)\([^)]*\b(?:e|err)\.message\b/g) ?? [];
    check(`${file}: no console call prints err.message`, rawErrLogs.length === 0,
      rawErrLogs.join(' | '));
  }

  const webhook = deliveryFiles['src/webhook.js'];
  check('webhook.js logs the sanitized delivery category only',
    webhook.includes('[' + '${outcome.category}' + '] outcome=' + '${outcome.outcome}'));
  check('webhook.js never serialises the reply text or the raw payload',
    !/JSON\.stringify\(req\.body\)/.test(webhook) && !/JSON\.stringify\(draft\)/.test(webhook));
  check('webhook.js never prints a raw PSID, only its digest',
    !/console\.[a-z]+\([^)]*\$\{psid\}[^)]*\)/.test(webhook));
}

/* ============ 2. THE META CLIENT NEVER LOGS THE RESPONSE ============== */
console.log('--- 2. the Meta client is sanitized ---');
{
  const fb = deliveryFiles['src/facebook.js'];
  check('facebook.js never logs a Graph error message', !/e\.message\)/.test(fb));
  check('facebook.js redacts the PSID it was given', /redactId\(psid\)/.test(fb));
  check('facebook.js uses the shared sanitizer', /safeErrorCode/.test(fb));
  check('the token is only ever sent in a header, never in a URL or a log',
    !/\$\{token\}[^)]*(console|log)/.test(fb) && /Authorization: `Bearer \$\{token\}`/.test(fb));
  check('no URL containing the token can reach a log', !/GRAPH_BASE\$\{path\}[^)]*console/.test(fb));
}

/* ============ 3. THE ESCALATION LOG IS REDACTED ====================== */
console.log('--- 3. escalation logging carries no customer content ---');
{
  const view = escalationLogView({
    channel: 'messenger',
    from: { id: PSID, name: 'Nour El-Amin' },
    message: CUSTOMER_TEXT,
    reason: 'contact data',
    draft: { reply: 'call 999', intent: 'hours', lang: 'en' },
    commentId: 'cmt_secret'
  });
  const line = JSON.stringify(view);
  check('the customer text never appears', !line.includes('4111'));
  check('the PSID never appears', !line.includes(PSID));
  check('the customer name never appears', !line.includes('Nour El-Amin'));
  check('the comment id never appears', !line.includes('cmt_secret'));
  check('the draft reply never appears', !line.includes('call 999'));
  check('operational signal survives', view.messageChars === CUSTOMER_TEXT.length && view.intent === 'hours');
  check('notify.js does not serialise the raw payload', !/JSON\.stringify\(info/.test(read('../src/notify.js')));
}

/* ============ 4. THE SANITIZERS THEMSELVES =========================== */
console.log('--- 4. sanitizer behaviour ---');
{
  check('redactId hides the value', !redactId(PSID).includes('PSID'));
  check('redactId is stable', redactId(PSID) === redactId(PSID));
  check('redactId differs per value', redactId(PSID) !== redactId('PSID-OTHER'));
  check('redactId handles empty', redactId('') === 'none' && redactId(null) === 'none');
  check('textSummary never returns the text',
    textSummary(CUSTOMER_TEXT).chars === CUSTOMER_TEXT.length &&
    !JSON.stringify(textSummary(CUSTOMER_TEXT)).includes('4111') &&
    !JSON.stringify(textSummary(CUSTOMER_TEXT)).includes('PSID'));
  check('safeErrorCode returns a code, not a message',
    safeErrorCode(new Error('secret provider detail')) !== 'secret provider detail');
  check('safeErrorCode prefers an explicit code', safeErrorCode({ code: 'ECONNRESET' }) === 'ECONNRESET');
}

/* ============ 5. THE CLASSIFIER OUTPUT IS SAFE TO LOG ================ */
console.log('--- 5. what the classifier returns is safe to log ---');
{
  const leaky = new Error(`Graph API 400: ${CUSTOMER_TEXT} token=${TOKEN}`);
  leaky.status = 400; leaky.graphCode = 100; leaky.isGraphError = true;
  const r = classifyDeliveryError(leaky);
  const dumped = JSON.stringify(r);
  check('the classification never echoes the provider message',
    !dumped.includes('4111') && !dumped.includes(TOKEN));
  check('the classification carries only fixed tokens',
    Object.values(r).every((v) => typeof v === 'string' || typeof v === 'boolean' || v === null));
  check('the category is from the fixed vocabulary',
    ['meta_rate_limit', 'meta_auth_expired', 'meta_permission', 'meta_api_error', 'delivery_unknown', null]
      .includes(r.category));
  check('the reason is a fixed internal token, not free text',
    /^[a-z0-9_]+$/.test(r.reason), r.reason);
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);