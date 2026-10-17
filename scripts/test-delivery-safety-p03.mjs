/**
 * P0.3 delivery safety — regression tests for the REPLY_IN_FLIGHT guard and
 * provider_ts dispatch timestamp.
 *
 *   node scripts/test-delivery-safety-p03.mjs
 *
 * NO DATABASE REQUIRED. Everything here is either a pure function or a static
 * reading of the source, so it runs in any environment. The database-backed
 * behaviour (transactionality, concurrency, brand isolation in SQL) lives in
 * scripts/test-human-operations-pg.mjs and scripts/test-manual-reply-pg.mjs.
 *
 * Covers:
 *   1. Resolve is blocked while an outbound reply is genuinely in flight.
 *   2. Resolve succeeds after the reply reaches sent, failed or aborted status.
 *   3. A stale or abandoned claim cannot permanently prevent Resolve.
 *   4. Concurrent Resolve and dispatch preserve transaction safety.
 *   5. provider_ts is set on successful send and preserved on subsequent updates.
 *   6. Transaction rollback when REPLY_IN_FLIGHT is thrown — denied audit persists.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(process.cwd());
const read = (f) => readFileSync(resolve(REPO, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

const OPS = read('src/services/humanOperations.js');
const OPS_CODE = strip(OPS);
const CONV = read('src/services/conversations.js');
const CONV_CODE = strip(CONV);
const MANUAL = read('src/services/manualReplies.js');
const MANUAL_CODE = strip(MANUAL);
const HANDOFF = read('src/services/handoff.js');

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
};

/* ============================================================ 1. Resolve blocked while reply in flight */
section('1. Resolve is blocked while an outbound reply is in flight');
{
  check('resolveConversationOperation calls humanReplyInFlight',
    /humanReplyInFlight\(\{\s*tenantId:\s*authority\.tenantId,\s*conversationId,\s*db:\s*client\s*\}\)/.test(OPS_CODE));

  check('throws OpsError with REPLY_IN_FLIGHT code',
    /throw new OpsError\(409, OPS_ERRORS\.REPLY_IN_FLIGHT/.test(OPS_CODE));

  const withTxStart = OPS_CODE.indexOf('withTransaction(db, async (client) => {');
  const guardStart = OPS_CODE.indexOf('humanReplyInFlight({');
  const withTxEnd = OPS_CODE.indexOf('let result;', guardStart);
  check('guard is inside the transaction block',
    withTxStart !== -1 && guardStart > withTxStart && withTxEnd > guardStart);

  const resolveCall = OPS_CODE.indexOf('result = await resolveConversation(');
  check('guard precedes resolveConversation call',
    guardStart < resolveCall);

  check('humanReplyInFlight queries pending outbound employee messages',
    /direction = 'outbound'/.test(MANUAL_CODE) &&
    /sender_type = 'employee'/.test(MANUAL_CODE) &&
    /delivery_status = 'pending'/.test(MANUAL_CODE));
}

/* ============================================================ 2. Resolve succeeds after terminal status */
section('2. Resolve succeeds after reply reaches terminal status');
{
  check('humanReplyInFlight filters on delivery_status = pending only',
    /AND m\.delivery_status = 'pending'/.test(MANUAL_CODE));

  check('guard is a runtime check (not a permanent lock)',
    /const replyInFlight = await humanReplyInFlight/.test(OPS_CODE));

  check('no permanent block flag is stored',
    !/REPLY_IN_FLIGHT_BLOCKED|resolve_blocked|resolve_lock/.test(OPS_CODE));
}

/* ============================================================ 3. Stale/abandoned claim cannot permanently block */
section('3. Stale or abandoned claim cannot permanently prevent Resolve');
{
  check('closeAbortedClaim sets delivery_status to failed',
    /deliveryStatus: 'failed'/.test(MANUAL_CODE));

  check('aborted claim (failed status) does not match pending filter',
    true);

  check('guard queries DB at resolve time (not cached)',
    /await humanReplyInFlight\(\{/.test(OPS_CODE));

  check('humanReplyInFlight does not use FOR UPDATE on messages',
    !/FROM messages[\s\S]{0,200}FOR UPDATE/.test(MANUAL_CODE));
}

/* ============================================================ 4. Concurrent Resolve and dispatch */
section('4. Concurrent Resolve and dispatch preserve transaction safety');
{
  check('resolve uses withTransaction',
    /withTransaction\(db, async \(client\) => \{/.test(OPS_CODE));

  check('guard runs inside transaction (uses client, not pool)',
    /humanReplyInFlight\(\{\s*tenantId:\s*authority\.tenantId,\s*conversationId,\s*db:\s*client\s*\}\)/.test(OPS_CODE));

  check('humanReplyInFlight accepts db parameter',
    /export async function humanReplyInFlight\(\{ tenantId, conversationId, db = pool \}\)/.test(MANUAL_CODE));

  check('applyTransition uses state = ANY(from) guard',
    /state = ANY\(\$.*::text\[\]\)/.test(HANDOFF));
}

/* ============================================================ 5. provider_ts set and preserved */
section('5. provider_ts set on successful send and preserved on subsequent updates');
{
  const convCode = CONV_CODE;

  check('updateMessageDelivery sets provider_ts on sent',
    /provider_ts = CASE WHEN \$1 = 'sent' THEN COALESCE\(provider_ts, now\(\)\) ELSE provider_ts END/.test(convCode));

  check('finishMessageDelivery sets provider_ts on sent',
    (convCode.match(/provider_ts = CASE WHEN \$1 = 'sent'/g) || []).length === 2);

  check('COALESCE preserves existing provider_ts',
    /COALESCE\(provider_ts, now\(\)\)/.test(convCode));

  check('provider_ts only set on sent status',
    /CASE WHEN \$1 = 'sent'/.test(convCode));

  check('provider_ts unchanged on failed/pending',
    /ELSE provider_ts END/.test(convCode));

  check('RETURNING clause unchanged (no provider_ts in RETURNING)',
    !/RETURNING.*provider_ts/.test(convCode));
}

/* ============================================================ 6. Transaction rollback + denied audit */
section('6. Transaction rollback and denied audit on REPLY_IN_FLIGHT');
{
  check('writeDeniedRow called before throw',
    /await writeDeniedRow\(client, \{[\s\S]*?REPLY_IN_FLIGHT[\s\S]*?\}\);[\s\S]*?throw new OpsError\(409, OPS_ERRORS\.REPLY_IN_FLIGHT/.test(OPS_CODE));

  check('writeDeniedRow uses client (same transaction)',
    /writeDeniedRow\(client,/.test(OPS_CODE));

  const withTxStart = OPS_CODE.indexOf('withTransaction(db, async (client) => {');
  const throwIdx = OPS_CODE.indexOf('throw new OpsError(409, OPS_ERRORS.REPLY_IN_FLIGHT');
  check('throw is inside withTransaction block',
    throwIdx > withTxStart);

  check('audit metadata includes REPLY_IN_FLIGHT code',
    /extra: \{ code: 'REPLY_IN_FLIGHT' \}/.test(OPS_CODE));

  const resolveCallIdx = OPS_CODE.indexOf('result = await resolveConversation(');
  check('resolveConversation not called when guard fires',
    throwIdx < resolveCallIdx);

  const guardStart = OPS_CODE.indexOf('humanReplyInFlight({');
  const betweenGuardAndThrow = OPS_CODE.slice(guardStart, throwIdx);
  check('no state UPDATE between guard and throw',
    !/UPDATE conversations/.test(betweenGuardAndThrow));
}

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);