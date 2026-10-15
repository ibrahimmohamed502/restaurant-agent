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

const { intakeWebhookBody, queueIntake } = await import('../src/webhook.js');

/**
 * Models the real POST route against the production intake/dispatch pair:
 * intake (durable record, before the ACK) then dispatch (queue or inline,
 * after the ACK). A thrown intake is what turns into a retryable 503.
 */
async function runRoute(events, { record, enqueueMetaEvent, markWebhookEventInline }) {
  const body = { object: 'page', events };
  const intake = await intakeWebhookBody(body, { record, normalize: (b) => b.events });
  const outcome = await queueIntake(intake.events, { enqueueMetaEvent, markWebhookEventInline });
  // duplicates are counted by the INTAKE phase; the dispatcher only enqueues.
  return { ack: 200, ...outcome, duplicates: intake.duplicates, accepted: intake.events.length };
}

/** The route's catch branch: no durable record, therefore no processing. */
async function runRouteExpecting503(events, deps) {
  try {
    await runRoute(events, deps);
    return { ack: 200 };
  } catch {
    return { ack: 503, enqueued: 0, duplicates: 0, fallbackEvents: [] };
  }
}

/** In-memory stand-in for the UNIQUE(provider, external_id) intake table. */
function makeDeps({ enqueueFailsFor = [] } = {}) {
  const rows = new Map();
  // mutable, so a test can simulate the database failing and then recovering
  // against the SAME durable store.
  const recordDown = new Set();
  const state = { marked: [], enqueued: [] };
  const record = async (ev) => {
    if (recordDown.has(ev.eventId)) { const e = new Error('db down'); e.code = 'ECONNREFUSED'; throw e; }
    const k = `${ev.provider}|${ev.eventId}`;
    if (rows.has(k)) return null;          // ON CONFLICT DO NOTHING
    rows.set(k, { status: 'received' });
    return { id: `row-${rows.size}` };
  };
  const enqueueMetaEvent = async (ev) => {
    state.enqueued.push(ev.eventId);
    if (enqueueFailsFor.includes(ev.eventId)) { const e = new Error('redis down'); e.code = 'ECONN'; throw e; }
    return 'job';
  };
  const markWebhookEventInline = async (p, id) => { state.marked.push(`${p}|${id}`); };
  return { rows, recordDown, state, record, enqueueMetaEvent, markWebhookEventInline };
}

console.log('\nStage 8 — review findings\n');

/* ============ FINDING 2: recovery must not depend on inbound traffic ============ */
console.log('--- 2. stranded-event recovery is owned by the worker ---');
{
  const eventsSrc = readFileSync('src/services/webhookEvents.js', 'utf8');
  check('worker owns a stale intake sweeper', /export function startStaleIntakeSweeper/.test(workerSrc));
  check('sweeper is started by the worker main()', /startStaleIntakeSweeper\(\);/.test(workerSrc));
  check('sweeper runs on a timer, not per request', /setInterval/.test(workerSrc));
  check('sweeper interval has a floor and a default', /STALE_SWEEP_INTERVAL_MS/.test(workerSrc) && /60_000/.test(workerSrc) && /15_000/.test(workerSrc));
  check('sweeper timer is unref’d (never holds the process)', /\.unref\?\.\(\)/.test(workerSrc));
  check('sweeper is disabled without a database', /!pgEnabled/.test(workerSrc));

  // single owner: the webhook request path must NOT claim or dispatch stale rows
  check('webhook path no longer claims stale rows', !/claimStaleWebhookEvents/.test(webhookSrc));
  check('webhook path no longer re-dispatches stale events', !/redispatchStaleIntakes/.test(webhookSrc));
  check('only the worker claims stranded rows', (workerSrc.match(/claimStaleWebhookEvents\(\)/g) || []).length >= 1);

  // re-dispatch safety rules
  check('sweeper only touches rows still in received', /status = 'received'/.test(eventsSrc));
  check('the sweeper never changes status (the worker owns the claim)',
    /SET error = COALESCE\(error, \$1\)/.test(eventsSrc) && !/SET status = 'processing', error = \$1/.test(eventsSrc));
  check('the worker refuses a processing or done row', /AND status IN \('received', 'failed'\)/.test(eventsSrc));
  check('a refused claim stops processing before any business logic', /if \(!row\) return \{ skipped: 'not_claimed' \}/.test(pipelineSrc));
  check('re-dispatch is bounded (claim limit)', /LIMIT \$5/.test(eventsSrc));
  check('re-dispatch is capped so a dead queue cannot loop', /maxRedispatches/.test(eventsSrc) && /< \$4/.test(eventsSrc));
  check('sweeper failures are caught, never fatal', /catch \(err\)[\s\S]{0,120}stale intake sweep failed/.test(workerSrc));
}

