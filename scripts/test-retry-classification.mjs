/**
 * Retry-classification hardening — targeted tests for the unsafe fallback paths.
 *
 *   node scripts/test-retry-classification.mjs
 *
 * The rule under test:
 *   retryable === true  ONLY when a verified Graph error response carries an
 *   explicitly allow-listed throttling code (4 / 17 / 32 / 613) with a 4xx
 *   status. Nothing else may ever be retryable — not a bare HTTP 429, not a
 *   generic 4xx, not provider message text, not a malformed or contradictory
 *   error, and not a transport failure.
 *
 * Every adversarial case below is a way the OLD implementation (or a plausible
 * future one) could have re-sent a reply the customer already received.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync } from 'node:fs';
import {
  classifyDeliveryError,
  classifyUnstructuredError,
  isRetryableDeliveryRow,
  isRetryableDeliveryCategory,
  RETRYABLE_DELIVERY_CATEGORIES,
  DELIVERY_CATEGORY,
  DELIVERY_OUTCOME,
  GRAPH_CODE_POLICY
} from '../src/services/deliveryOutcome.js';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

/** Exactly what toGraphError() in src/facebook.js produces. */
const graph = (status, graphCode = null) => {
  const e = new Error(`Graph API ${status}${graphCode != null ? ` (code ${graphCode})` : ''}: simulated`);
  e.status = status; e.graphCode = graphCode; e.isGraphError = true;
  return e;
};
/** A raw Error whose message text mimics a provider response, but carries no
 *  structured fields — i.e. malformed as far as the classifier can tell. */
const bare = (msg) => new Error(msg);
const transport = () => Object.assign(new TypeError('fetch failed'), { isTransportError: true });

console.log('\nStage 8 — retry classification hardening\n');

/* ============ 1. THE ONLY RETRYABLE SHAPE ============================== */
console.log('--- 1. the allow-listed throttling codes are retryable ---');
for (const code of GRAPH_CODE_POLICY.throttling) {
  for (const status of [400, 429]) {
    const r = classifyDeliveryError(graph(status, code));
    check(`code ${code} + HTTP ${status} is retryable`,
      r.retryable === true && r.category === DELIVERY_CATEGORY.RATE_LIMIT &&
      r.deliveryStatus === 'failed' && r.outcome === DELIVERY_OUTCOME.NOT_DELIVERED_RETRYABLE,
      `${r.outcome}/${r.category}`);
  }
}
check('the allow-list is exactly the documented throttling codes',
  GRAPH_CODE_POLICY.throttling.join(',') === '4,17,32,613', GRAPH_CODE_POLICY.throttling.join(','));
check('only one category is ever re-sendable', RETRYABLE_DELIVERY_CATEGORIES.length === 1);

/* ============ 2. HTTP 429 ALONE IS NOT EVIDENCE ======================== */
console.log('\n--- 2. a bare HTTP 429 must not authorise a retry ---');
{
  const r = classifyDeliveryError(graph(429, null));
  check('429 with no Graph code is NOT retryable',
    r.retryable === false, `retryable=${r.retryable}`);
  check('429 with no code is recorded as a refusal (non-delivery confirmed)',
    r.outcome === DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT && r.deliveryStatus === 'failed');
  check('and it carries a category the retry gate refuses',
    !isRetryableDeliveryRow({ deliveryStatus: r.deliveryStatus, deliveryError: r.category }));

  const unknownCode = classifyDeliveryError(graph(429, 999));
  check('429 with an unrecognised code is NOT retryable', unknownCode.retryable === false);
}

/* ============ 3. GENERIC 4xx IS NOT EVIDENCE =========================== */
console.log('\n--- 3. a generic 4xx is a refusal, never a transient one ---');
for (const status of [400, 402, 404, 405, 409, 418, 422]) {
  const r = classifyDeliveryError(graph(status, null));
  check(`HTTP ${status} alone is not retryable`, r.retryable === false,
    `retryable=${r.retryable}`);
}
{
  const r = classifyDeliveryError(graph(400, 999));
  check('an unrecognised Graph code is not retryable', r.retryable === false);
  check('and it is still a confirmed refusal, not unknown',
    r.outcome === DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT);
}

