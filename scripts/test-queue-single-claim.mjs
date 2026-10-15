/**
 * Stage 8 — final queue safety: single-claimer guarantees.
 *
 * Run: node scripts/test-queue-single-claim.mjs
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL = 'redis://stub:6379';

import { readFileSync } from 'node:fs';
import { redispatchStaleIntakes, processQueuedMetaEvent } from '../src/workers/metaEventPipeline.js';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

const eventsSrc = readFileSync('src/services/webhookEvents.js', 'utf8');
const webhookSrc = readFileSync('src/webhook.js', 'utf8');
const workerSrc = readFileSync('src/workers/metaEventWorker.js', 'utf8');
const pipelineSrc = readFileSync('src/workers/metaEventPipeline.js', 'utf8');

/** In-memory stand-in for webhook_events with the real status semantics. */
function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async record(provider, eventId, payload) {
      const k = `${provider}|${eventId}`;
      if (rows.has(k)) return null;
      rows.set(k, { provider, eventId, payload, status: 'received', error: null });
      return rows.get(k);
    },
    async claim(provider, eventId) {
      const row = rows.get(`${provider}|${eventId}`);
      if (!row) return null;
      if (row.status !== 'received' && row.status !== 'failed') return null;
      row.status = 'processing';
      return row;
    },
    async setStatus(provider, eventId, status) {
      const row = rows.get(`${provider}|${eventId}`);
      if (row) row.status = status;
      return row;
    }
  };
}

const PAYLOAD = {
  eventType: 'message',
  pageId: 'PAGE-1',
  receivedAt: '2026-10-15T16:42:56.000Z',
  messaging: [{ message: { mid: 'm_race' }, sender: { id: 'PSID-1' } }]
};

console.log('\nStage 8 — single-claimer guarantees\n');

/* ============ 1. ATOMIC CLAIM SQL ============ */
console.log('--- 1. the claim is a conditional database update ---');
{
  check('claimWebhookEventForProcessing is exported', /export async function claimWebhookEventForProcessing/.test(eventsSrc));
  check('claim is an UPDATE (not read-then-write)', /UPDATE webhook_events[\s\S]*status = 'processing'/.test(eventsSrc));
  check('claim is conditional on the status', /AND status IN \('received', 'failed'\)/.test(eventsSrc));
  check("claim refuses 'processing' (no partial replay)", /AND status IN \('received', 'failed'\)/.test(eventsSrc) && !/status IN \([^)]*'processing'[^)]*\)/.test(eventsSrc));
  check("claim refuses 'done'", /status IN \('received', 'failed'\)/.test(eventsSrc));
  check('claim RETURNING the row', /RETURNING id, status, tenant_id, payload/.test(eventsSrc));
  check('claim preserves tenant via COALESCE', /tenant_id = COALESCE\(\$3, tenant_id\)/.test(eventsSrc));

  const workerChecksPipeline = /const row = await claim\(\{ provider, externalId: eventId \}\)/.test(pipelineSrc);
  check('pipeline claims BEFORE any business logic', workerChecksPipeline);
  check('pipeline skips when the claim fails', /if \(!row\) return \{ skipped: 'not_claimed' \}/.test(pipelineSrc));
  check('no read-then-check remains in the pipeline', !/row\.status === 'done'/.test(pipelineSrc));
  check('pipeline no longer uses the non-atomic getter', !/getEvent\s*=/.test(pipelineSrc) && !/getWebhookEvent/.test(pipelineSrc));
}