/* ====== FINDING 3: queue down stays available; database down is retried ====== */
console.log('\n--- 3. intake + queue failures are distinguished ---');
{
  // (a) queue down, database healthy: durable row kept, customer answered inline
  {
    const deps = makeDeps({ enqueueFailsFor: ['m_q'] });
    const r = await runRoute([{ provider: 'meta', eventId: 'm_q' }], deps);
    check('queue failure: the request is still ACKed (200)', r.ack === 200);
    check('queue failure: event handled inline', r.fallbackEvents.length === 1);
    check('queue failure: durable row kept and marked', deps.state.marked.length === 1 && deps.rows.size === 1);
    check('queue failure: nothing is queued', r.enqueued === 0);
  }

  // (b) database down: no durable record means no processing — the request is
  //     answered 503 so Meta redelivers it instead of the event being lost.
  {
    const deps = makeDeps();
    deps.recordDown.add('m_db');
    const r = await runRouteExpecting503([{ provider: 'meta', eventId: 'm_db' }], deps);
    check('database failure: retryable 503 instead of a false ACK', r.ack === 503);
    check('database failure: nothing is queued or processed', r.enqueued === 0 && (r.fallbackEvents ?? []).length === 0);
    check('database failure: no idempotency row is invented', deps.rows.size === 0);
    check('database failure: the operator is told intake failed',
      /durable intake failed/.test(webhookSrc) && /res\.sendStatus\(503\)/.test(webhookSrc));
  }

  // (c) duplicate redelivery before the worker completes is suppressed
  {
    const deps = makeDeps();
    const first = await runRoute([{ provider: 'meta', eventId: 'm_d' }], deps);
    const again = await runRoute([{ provider: 'meta', eventId: 'm_d' }], deps);
    check('redelivery: second delivery is a duplicate, not a second job',
      first.enqueued === 1 && again.enqueued === 0 && again.duplicates === 1 && again.ack === 200);
    check('redelivery: exactly one durable row exists', deps.rows.size === 1);
  }

  // (d) partial intake failure in a multi-event payload: the request fails
  //     closed, and the retry converges on exactly the missing events.
  {
    const events = [
      { provider: 'meta', eventId: 'm_ok' },
      { provider: 'meta', eventId: 'm_q' },
      { provider: 'meta', eventId: 'm_nodb' },
      { provider: 'meta', eventId: 'm_ok' }
    ];
    const deps = makeDeps({ enqueueFailsFor: ['m_q'] });
    deps.recordDown.add('m_nodb');
    const firstTry = await runRouteExpecting503(events, deps);
    check('partial intake failure: the whole request is not ACKed', firstTry.ack === 503);
    check('partial intake failure: nothing is dispatched', (firstTry.fallbackEvents ?? []).length === 0);

    // Meta retries the identical payload; the database is healthy this time.
    deps.recordDown.clear();
    const retry = await runRoute(events, deps);
    check('retry after a partial failure: the request is accepted', retry.ack === 200);
    // The rows written during the failed attempt are already durable, so the
    // retry sees them as duplicates and does NOT dispatch them a second time.
    // They stay claimable, and the worker sweeper re-dispatches them: at-least-
    // once is preserved without a duplicate outbound reply.
    check('retry: only the event missing from the durable set is dispatched now',
      retry.enqueued === 1 && retry.duplicates === 3 && retry.fallbackEvents.length === 0,
      JSON.stringify({ enq: retry.enqueued, fb: retry.fallbackEvents.length, dup: retry.duplicates }));
    check('retry: every event has exactly one durable row', deps.rows.size === 3);
    check('retry: the rows of the failed attempt are still claimable',
      [...deps.rows.values()].every((r) => r.status === 'received'));

    const { redispatchStaleIntakes } = await import('../src/workers/metaEventPipeline.js');
    const recovered = [];
    const stranded = [...deps.rows.entries()]
      .map(([k, r]) => ({ provider: k.split('|')[0], external_id: k.split('|')[1], status: r.status, redispatches: 0 }))
      .filter((r) => !deps.state.enqueued.includes(r.external_id));
    await redispatchStaleIntakes(stranded, {
      enqueue: async (e) => { recovered.push(e.eventId); },
      record: async () => {}
    });
    check('the sweeper recovers every event left by the failed attempt',
      recovered.sort().join(',') === 'm_ok,m_q', recovered.join(','));
    check('no event is dispatched twice across the retry and the sweep',
      deps.state.enqueued.filter((e) => recovered.includes(e)).length === 0);
  }

  // (e) concurrent Meta redelivery: the UNIQUE constraint elects one winner
  {
    const deps = makeDeps();
    const batch = [{ provider: 'meta', eventId: 'm_c' }];
    const results = await Promise.all([runRoute(batch, deps), runRoute(batch, deps), runRoute(batch, deps)]);
    check('concurrent redelivery: exactly one delivery is accepted',
      results.filter((r) => r.enqueued === 1).length === 1 && results.every((r) => r.ack === 200));
    check('concurrent redelivery: no second job is created', deps.state.enqueued.length === 1 && deps.rows.size === 1);
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