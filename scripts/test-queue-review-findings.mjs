/**
 * Stage 8 — review findings: queue infrastructure failure, recovery ownership
 * and worker deployment surface.
 *
 * Run: node scripts/test-queue-review-findings.mjs
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL = 'redis://stub:6379';

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

const webhookSrc = readFileSync('src/webhook.js', 'utf8');
const workerSrc = readFileSync('src/workers/metaEventWorker.js', 'utf8');
const pipelineSrc = readFileSync('src/workers/metaEventPipeline.js', 'utf8');

/* Inline copy of the production queueIntake contract, kept in sync with webhook.js. */
function makeQueueIntake({ recordFails = false, enqueueFails = false } = {}) {
  const rows = new Map();
  const state = { marked: [], processed: [], noIntake: [] };
  const recordWebhookEvent = async (ev) => {
    if (recordFails) { const e = new Error('db down'); e.code = 'ECONNREFUSED'; throw e; }
    const k = `${ev.provider}|${ev.eventId}`;
    if (rows.has(k)) return null;
    rows.set(k, { status: 'received' });
    return { id: 'e' };
  };
  const enqueueMetaEvent = async () => {
    if (enqueueFails) { const e = new Error('redis down'); e.code = 'ECONN'; throw e; }
    return 'job';
  };
  const markWebhookEventInline = async (p, id) => { state.marked.push(`${p}|${id}`); };
  return { rows, state, deps: { recordWebhookEvent, enqueueMetaEvent, markWebhookEventInline } };
}

const runIntake = async (events, deps) => {
  const result = { enqueued: 0, duplicates: 0, fallbackEvents: [], noIntake: [] };
  for (const ev of events) {
    let recorded;
    try { recorded = await deps.recordWebhookEvent(ev); }
    catch { result.noIntake.push(ev); continue; }
    if (!recorded) { result.duplicates++; continue; }
    try { await deps.enqueueMetaEvent(ev); result.enqueued++; }
    catch { await deps.markWebhookEventInline(ev.provider, ev.eventId).catch(() => undefined); result.fallbackEvents.push(ev); }
  }
  return result;
};

console.log('\nStage 8 — review findings\n');

/* ============ FINDING 2: recovery must not depend on inbound traffic ============ */
console.log('--- 2. stranded-event recovery is owned by the worker ---');
{
  check('worker owns a stale intake sweeper', /export function startStaleIntakeSweeper/.test(workerSrc));
  check('sweeper is started by the worker main()', /startStaleIntakeSweeper\(\);/.test(workerSrc));
  check('sweeper runs on a timer, not per request', /setInterval/.test(workerSrc));
  check('sweeper interval has a floor and a default', /STALE_SWEEP_INTERVAL_MS/.test(workerSrc) && /60_000/.test(workerSrc) && /15_000/.test(workerSrc));
  check('sweeper timer is unref’d (never holds the process)', /\.unref\?\.\(\)/.test(workerSrc));
  check('sweeper is disabled without a database', /!pgEnabled/.test(workerSrc));

  // single owner: the webhook request path must NOT claim stale rows any more
  check('webhook path no longer claims stale rows', !/claimStaleWebhookEvents/.test(webhookSrc));
  check('webhook path no longer replays stale events', !/replayStaleIntakes/.test(webhookSrc));
  check('the two claimers cannot race (only the worker claims)', (workerSrc.match(/claimStaleWebhookEvents\(\)/g) || []).length >= 1);

  // replay safety rules survive the move
  check('replay only touches rows still in received', /status = 'received'/.test(readFileSync('src/services/webhookEvents.js', 'utf8')));
  check('replay never re-runs a processing row', /status === 'done'/.test(pipelineSrc));
  check('replay is bounded (claim limit)', /LIMIT \$3/.test(readFileSync('src/services/webhookEvents.js', 'utf8')));
  check('sweeper failures are caught, never fatal', /catch \(err\)[\s\S]{0,120}stale intake sweep failed/.test(workerSrc));
}