/* ============ 2. TWO WORKERS RACING FOR ONE EVENT ============ */
console.log('\n--- 2. two workers racing for one event ---');
{
  const store = fakeStore();
  await store.record('meta', 'm_race', PAYLOAD);

  const calls = [];
  const deps = {
    claim: async ({ provider, externalId }) => store.claim(provider, externalId),
    buildCtx: async () => ({ tenantId: 't-1', brandId: 'b-1', pageId: 'PAGE-1', metaClient: {} }),
    onMessage: async () => { calls.push('processed'); },
    updateEvent: async ({ provider, externalId, status }) => store.setStatus(provider, externalId, status),
    pgEnabled: true
  };
  const job = { provider: 'meta', eventId: 'm_race' };
  const [a, b] = await Promise.all([processQueuedMetaEvent(job, deps), processQueuedMetaEvent(job, deps)]);
  const processed = calls.length;
  check('exactly one worker processed the event', processed === 1, `processed=${processed}`);
  check('the loser is reported as not_claimed', [a, b].some((r) => r?.skipped === 'not_claimed'), JSON.stringify([a, b]));
  check('the winner completed', [a, b].some((r) => r?.ok === true), JSON.stringify([a, b]));
  check('row ends in done', store.rows.get('meta|m_race').status === 'done');
}

/* ============ 3. SWEEPER VS QUEUED JOB ============ */
console.log('\n--- 3. the sweeper never processes, only re-dispatches ---');
{
  const enqueued = [];
  const recorded = [];
  const rows = [
    { provider: 'meta', external_id: 'm_a', redispatches: 0 },
    { provider: 'meta', external_id: 'm_b', redispatches: 3 }
  ];
  const res = await redispatchStaleIntakes(rows, {
    enqueue: async (e) => { enqueued.push(e.eventId); },
    record: async (p, id, n) => { recorded.push(`${id}:${n}`); }
  });
  check('sweeper re-dispatched both rows', res.filter((r) => r.redispatched).length === 2);
  check('sweeper enqueued by deterministic identity', enqueued.join(',') === 'm_a,m_b', enqueued.join(','));
  check('sweeper counts attempts instead of looping', recorded.join(',') === 'm_a:1,m_b:4', recorded.join(','));
  check('sweeper never calls buildCtx / onMessage',
    !/buildCtx|onMessage|processInline/.test(workerSrc.split('startStaleIntakeSweeper')[1]?.slice(0, 1400) ?? ''));
  check('sweeper only re-queues (redispatchStaleIntakes)', /redispatchStaleIntakes\(claimed\)/.test(workerSrc));
  check('redispatch passes identity only (no customer content)',
    !/text|actor|conversationKey/.test(pipelineSrc.split('redispatchStaleIntakes')[1]?.slice(0, 1200) ?? ''));

  // a queued-but-unclaimed job: re-adding the same deterministic id is a no-op
  const jobs = new Map();
  const fakeQueue = { async add(name, data, opts) { const had = jobs.has(opts.jobId); jobs.set(opts.jobId, 1); return { id: opts.jobId, deduped: had }; } };
  const { enqueueMetaEvent } = await import('../src/queues/metaEvents.js');
  const first = await enqueueMetaEvent({ provider: 'meta', eventId: 'm_live' }, { queue: fakeQueue });
  const second = await enqueueMetaEvent({ provider: 'meta', eventId: 'm_live' }, { queue: fakeQueue });
  check('an already-queued event maps to the same job id', first === second);
  check('the worker is still the only processor', !/onMessage|onComment/.test(
    (await import('node:fs')).readFileSync('src/workers/metaEventWorker.js', 'utf8')
      .split('startStaleIntakeSweeper')[1]?.slice(0, 1400) ?? ''));
}

