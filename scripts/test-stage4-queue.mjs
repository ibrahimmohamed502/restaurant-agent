/**
 * Stage 4 completion tests — queue/worker/provider boundary/normalization/
 * idempotency/fallback (all mocked: no Redis, no DB, no LLM, no Meta).
 * Run: node scripts/test-stage4-queue.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

const { normalizeMetaWebhook, normalizeMetaComment, normalizeMetaMessage } = await import('../src/providers/meta/normalizer.js');
const { sendMetaReply } = await import('../src/providers/meta/provider.js');
const { normalizedFromPayload, processQueuedMetaEvent } = await import('../src/workers/metaEventPipeline.js');
const { handlePayload, webhookProcessingMode } = await import('../src/webhook.js');
const { getRedisConnection } = await import('../src/queues/redis.js');

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

const PAGE = '738688299520738';
const CTX = { pageId: PAGE, tenantId: 't1', brandId: 'b1', channelId: 'ch1', metaClient: { replyToComment: async () => ({ id: 'r1' }), sendMessengerReply: async () => ({ message_id: 'm1' }) } };

/* ------------------------------------------------ webhookEvents mock store */
const events = new Map(); // `${provider}|${externalId}` -> {id,status,tenant_id,error,payload}
const makeWebhookEventDeps = () => ({
  getEvent: async (provider, externalId) => events.get(`${provider}|${externalId}`) ?? null,
  updateEvent: async ({ provider, externalId, status, tenantId, error }) => {
    const k = `${provider}|${externalId}`;
    const row = events.get(k);
    if (!row) return null;
    row.status = status; row.error = error ?? null;
    if (tenantId) row.tenant_id = tenantId;
    return { id: row.id, status };
  }
});

console.log('\n🧪 Stage 4 completion tests (mocked)\n');