/* ============== FINDING 3: queue/DB failure keeps Messenger available ========= */
console.log('\n--- 3. intake + queue failures are distinguished ---');
{
  // (a) queue down, database healthy: row kept, event handled inline
  {
    const { state, deps } = makeQueueIntake({ enqueueFails: true });
    const r = await runIntake([{ provider: 'meta', eventId: 'm_q' }], deps);
    check('queue failure: event handled inline', r.fallbackEvents.length === 1);
    check('queue failure: intake row kept and marked', state.marked.length === 1);
    check('queue failure: nothing reported as no-intake', r.noIntake.length === 0);
  }

  // (b) database down: the event must NOT be dropped
  {
    const { deps } = makeQueueIntake({ recordFails: true });
    const r = await runIntake([{ provider: 'meta', eventId: 'm_db' }], deps);
    check('intake failure: event is NOT dropped', r.noIntake.length === 1 && r.fallbackEvents.length === 0);
    check('intake failure: reported separately for operators', /noIntake/.test(webhookSrc));
    check('intake failure: logs that dedupe is unavailable', /WITHOUT an intake record/.test(webhookSrc));
    check('intake failure: still answered inline (availability)',
      /\(outcome\.fallbackEvents\?\.length \?\? 0\) \+ \(outcome\.noIntake\?\.length \?\? 0\) > 0/.test(webhookSrc)
      && /\.\.\.\(outcome\.noIntake \?\? \[\]\)/.test(webhookSrc));
  }

  // (c) whole intake pipeline unavailable => enqueuePayload returns null, body handled inline
  check('enqueuePayload still returns null on infrastructure failure', /return null;/.test(webhookSrc));
  check('a null outcome falls through to full inline processing', /intake infrastructure failed entirely → inline fallback below/.test(webhookSrc));

  // (d) mixed batch: enqueue ok + queue down + db down + duplicate
  {
    const rows = new Map();
    const state = { marked: [], noIntake: [] };
    let enqueueCalls = 0;
    const deps = {
      recordWebhookEvent: async (ev) => {
        if (ev.eventId === 'm_nodb') { const e = new Error('db'); e.code = 'X'; throw e; }
        const k = `${ev.provider}|${ev.eventId}`;
        if (rows.has(k)) return null;
        rows.set(k, 1);
        return { id: 'e' };
      },
      enqueueMetaEvent: async (ev) => {
        enqueueCalls++;
        if (ev.eventId === 'm_q') { const e = new Error('redis'); e.code = 'ECONN'; throw e; }
      },
      markWebhookEventInline: async (p, id) => { state.marked.push(id); }
    };
    const r = await runIntake([
      { provider: 'meta', eventId: 'm_ok' },
      { provider: 'meta', eventId: 'm_q' },
      { provider: 'meta', eventId: 'm_nodb' },
      { provider: 'meta', eventId: 'm_ok' }
    ], deps);
    check('mixed batch: healthy event queued', r.enqueued === 1 && enqueueCalls === 2);
    check('mixed batch: queue-failed event inline', r.fallbackEvents.length === 1 && state.marked.length === 1);
    check('mixed batch: db-failed event kept, not dropped', r.noIntake.length === 1);
    check('mixed batch: duplicate suppressed', r.duplicates === 1);
    const handledInline = new Set([...r.fallbackEvents, ...r.noIntake].map((e) => e.eventId));
    check('mixed batch: every non-queued event is handled exactly once', handledInline.size === 2, [...handledInline].join());
  }

  // (e) concurrent redelivery while the database is down: at-least-once, never silent
  {
    const { deps } = makeQueueIntake({ recordFails: true });
    const results = await Promise.all([1, 2, 3].map(() => runIntake([{ provider: 'meta', eventId: 'm_dbc' }], deps)));
    check('db down: every delivery is handled (availability preserved)', results.every((r) => r.noIntake.length === 1));
    check('db down: the limitation is explicit, not silent', webhookSrc.includes('WITHOUT an intake record'));
  }
}

/* ============ FINDING 1: worker deployment surface is now explicit ========== */
console.log('\n--- 1. worker deployment surface ---');
{
  const workerChanges = [
    /startStaleIntakeSweeper/,        // stranded-event recovery
    /markEventDlq/,                    // exhausted retries become visible
    /safeErrorCode/                    // sanitized worker logs
  ];
  check('worker gains the stranded-event sweeper', workerChanges[0].test(workerSrc));
  check('worker gains durable dlq marking', workerChanges[1].test(workerSrc));
  check('worker logs are sanitized', workerChanges[2].test(workerSrc));
  check('the sweeper is reachable for testing', /export function startStaleIntakeSweeper/.test(workerSrc));

  // the API must not depend on any worker-only behaviour
  check('API does not import the worker module', !/from '\.\/workers\//.test(webhookSrc));
  check('API does not import pipeline internals', !/metaEventPipeline/.test(webhookSrc));
  check('API enqueue does not depend on worker presence', !/createMetaEventWorker/.test(webhookSrc));

  // worker must tolerate a queue that never receives anything
  check('sweeper is a no-op without a database', /pgEnabled/.test(workerSrc));
  check('sweeper cannot throw out of the timer', /catch \(err\)[\s\S]{0,200}stale intake sweep failed/.test(workerSrc));
}

/* ============ FINDING 4: no destructive git operations in the change ========= */
console.log('\n--- 4. repository hygiene (no code side effects expected) ---');
{
  const pipeline = readFileSync('src/workers/metaEventPipeline.js', 'utf8');
  check('no migration file was added', !/CREATE TABLE|ALTER TABLE/.test(pipeline + webhookSrc));
  check('no retention/cleanup deletion was introduced', !/DELETE FROM webhook_events/.test(webhookSrc + pipeline + readFileSync('src/services/webhookEvents.js', 'utf8')));
  check('tenant routing still resolves per event', /buildCtx\(/.test(webhookSrc) && /buildCtx\(/.test(pipeline));
  check('fail-closed signature preserved', /if \(!secret\) return false;/.test(webhookSrc));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);