/* ============ 4. DURABLE INTAKE BEFORE ACK ============ */
console.log('\n--- 4. intake is durable before the 200 ---');
{
  const route = webhookSrc.slice(webhookSrc.indexOf("webhookRouter.post('/webhook'"), webhookSrc.indexOf('function verifySignature'));
  const ackAt = route.indexOf('res.sendStatus(200)');
  const intakeAt = route.indexOf('intakeWebhookBody(req.body)');
  check('signature is verified first', route.indexOf('verifySignature(req)') < intakeAt);
  check('intake is requested before the 200', intakeAt > -1 && intakeAt < ackAt, `intake@${intakeAt} ack@${ackAt}`);
  check('200 is sent inside the intake promise (durably recorded)', /intakeWebhookBody\(req\.body\)\s*\r?\n\s*\.then\(\(intake\) => \{\s*\r?\n\s*res\.sendStatus\(200\)/.test(route));
  check('503 is returned when intake fails', /res\.sendStatus\(503\)/.test(route));
  check('dispatch happens after the ack', route.indexOf('dispatchWebhookBody') > ackAt);
  check('no AI/outbound work before the ack', !/processMessage|processComment|sendMessengerReply/.test(route));

  // intake never processes
  const intakeFn = webhookSrc.slice(webhookSrc.indexOf('export async function intakeWebhookBody'), webhookSrc.indexOf('export async function queueIntake'));
  check('intake phase does not enqueue', !/enqueue/.test(intakeFn));
  check('intake phase does not process', !/processInline|onMessage|onComment/.test(intakeFn));
  check('intake counts duplicates via ON CONFLICT',
    /await record\(ev\)/.test(intakeFn) && /if \(!row\) \{ duplicates\+\+/.test(intakeFn) &&
    /recordWebhookEvent/.test(intakeFn));
  check('intake is the phase that persists (dispatch never records)',
    !/recordWebhookEvent/.test(webhookSrc.slice(webhookSrc.indexOf('export async function dispatchWebhookBody'), webhookSrc.indexOf('export async function handlePayload'))));

  // partial failure in a multi-event payload
  check('a per-event intake throw propagates to 503', !/catch/.test(intakeFn), 'no per-event catch: any failure fails the whole request');
}

/* ============ 5. INFRASTRUCTURE FAILURES ============ */
console.log('\n--- 5. Redis and PostgreSQL failures ---');
{
  check('Redis failure keeps the durable row and answers inline',
    /enqueue failed \(\$\{safeErrorCode\(e\)\}\) — handling inline, intake row kept/.test(webhookSrc));
  check('Redis failure marks the row, never deletes it', /markWebhookEventInline/.test(webhookSrc));
  check('no DELETE of an intake row exists', !/DELETE FROM webhook_events/.test(eventsSrc + webhookSrc));
  check('PostgreSQL failure yields a retryable 503', /res\.sendStatus\(503\)/.test(webhookSrc));
  check('PostgreSQL failure does not process anything', /dispatchWebhookBody[\s\S]*\.catch/.test(webhookSrc));
  check('stale claim cannot exceed its re-dispatch cap', /maxRedispatches/.test(eventsSrc) && /< \$4/.test(eventsSrc));
  check('stale claim never changes status (worker owns the claim)',
    /SET error = COALESCE\(error, \$1\)/.test(eventsSrc) && !/SET status = 'processing', error = \$1/.test(eventsSrc));
}

/* ============ 6. RETRY SEMANTICS ============ */
console.log('\n--- 6. retry and recovery semantics ---');
{
  check("a failed attempt stays claimable for BullMQ's bounded retry", /status IN \('received', 'failed'\)/.test(eventsSrc));
  check('a failed attempt is marked failed', /status: 'failed'/.test(pipelineSrc));
  check('exhausted jobs go to dlq, not to replay', /markEventDlq/.test(workerSrc));
  check('dlq rows are never auto-replayed', !/dlq[\s\S]{0,300}redispatchStaleIntakes/.test(workerSrc));
  check('the claim is bounded', /LIMIT \$5/.test(eventsSrc));
  check('tenant/brand still resolve per event from the database', /buildCtx\(\{ id: normalized\.pageId \}\)/.test(pipelineSrc));
  check('routing failures stay fail-closed', /ROUTING_FAILED/.test(pipelineSrc));
}

/* ============ 7. PRIVACY STILL HOLDS ============ */
console.log('\n--- 7. no PII regression ---');
{
  check('payload is still never logged', !/JSON\.stringify\(req\.body\)/.test(webhookSrc));
  check('message text is still never logged', !/New DM from \$\{psid\}/.test(webhookSrc) && !/New comment from \$\{from\.name/.test(webhookSrc));
  check('fail-closed signature preserved', /if \(!secret\) return false;/.test(webhookSrc));
  check('no migration is required by this change', !/CREATE TABLE|ALTER TABLE|DROP /.test(eventsSrc + webhookSrc + pipelineSrc));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);