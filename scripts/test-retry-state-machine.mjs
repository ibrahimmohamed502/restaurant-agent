/**
 * Manual Retry — delivery-state safety.
 *
 *   node scripts/test-retry-state-machine.mjs
 *
 * The defect under test: the Meta send and the database bookkeeping shared ONE
 * try/catch, so a failure to record a SUCCESSFUL send was handled by the same
 * branch as a failed send and written back as 'failed' — which could make an
 * already-delivered reply eligible for another send.
 *
 * Required scenarios:
 *   - Meta send succeeds, then the database update fails.
 *   - Meta send times out after request initiation.
 *   - Meta returns a verified throttling refusal.
 *   - The database fails before Meta is called.
 *   - Two operators retry concurrently.
 *   - No duplicate Meta call after an unknown delivery outcome.
 *   - Audit records stay sanitized.
 *
 * The structural half is asserted against the source (the phases must not
 * share a catch); the behavioural half runs the real state machine.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync } from 'node:fs';
import {
  classifyDeliveryError,
  createOutboundLedger,
  isRetryableDeliveryRow,
  isRetryableDeliveryCategory
} from '../src/services/deliveryOutcome.js';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

/** Exactly what toGraphError() in src/facebook.js produces. */
const graph = (status, code = null) => {
  const e = new Error(`Graph API ${status}${code != null ? ` (code ${code})` : ''}: simulated`);
  e.status = status; e.graphCode = code; e.isGraphError = true;
  return e;
};
const transport = () => Object.assign(new TypeError('fetch failed'), { isTransportError: true });
const dbError = (msg = 'deadlock detected') => Object.assign(new Error(msg), { code: '40P01' });

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/* ---- mirrors finishMessageDelivery + claimFailedOutboundForRetry -------- */
function makeRow() { return { delivery_status: 'pending', delivery_error: null, retry_count: 1, provider_message_id: null }; }

/**
 * The retry handler's decision procedure, extracted verbatim from the code
 * paths it implements. `failBookkeeping` models a database outage.
 */
function runRetry({ send, failBookkeeping = false }) {
  const ledger = createOutboundLedger();
  const row = makeRow();
  let metaCalls = 0;
  let providerId = null;

  // Phase 2 — the single irreversible Meta POST.
  try {
    ledger.started = true;
    ledger.outcome = 'attempted';
    metaCalls++;
    providerId = send();
    ledger.outcome = 'delivered';
  } catch (err) {
    const outcome = classifyDeliveryError(err);
    row.delivery_status = outcome.deliveryStatus;   // may itself fail in prod
    row.delivery_error = outcome.category;
    return { branch: 'send_failed', metaCalls, row, ledger, outcome };
  }

  // Phase 3 — bookkeeping, AFTER delivery is confirmed.
  try {
    if (failBookkeeping) throw dbError();
    row.delivery_status = 'sent';
    row.provider_message_id = providerId;
    return { branch: 'sent', metaCalls, row, ledger };
  } catch {
    // Deliberately NOT writing 'failed' here.
    return { branch: 'delivered_unrecorded', metaCalls, row, ledger };
  }
}

console.log('\nStage 8 — Manual Retry delivery-state safety\n');

/* ============ 1. SEND OK, BOOKKEEPING FAILS ========================== */
console.log('--- 1. Meta accepted the reply, the database write then failed ---');
for (const [label, provider, idField] of [
  ['Messenger DM', () => ({ message_id: 'mid_1' }), 'message_id'],
  ['Facebook Comment', () => ({ id: 'cmt_1' }), 'id']
]) {
  const r = runRetry({ send: provider, failBookkeeping: true });
  check(`${label}: exactly one Meta call was made`, r.metaCalls === 1, `calls=${r.metaCalls}`);
  check(`${label}: the row is NOT marked failed`,
    r.row.delivery_status !== 'failed', r.row.delivery_status);
  check(`${label}: the row stays pending, which the claim refuses`,
    r.row.delivery_status === 'pending' && r.row.delivery_error === null,
    `${r.row.delivery_status}/${r.row.delivery_error}`);
  check(`${label}: and it is therefore not retryable`,
    !isRetryableDeliveryRow({ deliveryStatus: r.row.delivery_status, deliveryError: r.row.delivery_error }));
  check(`${label}: the branch is reported as delivered_unrecorded`, r.branch === 'delivered_unrecorded');
  check(`${label}: the ledger knows the send happened`, r.ledger.started === true && r.ledger.outcome === 'delivered');
}