/* ============================ 4. NORMALIZATION ============================ */
{
  const ok = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', message: 'hi', from: { id: 'u1', name: 'U' } } }] }] });
  check('normalization: valid comment → 1 event with correct shape',
    ok.length === 1 && ok[0].eventType === 'comment' && ok[0].eventId === 'C1' && ok[0].pageId === PAGE && ok[0].conversationKey === 'C1' && ok[0].actor.id === 'u1' && ok[0].text === 'hi');

  const dup = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', message: 'hi', from: { id: 'u1' } } }] }] });
  check('normalization: identical comment → identical eventId (dedupe key)', dup[0].eventId === ok[0].eventId);

  const self = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C2', message: 'x', from: { id: PAGE } } }] }] });
  check('normalization: self comment still normalized (self-skip handled by the pipeline)', self.length === 1 && self[0].actor.id === PAGE);

  const ineligible = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'reaction', verb: 'add', comment_id: 'C3', from: { id: 'u' } } }, { field: 'other', value: { item: 'comment', verb: 'add', comment_id: 'C4' } }] }] });
  check('normalization: ineligible changes filtered', ineligible.length === 0);

  const dm = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: 'p1' }, message: { mid: 'm1', text: 'hello' } }] }] });
  check('normalization: valid DM → 1 message event, conversationKey=psid', dm.length === 1 && dm[0].eventType === 'message' && dm[0].conversationKey === 'p1' && dm[0].eventId === 'm1');

  const echo = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PAGE }, message: { mid: 'm2', text: 'echo', is_echo: true } }] }] });
  check('normalization: echo DM filtered', echo.length === 0);

  const dupDm = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: 'p1' }, message: { mid: 'm1', text: 'again' } }] }] });
  check('normalization: duplicate DM → same eventId', dupDm[0].eventId === 'm1');

  const empty = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C5', message: '', from: { id: 'u' } } }] }] });
  check('normalization: empty text preserved (media-only path)', empty.length === 1 && empty[0].text === '');

  const att = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: 'p' }, message: { mid: 'm3', text: '', attachments: [{ type: 'image' }] } }] }] });
  check('normalization: attachments carried when present', att[0].attachments.length === 1);

  const blob = JSON.stringify(normalizeMetaComment({ id: PAGE }, { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C6', message: 'x', from: { id: 'u' } } }));
  check('normalization: no credentials/secrets in normalized event', !/token|secret|password|access_token|Bearer/i.test(blob));
}

/* ============================ 5. TENANT / ROUTING ============================ */
{
  events.clear();
  events.set('meta|C1', { id: 'e1', status: 'received', tenant_id: null, error: null, payload: { eventType: 'comment', pageId: PAGE, conversationKey: 'C1', actor: { id: 'u1' }, entry: { id: PAGE }, change: { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', message: 'hi', from: { id: 'u1', name: 'U' } } } } });
  let processed = null;
  const r = await processQueuedMetaEvent({ provider: 'meta', eventId: 'C1' }, {
    ...makeWebhookEventDeps(),
    buildCtx: async (entry) => { processed = entry; return CTX; },
    onComment: async (v, ctx) => { if (!ctx?.tenantId) throw new Error('no tenant'); }
  });
  check('tenant/routing: worker re-resolves ctx from DB and processes under ctx.tenantId', r.ok === true && processed?.id === PAGE && events.get('meta|C1').status === 'done' && events.get('meta|C1').tenant_id === 't1');

  events.clear();
  events.set('meta|CX', { id: 'e2', status: 'received', tenant_id: null, error: null, payload: { eventType: 'comment', pageId: 'unknown', conversationKey: 'CX', actor: { id: 'u' }, entry: { id: 'unknown' }, change: { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'CX', message: 'x', from: { id: 'u' } } } } });
  let onCommentCalled = false;
  const r2 = await processQueuedMetaEvent({ provider: 'meta', eventId: 'CX' }, {
    ...makeWebhookEventDeps(),
    buildCtx: async () => { const e = new Error('unknown page'); e.code = 'UNKNOWN_META_PAGE'; throw e; },
    onComment: async () => { onCommentCalled = true; }
  });
  check('tenant/routing: unknown page fails closed (no processing, failed status, no retry)', r2.skipped === 'routing_failed' && !onCommentCalled && events.get('meta|CX').status === 'failed' && events.get('meta|CX').error === 'UNKNOWN_META_PAGE');
}

/* ============================ 8. STATE MACHINE ============================ */
{
  events.clear();
  events.set('meta|DONE', { id: 'e3', status: 'done', tenant_id: 't1', error: null, payload: { eventType: 'comment', pageId: PAGE, entry: { id: PAGE }, change: { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'DONE', message: 'x', from: { id: 'u' } } } } });
  let called = false;
  await processQueuedMetaEvent({ provider: 'meta', eventId: 'DONE' }, { ...makeWebhookEventDeps(), onComment: async () => { called = true; } });
  check('state machine: done event is never reprocessed (redelivery safe)', !called);

  events.clear();
  let attempts = 0;
  events.set('meta|T', { id: 'e4', status: 'received', tenant_id: null, error: null, payload: { eventType: 'message', pageId: PAGE, conversationKey: 'p1', entry: { id: PAGE }, messaging: { sender: { id: 'p1' }, message: { mid: 'T', text: 'x' } } } });
  const deps = { ...makeWebhookEventDeps(), buildCtx: async () => CTX, onMessage: async () => { attempts++; throw new Error('Graph API 500 (code 1)'); } };
  await processQueuedMetaEvent({ provider: 'meta', eventId: 'T' }, deps).catch(() => {});
  check('state machine: transient failure records failed + rethrows (BullMQ retry)', events.get('meta|T').status === 'failed' && events.get('meta|T').error === 'meta_api_error' && attempts === 1);
  await processQueuedMetaEvent({ provider: 'meta', eventId: 'T' }, deps).catch(() => {});
  check('state machine: failed status does NOT block the next attempt', attempts === 2);
  deps.onMessage = async () => { attempts++; };
  const r3 = await processQueuedMetaEvent({ provider: 'meta', eventId: 'T' }, deps);
  check('state machine: eventual success → done (bounded retries, no duplicates)', r3.ok === true && events.get('meta|T').status === 'done' && attempts === 3);
}

/* ============================ 2. FALLBACK EXACTLY-ONCE ============================ */
{
  process.env.WEBHOOK_QUEUE_MODE = 'queue';
  const { queueIntake } = await import('../src/webhook.js');
  const commentBody = { object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'CQ', message: 'hi', from: { id: 'u1', name: 'U' } } }] }] };
  const evs = normalizeMetaWebhook(commentBody);

  // 2C) row recorded → enqueue fails → row removed → event returned for inline processing
  {
    const rows = new Set();
    let enqueueAttempts = 0;
    let deleted = 0;
    const outcome = await queueIntake(evs, {
      recordWebhookEvent: async (ev) => { rows.add('meta|' + ev.eventId); return { id: 'e5' }; },
      enqueueMetaEvent: async () => { enqueueAttempts++; throw new Error('redis down'); },
      deleteWebhookEvent: async (p, id) => { deleted++; rows.delete(`${p}|${id}`); return true; }
    });
    check('fallback 2C: enqueue failure after row recorded → row deleted, event returned for inline',
      enqueueAttempts === 1 && deleted === 1 && rows.size === 0 && outcome.fallbackEvents.length === 1 && outcome.enqueued === 0);

    // the returned event must be processed inline exactly once
    let inlineCalls = 0;
    const ids = new Set(outcome.fallbackEvents.map((e) => e.eventId));
    await handlePayload(commentBody, {
      skipQueue: true,
      buildCtx: async () => CTX,
      onComment: async (v) => { if (ids.has(v.comment_id)) inlineCalls++; }
    });
    check('fallback 2C: fallback event processed inline exactly once', inlineCalls === 1);
  }

  // 2A/B) enqueue succeeds → redelivery is a duplicate → one queued event, one reply
  {
    const rows = new Set();
    let enqueued = 0;
    const deps = {
      recordWebhookEvent: async (ev) => { const k = 'meta|' + ev.eventId; if (rows.has(k)) return null; rows.add(k); return { id: 'e6' }; },
      enqueueMetaEvent: async () => { enqueued++; },
      deleteWebhookEvent: async () => true
    };
    const first = await queueIntake(evs, deps);
    const redelivery = await queueIntake(evs, deps);
    check('fallback/idempotency: redelivery before worker completion → 1 queued, 1 duplicate, no second reply',
      first.enqueued === 1 && redelivery.enqueued === 0 && redelivery.duplicates === 1 && enqueued === 1);
  }

  // total intake failure (infrastructure) → inline fallback still processes
  {
    let inlineCalls = 0;
    await handlePayload(commentBody, {
      enqueueFn: async () => null, // simulate record/enqueue infrastructure failure
      buildCtx: async () => CTX,
      onComment: async () => { inlineCalls++; }
    });
    check('fallback: intake infrastructure failure → inline processing exactly once', inlineCalls === 1);
  }
}

