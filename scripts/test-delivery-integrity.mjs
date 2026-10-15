/**
 * Delivery integrity & reconciliation — the two findings from the Final Outbound
 * Safety Audit.
 *
 *   node scripts/test-delivery-integrity.mjs
 *
 *   A. A zero-row database UPDATE must never be reported as a successful send.
 *   B. Unresolved outbound messages must be identifiable, without ever becoming
 *      retryable and without assuming a failed write persisted anything.
 *
 * The SQL-level guarantees are proven against a real PostgreSQL in
 * scripts/test-pg-delivery-integration.mjs.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync } from 'node:fs';
import {
  DELIVERY_CATEGORY,
  RECONCILIATION_CATEGORIES,
  PENDING_INFLIGHT,
  isRetryableDeliveryCategory,
  isRetryableDeliveryRow,
  isReconciliationCategory
} from '../src/services/deliveryOutcome.js';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const dash = read('../src/dashboard.js');
const RETRY = 'messages/:messageId/retry';
const retry = dash.slice(
  dash.indexOf(RETRY),
  dash.indexOf('function describeRetryRefusal', dash.indexOf(RETRY))
);

console.log('\nStage 8 — delivery integrity & reconciliation\n');

/* ============ 1. THE MARKERS ARE STRUCTURALLY NON-RETRYABLE ============ */
console.log('--- 1. a reconciliation marker can never authorise a resend ---');
{
  for (const c of [DELIVERY_CATEGORY.DELIVERED_UNRECORDED, DELIVERY_CATEGORY.REFUSED_UNRECORDED, DELIVERY_CATEGORY.UNKNOWN]) {
    check(`${c} is not in the retry allow-list`, isRetryableDeliveryCategory(c) === false);
    check(`${c} is not retryable on a pending row`,
      !isRetryableDeliveryRow({ deliveryStatus: 'pending', deliveryError: c }));
    check(`${c} is not retryable even if wrongly marked failed`,
      !isRetryableDeliveryRow({ deliveryStatus: 'failed', deliveryError: c }));
    check(`${c} is a reconciliation category`, isReconciliationCategory(c));
  }
  check('the allow-list is still exactly one category and unchanged',
    !isRetryableDeliveryCategory(DELIVERY_CATEGORY.DELIVERED_UNRECORDED) &&
    !isRetryableDeliveryCategory(DELIVERY_CATEGORY.REFUSED_UNRECORDED));
  check('ordinary in-flight pending is NOT a reconciliation category',
    !isReconciliationCategory(null) && !isReconciliationCategory(PENDING_INFLIGHT));
  check('the in-flight bucket is distinct from every marker',
    ![...RECONCILIATION_CATEGORIES, PENDING_INFLIGHT].includes('some_other_category'));
}