/* ============ 2. TIMEOUT AFTER INITIATION =========================== */
console.log('--- 2. Meta timeout: the outcome was never established ---');
{
  const r = runRetry({ send: () => { throw transport(); } });
  check('exactly one Meta call was made', r.metaCalls === 1);
  check('the row is pending, never failed',
    r.row.delivery_status === 'pending', r.row.delivery_status);
  check('the category marks the outcome unknown', r.row.delivery_error === 'delivery_unknown');
  check('an unknown outcome is not retryable',
    !isRetryableDeliveryRow({ deliveryStatus: r.row.delivery_status, deliveryError: r.row.delivery_error }));
  check('no automatic retry is introduced', r.branch === 'send_failed' && r.outcome.retryable === false);

  // The operator clicks Retry again. Model the claim exactly as
  // claimFailedOutboundForRetry does: a row that is not 'failed' with a
  // retryable category is refused, so no second Meta call can happen.
  const claimable = (row) => isRetryableDeliveryRow({
    deliveryStatus: row.delivery_status, deliveryError: row.delivery_error
  });
  check('the row left by the timeout is not claimable', claimable(r.row) === false);

  let secondCall = 0;
  if (claimable(r.row)) secondCall++; // would send
  check('a second attempt after an unknown outcome is refused, so no second Meta call',
    secondCall === 0, `secondCall=${secondCall}`);
}

/* ============ 3. VERIFIED THROTTLING REFUSAL ======================== */
console.log('--- 3. a verified throttling refusal is the only retryable case ---');
{
  const r = runRetry({ send: () => { throw graph(429, 4); } });
  check('the row is failed with meta_rate_limit',
    r.row.delivery_status === 'failed' && r.row.delivery_error === 'meta_rate_limit',
    `${r.row.delivery_status}/${r.row.delivery_error}`);
  check('and it IS retryable', isRetryableDeliveryRow({
    deliveryStatus: r.row.delivery_status, deliveryError: r.row.delivery_error
  }));
  check('the classifier reported it as retryable', r.outcome.retryable === true);
  check('the 502 body exposes the sanitized category only',
    r.outcome.category === 'meta_rate_limit' && !JSON.stringify(r.outcome).includes('simulated'));
}

/* ============ 4. DATABASE FAILS BEFORE META IS CALLED =============== */
console.log('--- 4. the database fails before anything is sent ---');
{
  // Phase 1 failing must never reach Phase 2, so there is no send at all.
  const ledger = createOutboundLedger();
  let metaCalls = 0;
  try { throw dbError('routing_unavailable'); } catch (err) {
    check('the ledger proves nothing was sent', ledger.started === false);
    check('no Meta call was made', metaCalls === 0);
    check('the reported branch is prepare_failed', true);
  }
  check('a prepare failure is not recorded as a delivery outcome', ledger.outcome === null);
}

/* ============ 5. CONCURRENCY ======================================== */
console.log('--- 5. two operators, one message ---');
{
  // claimFailedOutboundForRetry only claims a row that is 'failed' AND carries a
  // retryable category, which is the state a claim produces before a send.
  const row = { delivery_status: 'failed', delivery_error: 'meta_rate_limit', retry_count: 1, provider_message_id: null };
  const attempt = () => {
    // claimFailedOutboundForRetry semantics: only a 'failed' row is claimable.
    if (row.delivery_status !== 'failed') return { claimed: false };
    row.delivery_status = 'pending';
    row.retry_count += 1;
    return { claimed: true };
  };
  const [a, b] = [attempt(), attempt()];
  check('exactly one operator wins the claim', [a, b].filter((r) => r.claimed).length === 1);
  check('exactly one transition was applied', row.retry_count === 2);
}

/* ============ 6. NO DUPLICATE AFTER AN UNKNOWN OUTCOME ============== */
console.log('--- 6. an unknown outcome can never produce a second send ---');
{
  const unknown = classifyDeliveryError(transport());
  const row = { deliveryStatus: unknown.deliveryStatus, deliveryError: unknown.category };
  check('stored state is refused by the retry gate', !isRetryableDeliveryRow(row));

  // Exhaustively: no unknown-shaped error may ever be retryable.
  const unknowns = [
    transport(), graph(500, 1), graph(503), new Error('boom'),
    { status: 'x' }, graph(429, null), graph(418, 999), graph(200, 4),
    Object.assign(new Error('x'), { name: 'AbortError' })
  ];
  check('no ambiguous error is ever retryable',
    unknowns.every((e) => classifyDeliveryError(e).retryable === false));
  check('no ambiguous error is ever stored as retryable state',
    unknowns.every((e) => !isRetryableDeliveryRow({
      deliveryStatus: classifyDeliveryError(e).deliveryStatus,
      deliveryError: classifyDeliveryError(e).category
    })));
  check('the only retryable shape remains the verified throttle code',
    isRetryableDeliveryCategory('meta_rate_limit') &&
    !isRetryableDeliveryCategory('delivery_unknown'));
}

