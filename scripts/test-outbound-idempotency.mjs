/**
 * Outbound delivery safety — unit level (stubbed database, zero network).
 *
 *   node scripts/test-outbound-idempotency.mjs
 *
 * Covers the duplicate-send scenarios that the end-to-end webhook flow creates.
 * The SQL-level guarantees (unique index, CHECK constraint, atomic claim, retry
 * allow-list) are proven against a real PostgreSQL in
 * scripts/test-pg-delivery-integration.mjs; this file covers the application
 * logic that decides WHICH state a delivery lands in.
 *
 * The headline cases:
 *   D1  Meta accepted the reply, then the bookkeeping write failed.
 *       -> must stay 'pending', so no retry can duplicate it.
 *   D2  Meta's outcome was never established (timeout / 5xx / reset socket).
 *       -> 'pending' + delivery_unknown, never retryable.
 *   D3  Inbound persistence failed.
 *       -> NOTHING is sent, and the failure propagates for a bounded retry.
 *   D4  An exception AFTER the send was attempted.
 *       -> the event becomes 'unknown', which the atomic claim refuses.
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const { pool } = await import('../src/db/pg.js');
if (!pool) { console.error('stub pool missing'); process.exit(1); }

/* ------------------------------------------------------------------ store */
const store = new Map();          // `${conv}|${pmid}` -> message row
let seq = 0;
/** Flip these to simulate infrastructure failures at a precise point. */
const faults = { updateDelivery: false, insertInbound: false };

pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ');

  if (/INSERT INTO messages/.test(s)) {
    const isInbound = /'inbound'/.test(s);
    const [tenantId, conversationId] = params;
    const pmid = isInbound ? params[4] : params[3];
    const deliveryStatus = isInbound ? 'sent' : (params[5] ?? 'sent');
    const deliveryError = isInbound ? null : (params[6] ?? null);
    const text = isInbound ? params[3] : params[2];

    if (isInbound && faults.insertInbound) {
      const e = new Error('connection terminated unexpectedly');
      e.code = 'ECONNRESET';
      throw e;
    }
    // Mirrors ON CONFLICT (conversation_id, provider_message_id) DO NOTHING.
    // Outbound rows carry a random sentinel, so they never conflict — which is
    // exactly why the outbound side needs the delivery-state machine.
    const key = `${conversationId}|${pmid}`;
    if (store.has(key)) return { rows: [] };
    const row = {
      id: `msg_${++seq}`, tenant_id: tenantId, conversation_id: conversationId,
      direction: isInbound ? 'inbound' : 'outbound', text: text ?? null,
      provider_message_id: pmid, delivery_status: deliveryStatus, delivery_error: deliveryError
    };
    store.set(key, row);
    return { rows: [{ id: row.id }] };
  }

  if (/UPDATE messages/.test(s)) {
    const [deliveryStatus, deliveryError, pmid, messageId, tenantId] = params;
    if (faults.updateDelivery) {
      const e = new Error('could not serialize access due to concurrent update');
      e.code = '40001';
      throw e;
    }
    for (const row of store.values()) {
      if (row.id === messageId && row.tenant_id === tenantId && row.direction === 'outbound') {
        row.delivery_status = deliveryStatus;
        row.delivery_error = deliveryError;
        if (pmid) row.provider_message_id = pmid;
        return { rows: [{ id: row.id }] };
      }
    }
    return { rows: [] };
  }

  if (/INSERT INTO (channels|customers|conversations|customer_identities)/.test(s)) return { rows: [{ id: 'x' }] };
  if (/UPDATE (conversations|customers)/.test(s)) return { rows: [] };
  if (/SELECT/.test(s)) return { rows: [] };
  return { rows: [] };
};

const { processComment, processMessage } = await import('../src/webhook.js');
const { classifyDeliveryError, isRetryableDeliveryRow, isRetryableDeliveryCategory, RETRYABLE_DELIVERY_CATEGORIES }
  = await import('../src/services/deliveryOutcome.js');