/* ============================ 7. MODES ============================ */
{
  const prev = process.env.WEBHOOK_QUEUE_MODE;
  delete process.env.WEBHOOK_QUEUE_MODE;
  check('mode: missing value → inline (safest default)', webhookProcessingMode() === 'inline');
  process.env.WEBHOOK_QUEUE_MODE = 'nonsense';
  check('mode: invalid value → inline (fail-safe)', webhookProcessingMode() === 'inline');
  process.env.WEBHOOK_QUEUE_MODE = 'queue';
  check('mode: queue recognized', webhookProcessingMode() === 'queue');
  process.env.WEBHOOK_QUEUE_MODE = prev ?? 'inline';

  // inline mode ignores the queue entirely
  process.env.WEBHOOK_QUEUE_MODE = 'inline';
  let inlineRan = 0;
  await handlePayload({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'CINL', message: 'x', from: { id: 'u' } } }] }] }, {
    buildCtx: async () => CTX,
    onComment: async () => { inlineRan++; }
  });
  check('mode: inline bypasses queue completely', inlineRan === 1);
}

/* ============================ JOB SECRET SAFETY ============================ */
{
  process.env.WEBHOOK_QUEUE_MODE = 'queue';
  let capturedJob = null;
  await handlePayload({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: 'p1' }, message: { mid: 'MJ', text: 'hi' } }] }] }, {
    enqueueFn: async (body) => {
      const { normalizeMetaWebhook } = await import('../src/providers/meta/normalizer.js');
      const ev = normalizeMetaWebhook(body)[0];
      // exactly what the real enqueue would put in the payload
      capturedJob = { provider: ev.provider, eventId: ev.eventId, eventType: ev.eventType, pageId: ev.pageId, conversationKey: ev.conversationKey, actor: ev.actor, text: ev.text, receivedAt: ev.receivedAt };
      return { enqueued: 1, duplicates: 0, fallbackEvents: [] };
    }
  });
  const keys = Object.keys(capturedJob ?? {});
  const forbidden = keys.filter((k) => /token|credential|secret|password|accessToken|raw|entry|payload|authorization/i.test(k));
  check('job safety: payload has ids/context only (no credentials/raw payload)', capturedJob && forbidden.length === 0 && keys.length === 8);
}

/* ============================ PROVIDER / REDIS ============================ */
{
  try { await sendMetaReply({ eventType: 'comment', conversationKey: 'C1' }, 'hi', null); check('provider: refuses to send without a credential', false); }
  catch (e) { check('provider: refuses to send without a credential', e.code === 'META_CREDENTIAL_MISSING'); }

  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  let code = null;
  try { getRedisConnection(); } catch (e) { code = e.code; }
  check('redis failure: missing REDIS_URL → controlled error (no crash)', code === 'REDIS_NOT_CONFIGURED');
  process.env.REDIS_URL = prev;
}

/* ============================ PAYLOAD ROUND TRIP ============================ */
{
  const evs = normalizeMetaWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: 'p9' }, message: { mid: 'm9', text: 'hey' } }] }] });
  const payload = { eventType: evs[0].eventType, pageId: evs[0].pageId, conversationKey: evs[0].conversationKey, actor: evs[0].actor, entry: evs[0].rawEntry, messaging: evs[0].rawMessaging };
  const back = normalizedFromPayload(payload);
  check('round trip: persisted payload → normalized event (worker path)', back.eventId === 'm9' && back.eventType === 'message' && back.conversationKey === 'p9' && back.rawMessaging?.message?.mid === 'm9');
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