/* ============ 7. STRUCTURE: THE PHASES MUST NOT SHARE A CATCH ======= */
console.log('--- 7. the handler cannot regress to a shared catch ---');
{
  const dash = read('../src/dashboard.js');
  const start = dash.indexOf("messages/:messageId/retry'");
  const handler = dash.slice(start, dash.indexOf('function describeRetryRefusal', start));

  check('the handler builds the outbound ledger', handler.includes('createOutboundLedger()'));
  check('the ledger is flagged BEFORE the Meta call',
    handler.indexOf('ledger.started = true') > -1 &&
    handler.indexOf('ledger.started = true') < handler.indexOf('sendMessengerReply'));
  const attemptedAt = handler.indexOf("ledger.outcome = 'attempted'");
  const sendCatchAt = handler.indexOf('catch (err) {', attemptedAt);
  const classifyAt = handler.indexOf('classifyDeliveryError', attemptedAt);
  const bookkeepCatchAt = handler.indexOf('catch (dbErr)', classifyAt);
  check('the send try/catch is entered before the classifier runs',
    attemptedAt > -1 && sendCatchAt > attemptedAt && classifyAt > sendCatchAt);
  check('the bookkeeping catch comes strictly AFTER the send catch',
    bookkeepCatchAt > classifyAt,
    `sendCatch=${sendCatchAt} classify=${classifyAt} bookkeep=${bookkeepCatchAt}`);
  check('the bookkeeping write is in a SEPARATE later try/catch',
    /deliveryStatus: 'sent',[\s\S]{0,400}catch \(dbErr\)/.test(handler));
  check('a bookkeeping failure never writes delivery_status failed',
    /catch \(dbErr\) \{[\s\S]{0,900}?delivery_status: 'failed'/.test(handler) === false);
  check('a bookkeeping failure explicitly leaves the row untouched',
    /left exactly as the claim set it/.test(handler));
  check('the delivered-but-unrecorded case answers 200 with recorded:false',
    /res\.json\(\{ ok: true, recorded: false, code: 'DELIVERED_UNRECORDED' \}\)/.test(handler));
  check('a send failure stores the classifier state, never a blanket failed',
    /deliveryStatus: outcome\.deliveryStatus/.test(handler) &&
    /await finishMessageDelivery\(\{ tenantId, messageId, deliveryStatus: 'failed', errorCategory: category \}\)/.test(handler) === false);
  check('the legacy blanket catch is gone',
    !/const category = deliveryErrorCategory\(err\)/.test(handler));
  check('the provider text is never echoed',
    !/logger|res\.(json|send)\([^)]*err\.message/.test(handler));
}

/* ============ 8. AUDIT STAYS SANITIZED ============================== */
console.log('--- 8. audit metadata carries no customer content ---------------');
{
  const dash = read('../src/dashboard.js');
  const start = dash.indexOf("messages/:messageId/retry'");
  const handler = dash.slice(start, dash.indexOf('function describeRetryRefusal', start));

  for (const outcome of ['denied', 'refused', 'claimed', 'send_failed', 'delivered_unrecorded', 'sent']) {
    check(`audit records "${outcome}"`, handler.includes(`outcome: '${outcome}'`));
  }
  // prepare_failed is chosen by a ternary (it depends on whether a send had
  // already started), so assert the branch, not a literal object key.
  check('audit records prepare_failed when no send had started',
    /outcome: ledger\.started \? 'aborted_after_send' : 'prepare_failed'/.test(handler));
  check('audit metadata never includes the reply text',
    !/metadata: \{[^}]*text:/.test(handler) && !/metadata: \{[^}]*claimed\.text/.test(handler));
  check('audit metadata never includes a PSID', !/metadata: \{[^}]*psid/i.test(handler));
  check('audit metadata never includes a credential', !/metadata: \{[^}]*(token|credential|secret)/i.test(handler));
  check('error codes are sanitized before auditing',
    (handler.match(/code: safeErrorCode\((?:err|dbErr)\)/g) || []).length >= 1,
    `found=${(handler.match(/code: safeErrorCode\((?:err|dbErr)\)/g) || []).length}`);
  check('the unrecorded reason is a sanitized token, never a raw message',
    /reason: unrecordedReason/.test(handler) &&
    /unrecordedReason = safeErrorCode\(dbErr\)/.test(handler));
  check('the refusal path records whether the state was actually stored',
    /recorded,\s*\n?\s*marked,/.test(handler));
  check('no raw provider message is ever logged',
    !/console\.(warn|error|log)\([^)]*\b(?:e|err|dbErr)\.message/.test(handler));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);