const { processQueuedMetaEvent } = await import('../src/workers/metaEventPipeline.js');
const { escalationLogView } = await import('../src/notify.js');
const { readFileSync } = await import('node:fs');

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  OK   ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' -- ' + d : ''}`); }
};

const reset = () => { store.clear(); faults.updateDelivery = false; faults.insertInbound = false; };
const outboundRows = () => [...store.values()].filter((r) => r.direction === 'outbound');
const inboundRows = () => [...store.values()].filter((r) => r.direction === 'inbound');

const base = (over = {}) => ({
  analyze: async () => ({ reply: 'ok', intent: 'i', inScope: true, lang: 'en', escalate: false }),
  notify: async () => {}, logEvt: () => {}, addEsc: () => {},
  isReplied: () => false, mark: () => {}, overLimit: () => false,
  pgEnabled: true, ...over
});

const ctxWith = (metaClient) => ({
  pageId: 'p1', tenantId: 'ten1', brandId: 'b1', channelId: 'ch1',
  metaClient: {
    replyToComment: async () => ({ id: 'reply1' }),
    sendMessengerReply: async () => ({ message_id: 'dm1' }),
    sendTypingIndicator: async () => undefined,
    getUserFirstName: async () => 'Tester',
    ...metaClient
  }
});

/** A Meta error shaped exactly like one produced by src/facebook.js. */
const graphError = (status, code, subcode = null) => {
  const e = new Error(`Graph API ${status}${code ? ` (code ${code})` : ''}: simulated`);
  e.status = status; e.graphCode = code; e.subcode = subcode; e.isGraphError = true;
  return e;
};
const transportError = () => {
  const e = new TypeError('fetch failed');
  e.isTransportError = true;
  e.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  return e;
};

console.log('\nStage 8 — outbound delivery safety\n');

/* ============ 1. THE CLASSIFICATION TABLE (two orthogonal axes) ========== */
console.log('--- 1. delivery outcome classification ---');
{
  check('success is DELIVERED + sent', (() => {
    const o = classifyDeliveryError(null);
    return o.outcome === 'delivered' && o.deliveryStatus === 'sent' && o.retryable === false;
  })());

  check('429 is a confirmed refusal and IS retryable', (() => {
    const o = classifyDeliveryError(graphError(429, 4));
    return o.outcome === 'not_delivered_retryable' && o.category === 'meta_rate_limit' &&
      o.deliveryStatus === 'failed' && o.retryable === true;
  })());

  check('graph 17/32/613 throttling codes are retryable',
    [17, 32, 613].every((c) => classifyDeliveryError(graphError(400, c)).retryable === true));

  check('401 / token errors are permanent, NOT retryable', (() => {
    const o = classifyDeliveryError(graphError(401, 190));
    return o.outcome === 'not_delivered_permanent' && o.category === 'meta_auth_expired' && o.retryable === false;
  })());

  check('403 / permission errors are permanent, NOT retryable', (() => {
    const o = classifyDeliveryError(graphError(403, 200));
    return o.outcome === 'not_delivered_permanent' && o.category === 'meta_permission' && o.retryable === false;
  })());

  check('a 5xx is UNKNOWN — the message may already exist', (() => {
    const o = classifyDeliveryError(graphError(500, 1));
    return o.outcome === 'unknown' && o.category === 'delivery_unknown' &&
      o.deliveryStatus === 'pending' && o.retryable === false;
  })());

  check('a timeout is UNKNOWN', (() => {
    const o = classifyDeliveryError(transportError());
    return o.outcome === 'unknown' && o.deliveryStatus === 'pending';
  })());

  check('an unrecognised 4xx is permanent, never assumed retryable', (() => {
    const o = classifyDeliveryError(graphError(418, 999));
    return o.outcome === 'not_delivered_permanent' && o.retryable === false;
  })());

  check('a completely unrecognised error fails closed to UNKNOWN',
    classifyDeliveryError(new Error('what')).outcome === 'unknown');

  check('the allow-list holds exactly one category',
    RETRYABLE_DELIVERY_CATEGORIES.length === 1 && isRetryableDeliveryCategory('meta_rate_limit') &&
    !isRetryableDeliveryCategory('meta_api_error') && !isRetryableDeliveryCategory('delivery_unknown'));

  check('every outcome maps onto a schema-legal delivery_status',
    [null, graphError(429, 4), graphError(401, 190), graphError(500, 1), new Error('x')]
      .every((e) => ['pending', 'sent', 'failed'].includes(classifyDeliveryError(e).deliveryStatus)));
}

/* ============ 2. D1 — SEND SUCCEEDED, THEN THE DB WRITE FAILED ========== */
console.log('\n--- 2. confirmed send + failed bookkeeping is NOT retryable ---');
for (const [label, value, run] of [
  ['comment', { comment_id: 'c1', message: 'hi', from: { id: 'u1' } }, processComment],
  ['DM', { message: { mid: 'm1', text: 'hi' }, sender: { id: 'u1' } }, processMessage]
]) {
  reset();
  let sent = 0;
  const meta = label === 'comment'
    ? { replyToComment: async () => { sent++; return { id: 'r1' }; } }
    : { sendMessengerReply: async () => { sent++; return { message_id: 'd1' }; } };
  faults.updateDelivery = true; // Meta is reachable; the DB write is not

  await run(value, ctxWith(meta), base());

  const out = outboundRows()[0];
  check(`${label}: the reply WAS sent (we cannot un-send it)`, sent === 1);
  check(`${label}: the row is left 'pending', never 'failed'`,
    out?.delivery_status === 'pending', out?.delivery_status);
  check(`${label}: the row is NOT claimable for retry`,
    !isRetryableDeliveryRow({ deliveryStatus: out?.delivery_status, deliveryError: out?.delivery_error }));
}

/* ============ 3. D2 — META DELIVERY OUTCOME NEVER ESTABLISHED =========== */
console.log('\n--- 3. unknown outcome is recorded as such, and never retried ---');
for (const [label, err, value, run] of [
  ['comment 5xx', graphError(500, 1), { comment_id: 'c2', message: 'hi', from: { id: 'u1' } }, processComment],
  ['comment timeout', transportError(), { comment_id: 'c3', message: 'hi', from: { id: 'u1' } }, processComment],
  ['DM timeout', transportError(), { message: { mid: 'm2', text: 'hi' }, sender: { id: 'u1' } }, processMessage]
]) {
  reset();
  const meta = run === processComment
    ? { replyToComment: async () => { throw err; } }
    : { sendMessengerReply: async () => { throw err; } };
  await run(value, ctxWith(meta), base());
  const out = outboundRows()[0];
  check(`${label}: recorded pending + delivery_unknown`,
    out?.delivery_status === 'pending' && out?.delivery_error === 'delivery_unknown',
    `${out?.delivery_status}/${out?.delivery_error}`);
  check(`${label}: not retryable`,
    !isRetryableDeliveryRow({ deliveryStatus: out?.delivery_status, deliveryError: out?.delivery_error }));
}

/* ============ 4. DEFINITIVE REJECTIONS ARE DISTINGUISHED ================ */
console.log('\n--- 4. a confirmed refusal is retryable only when transient ---');
{
  reset();
  let sent = 0;
  await processComment(
    { comment_id: 'c4', message: 'hi', from: { id: 'u1' } },
    ctxWith({ replyToComment: async () => { sent++; throw graphError(429, 4); } }),
    base()
  );
  const limited = outboundRows()[0];
  check('rate limited: failed + meta_rate_limit + retryable',
    limited?.delivery_status === 'failed' && limited?.delivery_error === 'meta_rate_limit' &&
    isRetryableDeliveryRow({ deliveryStatus: limited?.delivery_status, deliveryError: limited?.delivery_error }),
    `${limited?.delivery_status}/${limited?.delivery_error}`);

  reset();
  await processComment(
    { comment_id: 'c5', message: 'hi', from: { id: 'u1' } },
    ctxWith({ replyToComment: async () => { throw graphError(401, 190); } }),
    base()
  );
  const auth = outboundRows()[0];
  check('expired token: failed but NOT retryable',
    auth?.delivery_status === 'failed' && auth?.delivery_error === 'meta_auth_expired' &&
    !isRetryableDeliveryRow({ deliveryStatus: auth?.delivery_status, deliveryError: auth?.delivery_error }));

  reset();
  await processComment(
    { comment_id: 'c6', message: 'hi', from: { id: 'u1' } },
    ctxWith({ replyToComment: async () => { throw graphError(403, 200); } }),
    base()
  );
  const perm = outboundRows()[0];
  check('missing permission: failed but NOT retryable',
    perm?.delivery_status === 'failed' && perm?.delivery_error === 'meta_permission' &&
    !isRetryableDeliveryRow({ deliveryStatus: perm?.delivery_status, deliveryError: perm?.delivery_error }));
}

/* ============ 5. D3 — INBOUND PERSISTENCE FAILS CLOSED ================== */
console.log('\n--- 5. no durable inbound record means no reply at all ---');
for (const [label, value, run] of [
  ['comment', { comment_id: 'c7', message: 'hi', from: { id: 'u1' } }, processComment],
  ['DM', { message: { mid: 'm3', text: 'hi' }, sender: { id: 'u1' } }, processMessage]
]) {
  reset();
  let sent = 0, analyzed = 0;
  faults.insertInbound = true;
  const meta = run === processComment
    ? { replyToComment: async () => { sent++; return { id: 'r1' }; } }
    : { sendMessengerReply: async () => { sent++; return { message_id: 'd1' }; } };

  let threw = false;
  await run(value, ctxWith(meta), base({
    analyze: async () => { analyzed++; return { reply: 'ok', intent: 'i', inScope: true, lang: 'en', escalate: false }; }
  })).catch(() => { threw = true; });

  check(`${label}: nothing was sent`, sent === 0, `sent=${sent}`);
  check(`${label}: the AI was never even invoked`, analyzed === 0, `analyzed=${analyzed}`);
  check(`${label}: the failure propagates so the worker can retry`, threw);
  check(`${label}: no outbound row was created`, outboundRows().length === 0);
}
{
  // Legacy mode (no database at all) keeps its previous behaviour.
  reset();
  let sent = 0;
  await processComment(
    { comment_id: 'c8', message: 'hi', from: { id: 'u1' } },
    ctxWith({ replyToComment: async () => { sent++; return { id: 'r1' }; } }),
    base({ pgEnabled: false })
  );
  check('with no database configured the legacy inline path still replies', sent === 1);
}

/* ============ 6. D4 — EXCEPTION AFTER THE SEND WAS ATTEMPTED =========== */
console.log('\n--- 6. a post-send failure makes the event permanently unclaimable ---');
{
  // Mirrors the real webhook_events semantics, including the payload the claim
  // hands back to the pipeline.
  const PAYLOAD = {
    eventType: 'message', pageId: 'p1',
    entry: { id: 'p1' },
    messaging: [{ message: { mid: 'E1', text: 'x' }, sender: { id: 'u1' } }]
  };
  const events = new Map();
  const put = (id, status = 'received') =>
    events.set(id, { id, status, error: null, payload: PAYLOAD });

  const claim = ({ externalId }) => {
    const row = events.get(externalId);
    if (!row) return null;
    // Exactly the production condition: 'processing', 'done' and 'unknown' are
    // all refused.
    if (row.status !== 'received' && row.status !== 'failed') return null;
    row.status = 'processing';
    return row;
  };
  const updateEvent = ({ externalId, status, error }) => {
    const row = events.get(externalId);
    if (!row) return null;
    row.status = status;
    row.error = error ?? null;
    return row;
  };

  const deps = (ledgerState, throwAfter) => ({
    claim,
    updateEvent,
    buildCtx: async () => ({ tenantId: 'ten1', brandId: 'b1', pageId: 'p1', metaClient: {} }),
    pgEnabled: false,
    onMessage: async (_m, _ctx, { ledger }) => {
      if (ledgerState) { ledger.started = true; ledger.outcome = ledgerState; }
      if (throwAfter) { const e = new Error('post-processing blew up'); e.code = 'E_POST'; throw e; }
    }
  });

  // (a) nothing was sent -> 'failed', and a bounded retry may re-claim it.
  put('E1');
  await processQueuedMetaEvent({ provider: 'meta', eventId: 'E1' }, deps(null, true)).catch(() => {});
  const notSent = events.get('E1');
  check('failure before any send -> failed + re-claimable',
    notSent.status === 'failed' && claim({ provider: 'meta', externalId: 'E1' }) != null,
    `${notSent.status}`);

  // (b) a send was attempted -> 'unknown', and the claim REFUSES it forever.
  put('E2');
  await processQueuedMetaEvent({ provider: 'meta', eventId: 'E2' }, deps('delivered', true)).catch(() => {});
  const attempted = events.get('E2');
  check('failure AFTER a send attempt -> unknown, not failed', attempted.status === 'unknown', attempted.status);
  check('the unknown event is never re-claimed (BullMQ retry is refused)',
    claim({ provider: 'meta', externalId: 'E2' }) === null);
  check('three further BullMQ retries still cannot claim it', (() => {
    let wins = 0;
    for (let i = 0; i < 3; i++) if (claim({ provider: 'meta', externalId: 'E2' })) wins++;
    return wins === 0;
  })());
  check('the reason is recorded for operators', attempted.error === 'OUTBOUND_ATTEMPTED');
  check('a send that completed normally still marks the event done', await (async () => {
    put('E4');
    const r = await processQueuedMetaEvent({ provider: 'meta', eventId: 'E4' }, deps('delivered', false));
    return r?.ok === true && events.get('E4').status === 'done';
  })());
}

/* ============ 7. WORKER CRASH AFTER META ACCEPTS ======================= */
console.log('\n--- 7. a worker crash after a send leaves the row unclaimable ---');
{
  const events = new Map([['E3', { id: 'E3', status: 'processing', error: null, payload: {} }]]);
  const claim = ({ externalId }) => {
    const row = events.get(externalId);
    if (!row || (row.status !== 'received' && row.status !== 'failed')) return null;
    row.status = 'processing';
    return row;
  };
  check('a row left mid-flight is never reclaimed',
    claim({ provider: 'meta', externalId: 'E3' }) === null);
  check('and it stays that way across many attempts', (() => {
    for (let i = 0; i < 5; i++) claim({ provider: 'meta', externalId: 'E3' });
    return events.get('E3').status === 'processing';
  })());
}

/* ============ 8. PRIVACY OF THE ESCALATION LOG ========================= */
console.log('\n--- 8. escalation logging carries no customer content ---');
{
  const SECRET_TEXT = 'my card number is 4111 1111 1111 1111';
  const SECRET_PSID = 'PSID-9f8e7d6c-secret';
  const view = escalationLogView({
    channel: 'messenger', from: { id: SECRET_PSID, name: 'Nour El-Amin' },
    message: SECRET_TEXT, reason: 'contact data', draft: { reply: 'call us', intent: 'hours', lang: 'en' },
    commentId: 'cmt_secret'
  });
  const serialised = JSON.stringify(view);
  check('the raw message text never reaches the log', !serialised.includes('4111'));
  check('the raw PSID never reaches the log', !serialised.includes(SECRET_PSID));
  check('the raw commenter name never reaches the log', !serialised.includes('Nour El-Amin'));
  check('the raw comment id never reaches the log', !serialised.includes('cmt_secret'));
  check('operational signal survives (length, intent, channel)',
    view.messageChars === SECRET_TEXT.length && view.intent === 'hours' && view.channel === 'messenger');
  check('customer id is still correlatable across log lines',
    view.customerId === escalationLogView({ from: { id: SECRET_PSID } }).customerId);

  const notifySrc = readFileSync(new URL('../src/notify.js', import.meta.url), 'utf8');
  check('notifyStaff no longer serialises the raw payload',
    !/JSON\.stringify\(info/.test(notifySrc));
  check('notifyStaff logs the redacted view',
    /JSON\.stringify\(escalationLogView\(info\)\)/.test(notifySrc));
}

/* ============ 9. TENANT / BRAND ISOLATION UNCHANGED ==================== */
console.log('\n--- 9. the tenant comes from the resolved context, never the payload ---');
{
  reset();
  const payload = { eventType: 'message', pageId: 'p1', entry: { id: 'p1' }, tenantId: 'ATTACKER', messaging: [] };
  let seenTenant = null;
  await processQueuedMetaEvent({ provider: 'meta', eventId: 'TEN1' }, {
    claim: () => ({ payload }),
    updateEvent: () => {},
    buildCtx: async () => { seenTenant = 'from-db'; return { tenantId: 'real-tenant', brandId: 'real-brand', pageId: 'p1', metaClient: {} }; },
    onMessage: async () => {},
    pgEnabled: false
  }).catch(() => {});
  check('routing resolves the tenant from the database',
    seenTenant === 'from-db' && (await import('../src/workers/metaEventPipeline.js')) !== null);

  const pipelineSrc = readFileSync(new URL('../src/workers/metaEventPipeline.js', import.meta.url), 'utf8');
  check('the pipeline never reads a tenant from the payload',
    !/normalized\.tenantId|row\.tenant_id\s*===/.test(pipelineSrc));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);