/* ============ 4. MISLEADING FREE TEXT CANNOT ENABLE RETRY ============== */
console.log('\n--- 4. provider message text is never evidence ---');
{
  const liars = [
    'rate limit exceeded',
    'Too Many Requests',
    'Graph API 429: rate limit',
    'Graph API 400 (code 4)',
    'please retry: too many requests',
    'throttled, 429',
    'Graph API 4xx rate limit'
  ];
  for (const text of liars) {
    const r = classifyDeliveryError(bare(text));
    check(`bare text "${text.slice(0, 34)}" is not retryable`, r.retryable === false,
      `outcome=${r.outcome} category=${r.category}`);
  }
  // Even a perfectly throttling-looking message is UNKNOWN, not retryable.
  check('misleading text yields UNKNOWN, never retryable',
    classifyDeliveryError(bare('Graph API 429 (code 4): rate limit')).outcome === DELIVERY_OUTCOME.UNKNOWN);

  // The unstructured pass may still name a permanent refusal, never a retry.
  check('unstructured pass can name auth as permanent',
    classifyUnstructuredError(bare('Graph API 401: session expired')).category === DELIVERY_CATEGORY.AUTH_EXPIRED);
  check('unstructured pass can name permission as permanent',
    classifyUnstructuredError(bare('Graph API 403: permission')).category === DELIVERY_CATEGORY.PERMISSION);
  check('unstructured pass is structurally incapable of retrying',
    classifyUnstructuredError(bare('Graph API 429: rate limit, too many requests')).retryable === false &&
    !isRetryableDeliveryCategory(classifyUnstructuredError(bare('Graph API 429')).category));
}

/* ============ 5. CONFLICTING STATUS / CODE COMBINATIONS =============== */
console.log('\n--- 5. contradictory status/code pairs resolve to the safe answer ---');
{
  const cases = [
    ['429 + 190 (auth code on a throttle status)', graph(429, 190), DELIVERY_CATEGORY.AUTH_EXPIRED],
    ['429 + 200 (permission code on a throttle status)', graph(429, 200), DELIVERY_CATEGORY.PERMISSION],
    ['429 + 10 (permission code on a throttle status)', graph(429, 10), DELIVERY_CATEGORY.PERMISSION],
    ['400 + 102 (auth code)', graph(400, 102), DELIVERY_CATEGORY.AUTH_EXPIRED],
    ['403 + 190 (auth code on a permission status)', graph(403, 190), DELIVERY_CATEGORY.AUTH_EXPIRED]
  ];
  for (const [label, err, expectedCategory] of cases) {
    const r = classifyDeliveryError(err);
    check(label + ' -> ' + expectedCategory,
      r.retryable === false && r.category === expectedCategory,
      `${r.outcome}/${r.category}`);
  }
  // A success status carrying a throttle code is nonsense; treat as unknown.
  const contradictory = classifyDeliveryError(graph(200, 4));
  check('200 + throttle code is contradictory and NOT retryable',
    contradictory.retryable === false && contradictory.outcome === DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT,
    `${contradictory.outcome}/${contradictory.reason}`);
  const redirect = classifyDeliveryError(graph(302, 4));
  check('a 3xx on an error path is NOT retryable', redirect.retryable === false);
}

/* ============ 6. MALFORMED, TRANSPORT AND UNKNOWN ===================== */
console.log('\n--- 6. malformed and transport errors are never retryable ---');
{
  const malformed = [
    ['no fields at all', new Error('boom')],
    ['a string status', Object.assign(new Error('x'), { status: 'four hundred', isGraphError: true })],
    ['a NaN status', Object.assign(new Error('x'), { status: NaN, isGraphError: true })],
    ['a non-numeric graph code', Object.assign(new Error('x'), { status: 400, graphCode: 'four', isGraphError: true })],
    ['a transport failure', transport()],
    ['a transport failure with a cause code', Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })],
    ['an AbortError', Object.assign(new Error('x'), { name: 'AbortError' })],
    ['a 5xx', graph(500, 1)],
    ['a 503', graph(503, null)],
    ['an unverified object claiming a throttle', Object.assign(new Error('x'), { status: 400, graphCode: 4, isGraphError: false })],
    ['a hand-rolled object claiming 429+4', { status: 429, graphCode: 4, message: 'nope' }]
  ];
  for (const [label, err] of malformed) {
    const r = classifyDeliveryError(err);
    check(`${label} is not retryable`, r.retryable === false,
      `outcome=${r.outcome} reason=${r.reason}`);
  }
  check('an unverified object claiming a throttle is refused',
    classifyDeliveryError(Object.assign(new Error('x'), { status: 400, graphCode: 4, isGraphError: false })).reason !== 'documented_throttle_code');
  check('a plain object with no Error shape is refused',
    classifyDeliveryError({ status: 429, graphCode: 4 }).retryable === false);
}