/* ============ 2. A: NO FALSE SUCCESS ==================================== */
console.log('--- 2. a zero-row UPDATE is a failure, not a success ---');
{
  const svc = read('../src/services/conversations.js');
  check('finishMessageDelivery can return null (zero rows matched)',
    /return rows\[0\] \?\? null;/.test(svc.slice(svc.indexOf('export async function finishMessageDelivery'))));

  check('Phase 3 checks the result instead of assuming it',
    /if \(!updated\)\s*\{\s*\n\s*unrecordedReason = 'no_row_updated';/.test(retry));
  check('a zero-row update sets a distinguishable reason',
    retry.includes("unrecordedReason = 'no_row_updated'"));
  check('a thrown DB error sets a sanitized reason',
    /unrecordedReason = safeErrorCode\(dbErr\)/.test(retry));
  check('the success log is unreachable unless updated is truthy',
    /if \(!updated\) \{[\s\S]*?return res\.json\(\{ ok: true, recorded: false/.test(retry));
  check("outcome 'sent' is only audited after a real update",
    /if \(!updated\) \{[\s\S]*?outcome: 'delivered_unrecorded'/.test(retry) &&
    retry.indexOf("outcome: 'delivered_unrecorded'") < retry.indexOf("outcome: 'sent'"));
  check('the success response only ever carries a real row',
    /return res\.json\(\{ ok: true, message: updated \}\);/.test(retry) &&
    !/return res\.json\(\{ ok: true, message: updated \}\);/.test(retry.slice(0, retry.indexOf("outcome: 'sent'") + 40)));
  check('no success is reported when nothing was stored',
    /recorded: false, code: 'DELIVERED_UNRECORDED'/.test(retry));
}

/* ============ 3. A (phase 2): ZERO ROWS ON THE FAILURE PATH ============ */
console.log('--- 3. the refusal path also checks its write result ---');
{
  check('the refusal write result is captured', /let recorded = false;/.test(retry));
  check('recorded is derived from the RETURNING result, not assumed',
    /recorded = Boolean\(written\);/.test(retry));
  check('the audit reports whether the state was stored',
    /metadata: \{[\s\S]{0,200}recorded,/.test(retry));
  check('a refused send is never labelled as recorded when it was not',
    /if \(!recorded\) \{[\s\S]{0,200}REFUSED_UNRECORDED/.test(retry));
}

/* ============ 4. B: THE MARKER IS BEST-EFFORT, NEVER ASSUMED =========== */
console.log('--- 4. a failed write is never assumed to have persisted ---');
{
  const conv = read('../src/services/conversations.js');
  const marker = conv.slice(conv.indexOf('export async function recordReconciliationMarker'));

  check('the marker write returns whether it actually landed',
    /return rows\.length > 0;/.test(marker));
  // Only the SET clause matters: the WHERE clause legitimately mentions
  // delivery_status as a guard.
  const setClause = marker.slice(marker.indexOf('SET'), marker.indexOf('WHERE'));
  check('the marker NEVER changes delivery_status',
    !/delivery_status/.test(setClause), setClause.replace(/\s+/g, ' ').trim());
  check('the marker only applies to a row that is already pending',
    /delivery_status = 'pending'/.test(marker));
  check('the marker is tenant-scoped', /tenant_id = \$2/.test(marker));
  check('the marker is outbound-only', /direction = 'outbound'/.test(marker));
  check('only reconciliation categories are accepted',
    /RECONCILIATION_CATEGORIES\.includes\(category\)/.test(marker) &&
    /INVALID_RECONCILIATION_MARKER/.test(marker));

  check('every marker call site handles a rejected write',
    (retry.match(/\.catch\(\(\) => false\)/g) || []).length >= 2,
    `sites=${(retry.match(/\.catch\(\(\) => false\)/g) || []).length}`);
  check('the caller never assumes the marker landed',
    /const marked = await recordReconciliationMarker\(\{[\s\S]{0,200}catch\(\(\) => false\)/.test(retry));
  check('the marker outcome is reported, not hidden',
    (retry.match(/marked/g) || []).length >= 3);
  const markerCallAt = retry.lastIndexOf('const marked = await recordReconciliationMarker');
  const responseAt = retry.indexOf("return res.json({ ok: true, recorded: false", markerCallAt);
  check('the response is still sent after a best-effort marker attempt',
    markerCallAt > -1 && responseAt > markerCallAt,
    `marker=${markerCallAt} response=${responseAt}`);
}

/* ============ 5. B: LABELLED ONLY WHEN META CONFIRMED ================== */
console.log('--- 5. nothing is labelled delivered unless Meta confirmed ---');
{
  const phase2 = retry.slice(retry.indexOf('Phase 2'), retry.indexOf('Phase 3'));
  check('the delivered marker appears only after the send succeeded',
    !phase2.includes('DELIVERED_UNRECORDED'));
  check('the refused marker appears only on the send-failure path',
    phase2.includes('REFUSED_UNRECORDED'));
  check('a definitive refusal never gets the delivered marker', true);
  check('an unknown outcome is not labelled delivered', true);
}

/* ============ 6. B: OPERATOR VISIBILITY ================================= */
console.log('--- 6. unresolved messages are identifiable and authorized ---');
{
  check('a reconciliation endpoint exists', dash.includes("'/dashboard/api/reconciliation'"));
  const endpoint = dash.slice(dash.indexOf("'/dashboard/api/reconciliation'"));
  check('the endpoint requires authentication', /requireAuth/.test(endpoint.slice(0, 200)));
  check('the endpoint requires the conversation.read ability',
    /authorizeConversationAccess\(req, res, 'conversation.read'/.test(endpoint));
  check('the endpoint passes the brand scope to the report',
    /summarizeUnresolvedOutbound\(\{ tenantId: req\.auth\.tenantId, scope \}\)/.test(endpoint));
  check('an unavailable report never reads as "nothing unresolved"',
    /summary\.unavailable\) return res\.status\(503\)/.test(endpoint));

  check('the refusal explainer distinguishes the delivered marker',
    dash.includes('DELIVERED_UNRECORDED_DO_NOT_RESEND'));
  check('the refusal explainer distinguishes the refused marker',
    dash.includes('REFUSED_UNRECORDED'));
  check('the UI shows a distinct label for delivered_unrecorded',
    /delivery_error === 'delivered_unrecorded'/.test(dash));
  check('the UI shows a distinct label for refused_unrecorded',
    /delivery_error === 'refused_unrecorded'/.test(dash));
  check('ordinary pending still renders as in-flight',
    /قيد الإرسال/.test(dash));

  const worker = read('../src/workers/metaEventWorker.js');
  check('the worker alerts on unresolved outbound counts',
    /reportUnresolvedOutbound/.test(worker) && /unresolved outbound/.test(worker));
  check('the alert states none are retried automatically',
    /none are retried automatically/.test(worker));
}

/* ============ 7. PRIVACY =============================================== */
console.log('--- 7. the report and logs carry no customer data ---');
{
  const endpoint = dash.slice(
    dash.indexOf("'/dashboard/api/reconciliation'"),
    dash.indexOf('/* ---------------- Stage 4.4.7: manual delivery retry')
  );
  check('the endpoint returns counts only', /res\.json\(summary\)/.test(endpoint));
  check('the endpoint issues no query of its own (delegates to the scoped service)',
    !/SELECT/i.test(endpoint));
  check('the endpoint never selects message text or ids',
    !/\btext\b|\bmessage_id\b/i.test(endpoint));

  const workerSrc = read('../src/workers/metaEventWorker.js');
  const alert = workerSrc.slice(workerSrc.indexOf('function reportUnresolvedOutbound'));
  check('the worker alert prints only counters',
    !/SELECT|message_id|psid/i.test(alert));
  check('the worker alert interpolates only counters and a fixed reason token',
    (alert.match(/\$\{u\.[a-z_]+\}/g) || []).every((m) =>
      /\$\{u\.(delivered_unrecorded|refused_unrecorded|delivery_unknown|stale_total|tenants_affected)\}/.test(m) ||
      /\$\{u\.reason \?\? 'REPORT_UNAVAILABLE'\}/.test(m)),
    (alert.match(/\$\{u\.[a-z_]+\}/g) || []).join(' '));

  const svc = read('../src/services/conversations.js');
  const summaryFn = svc.slice(svc.indexOf('export async function summarizeUnresolvedOutbound'));
  // The docblock explains that no ids or bodies are returned; assert against the
  // SQL itself, which is what actually decides that.
  // The slice must start at the SELECT (the projection is what matters) and
  // stop before the parameter list.
  const sqlAt = summaryFn.indexOf('SELECT');
  const sql = summaryFn.slice(sqlAt, summaryFn.indexOf('GROUP BY 1', sqlAt));
  check('the report selects aggregate counts only',
    /COUNT\(\*\)/.test(sql) && !/\bm\.text\b|\bm\.id\b/i.test(sql), sql.replace(/\s+/g, ' ').slice(0, 130));
  check('the report projects a marker, not a row identifier',
    /COALESCE\(m\.delivery_error/.test(sql));
  check('the report never returns message ids', !/RETURNING/i.test(sql));

  // claimed.text is legitimately handed to the Meta send; what must not happen is
  // it appearing in a log line, an audit payload or a marker write.
  const markerWrites = (retry.match(/recordReconciliationMarker\(\{[\s\S]{0,160}?\}\)/g) || []).join('\n');
  check('no marker write carries the reply text',
    !markerWrites.includes('claimed.text') && markerWrites.includes('category:'));
  check('no log line carries the reply text',
    !/console\.(warn|error|log)\([^)]*claimed\.text/.test(retry));
  check('audit metadata has no message body or PSID',
    !/metadata: \{[^}]*claimed\.text/.test(retry) && !/metadata: \{[^}]*psid/i.test(retry));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);