/* ============ 7. PERMANENT HANDLING PRESERVED ========================= */
console.log('\n--- 7. permanent refusals still classify precisely ---');
for (const code of GRAPH_CODE_POLICY.auth) {
  check(`auth code ${code} is permanent auth`,
    classifyDeliveryError(graph(401, code)).category === DELIVERY_CATEGORY.AUTH_EXPIRED);
}
for (const code of GRAPH_CODE_POLICY.permission) {
  check(`permission code ${code} is permanent permission`,
    classifyDeliveryError(graph(403, code)).category === DELIVERY_CATEGORY.PERMISSION);
}
{
  const r = classifyDeliveryError(graph(500, 190));
  check('a 5xx is UNKNOWN even when the code is a known auth code',
    r.outcome === DELIVERY_OUTCOME.UNKNOWN, `${r.outcome}/${r.category}`);
}

/* ============ 8. NO OUTCOME ESCAPES THE SCHEMA ======================== */
console.log('\n--- 8. every outcome stays inside the existing CHECK constraint ---');
{
  const all = [
    null, graph(400, 4), graph(401, 190), graph(403, 200), graph(429, null),
    graph(500, 1), graph(418, 999), transport(), new Error('x'), { status: 302 }
  ];
  check('delivery_status is always one of pending / sent / failed',
    all.every((e) => ['pending', 'sent', 'failed'].includes(classifyDeliveryError(e).deliveryStatus)));
  const retryables = all.filter((e) => classifyDeliveryError(e).retryable);
  check('only the documented throttling shape is retryable in this sample',
    retryables.length === 1 && retryables[0].graphCode === 4 && retryables[0].status === 400,
    JSON.stringify(retryables.map((e) => [e.status, e.graphCode])));
  check('every category is from the fixed vocabulary',
    all.every((e) => {
      const c = classifyDeliveryError(e).category;
      return c === null || Object.values(DELIVERY_CATEGORY).includes(c);
    }));
  check('every classification carries a diagnostic reason',
    all.every((e) => typeof classifyDeliveryError(e).reason === 'string'));
}

/* ============ 9. THE ROW GATE MIRRORS THE CLASSIFIER =================== */
console.log('\n--- 9. the row-level gate accepts only a retryable category ---');
{
  check('failed + meta_rate_limit is retryable',
    isRetryableDeliveryRow({ deliveryStatus: 'failed', deliveryError: 'meta_rate_limit' }) === true);
  for (const row of [
    { deliveryStatus: 'failed', deliveryError: 'meta_auth_expired' },
    { deliveryStatus: 'failed', deliveryError: 'meta_permission' },
    { deliveryStatus: 'failed', deliveryError: 'meta_api_error' },
    { deliveryStatus: 'failed', deliveryError: 'delivery_unknown' },
    { deliveryStatus: 'failed', deliveryError: null },
    { deliveryStatus: 'pending', deliveryError: 'meta_rate_limit' },
    { deliveryStatus: 'pending', deliveryError: 'delivery_unknown' },
    { deliveryStatus: 'sent', deliveryError: null },
    { deliveryStatus: 'dlq', deliveryError: 'meta_rate_limit' },
    {}
  ]) {
    check(`refused: ${row.deliveryStatus}/${row.deliveryError}`,
      isRetryableDeliveryRow(row) === false, JSON.stringify(row));
  }
}

/* ============ 10. THE SOURCE HAS NO UNSAFE FALLBACK =================== */
console.log('\n--- 10. no code path can reach retryable from free text ---');
{
  const src = readFileSync(new URL('../src/services/deliveryOutcome.js', import.meta.url), 'utf8');
  // Bound the scan to the classifier body only. The unstructured pass and the
  // module header deliberately MENTION rate limiting in comments and in the
  // patterns they refuse to treat as evidence.
  const start = src.indexOf('export function classifyDeliveryError');
  const end = src.indexOf('export function classifyUnstructuredError');
  const retryFn = src.slice(start, end);
  const bodyOnly = retryFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  check('only one function can return retryable', (src.match(/=>\s*retryable\(\)|return retryable\(\)/g) || []).length === 1);
  check('the retryable branch requires a verified Graph response',
    /err\.isGraphError === true/.test(retryFn));
  check('the retryable branch requires an allow-listed code',
    /THROTTLE_GRAPH_CODES\.has\(graphCode\)/.test(retryFn));
  check('the retryable branch requires a 4xx status',
    /status >= 400 &&\s*\n?\s*status < 500/.test(retryFn));
  check('no rate-limit / too-many-requests regex exists in the classifier body',
    !/rate limit|too many requests/i.test(bodyOnly));
  check('the classifier does not inspect message text at all',
    !/\.message/.test(bodyOnly));
  check('the unstructured pass cannot reach retryable',
    !/retryable\(\)/.test(src.slice(src.indexOf('export function classifyUnstructuredError'))));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);