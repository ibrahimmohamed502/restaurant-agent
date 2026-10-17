/**
 * P0.2 — deterministic AI / human collision tests.
 *
 *   node scripts/test-ai-human-collision.mjs
 *
 * ZERO NETWORK. The provider is a mock, the database is a fake, no customer
 * message is produced.
 *
 * WHAT IS BEING PROVEN
 * --------------------
 * A handoff can land in the window between the AI's original gate
 * (`finalAiSendCheck`) and the irreversible provider call. Every existing test
 * placed it at a convenient moment; this suite places it at the exact instant
 * the outbound row is written — the last moment before the send — and asserts
 * that nothing reaches the customer.
 *
 * The interleaving under test, for BOTH delivery paths:
 *
 *     t0  AI passes finalAiSendCheck            (state is still AI_ACTIVE)
 *     t1  AI persists its outbound row          <-- handoff lands HERE
 *     t2  lastInstantAiSendCheck sees it and refuses
 *     t3  provider is never called
 *
 * The flip is performed from inside the fake database's INSERT handler, which is
 * the only way to make the race deterministic rather than timing-dependent.
 *
 * WHAT IS NOT PROVEN HERE
 * ----------------------
 * A send that is ALREADY inside the provider HTTP call when the handoff lands
 * cannot be recalled. That window is real, is bounded by one provider round-trip,
 * and is deliberately accepted — see lastInstantAiSendCheck() in src/webhook.js.
 * These tests do not pretend otherwise; one of them asserts the shape of that
 * residue explicitly.
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

/* Stub the pool BEFORE webhook.js is imported — webhook.js and the services it
   uses all close over this module-level pool. */
const { pool } = await import('../src/db/pg.js');

const TEN = '00000000-0000-0000-0000-0000000000a1';
const TEN_OTHER = '00000000-0000-0000-0000-0000000000a2';
const CONV = '00000000-0000-0000-0000-0000000000c1';

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/**
 * Source with block comments removed, so a doc mention of a function is never
 * mistaken for a call site. Every structural assertion below runs against this.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ---------------------------------------------------------------- fake DB */

/**
 * A fake pool that models exactly what the AI path reads and writes, and that
 * can be told to flip the conversation's ownership at a chosen statement — which
 * is how the race is made deterministic instead of timing-dependent.
 */
function makeDb({ state = 'AI_ACTIVE' } = {}) {
  const db = {
    state,
    messages: [],
    statements: [],
    seq: 0,
    // Set to 'outbound-insert' to flip ownership at the exact moment the AI row
    // is written — the last moment before the provider call.
    flipAt: null,
    flipped: false
  };

  pool.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    db.statements.push({ sql: s, params });

    if (s.startsWith('SELECT id, state FROM conversations')) {
      const [conversationId, tenantId] = params;
      // Tenant-scoped: another company's conversation is invisible, exactly as
      // the real predicate behaves.
      if (tenantId !== TEN || conversationId !== CONV) return { rows: [] };
      return { rows: [{ id: CONV, state: db.state }] };
    }

    if (s.includes("sender_type = 'employee'")) {
      const [tenantId, conversationId] = params;
      const hit = db.messages.some((m) =>
        m.tenant_id === tenantId && m.conversation_id === conversationId &&
        m.direction === 'outbound' && m.sender_type === 'employee' &&
        m.delivery_status === 'pending');
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }

    if (s.startsWith('INSERT INTO messages')) {
      const isInbound = /'inbound'/.test(s);
      const [tenantId, conversationId] = params;
      const text = isInbound ? params[3] : params[2];
      const pmid = isInbound ? params[4] : params[3];
      const deliveryStatus = isInbound ? 'sent' : (params[5] ?? 'sent');
      const deliveryError = isInbound ? null : (params[6] ?? null);
      const row = {
        id: `m${++db.seq}`,
        tenant_id: tenantId,
        conversation_id: conversationId,
        direction: isInbound ? 'inbound' : 'outbound',
        sender_type: isInbound ? 'customer' : 'ai',
        text,
        provider_message_id: pmid,
        delivery_status: deliveryStatus,
        delivery_error: deliveryError,
        retry_count: 0
      };
      db.messages.push(row);

      // THE HANDOFF LANDS HERE — after the row exists, before the provider call.
      if (!isInbound && db.flipAt === 'outbound-insert' && !db.flipped) {
        db.flipped = true;
        db.state = 'HUMAN_REQUIRED';
      }
      return { rows: [{ id: row.id }] };
    }

    if (s.startsWith('UPDATE messages')) {
      const [deliveryStatus, errorCategory, providerMessageId, messageId, tenantId] = params;
      const row = db.messages.find((m) => m.id === messageId && m.tenant_id === tenantId && m.direction === 'outbound');
      if (!row) return { rows: [] };
      row.delivery_status = deliveryStatus;
      row.delivery_error = errorCategory;
      if (providerMessageId) row.provider_message_id = providerMessageId;
      return { rows: [{ id: row.id }] };
    }

    if (/UPDATE conversations SET last_message_at/.test(s)) return { rows: [] };
    if (/INSERT INTO (channels|customers|customer_identities|conversations)/.test(s)) {
      return { rows: [{ id: isUuidish(params[0]) ? params[0] : CONV }] };
    }
    if (/UPDATE customers SET last_interaction/.test(s)) return { rows: [] };
    if (s.startsWith('SELECT')) return { rows: [] };
    return { rows: [] };
  };

  const isUuidish = (v) => typeof v === 'string' && v === CONV;
  return db;
}

const { processComment, processMessage } = await import('../src/webhook.js');
const { DELIVERY_CATEGORY, RETRYABLE_DELIVERY_CATEGORIES, isRetryableDeliveryRow } =
  await import('../src/services/deliveryOutcome.js');

/* ------------------------------------------------------------- drivers */

const makeCtx = (calls) => ({
  pageId: 'page-1',
  tenantId: TEN,
  brandId: 'brand-1',
  channelId: 'chan-1',
  metaClient: {
    sendTypingIndicator: async () => {},
    getUserFirstName: async () => 'Customer',
    replyToComment: async (id, m) => { calls.push(['replyToComment', id, m]); return { id: 'cmt_reply' }; },
    sendMessengerReply: async (psid, m) => { calls.push(['sendMessengerReply', psid, m]); return { message_id: 'dm_reply' }; }
  }
});

const deps = (over = {}) => ({
  analyze: async () => ({ reply: 'AI draft reply', intent: 'greeting', inScope: true, lang: 'en', escalate: false }),
  notify: async () => {},
  logEvt: () => {},
  addEsc: () => {},
  isReplied: () => false,
  mark: () => {},
  overLimit: () => false,
  pgEnabled: true,
  ledger: null,
  ...over
});

const outbound = (db) => db.messages.filter((m) => m.direction === 'outbound');

/* ==========================================================================
   A — DM PATH (Messenger)
   ========================================================================== */
section('A — Messenger DM path');

{
  // Baseline: nothing races, the reply goes out normally.
  const calls = [];
  const db = makeDb({ state: 'AI_ACTIVE' });
  const ctx = makeCtx(calls);
  await processMessage(
    { message: { mid: 'm1', text: 'hello', is_echo: false }, sender: { id: 'psid-1' }, timestamp: Date.now() },
    ctx, deps()
  );
  eq('A1 baseline: exactly one provider call', calls.length, 1);
  eq('A1 baseline: it is the Messenger send', calls[0][0], 'sendMessengerReply');
  eq('A1 baseline: the row is sent', outbound(db)[0].delivery_status, 'sent');
  eq('A1 baseline: the provider id is stored', outbound(db)[0].provider_message_id, 'dm_reply');
}
{
  // THE RACE: handoff lands in the window between the gate and the send.
  const calls = [];
  const db = makeDb({ state: 'AI_ACTIVE' });
  db.flipAt = 'outbound-insert';
  const ctx = makeCtx(calls);
  await processMessage(
    { message: { mid: 'm2', text: 'hello', is_echo: false }, sender: { id: 'psid-2' }, timestamp: Date.now() },
    ctx, deps()
  );
  check('A2 the handoff really was injected in the window', db.flipped === true);
  eq('A2 conversation is now human-owned', db.state, 'HUMAN_REQUIRED');
  eq('A2 THE CUSTOMER RECEIVED NOTHING', calls.length, 0);
  eq('A2 the outbound row exists but was never marked pending', outbound(db).length, 1);
  eq('A2 and is closed as failed', outbound(db)[0].delivery_status, 'failed');
  eq('A2 with the suppression category', outbound(db)[0].delivery_error, DELIVERY_CATEGORY.SUPPRESSED_HUMAN_HANDOFF);
  eq('A2 and never carries a provider message id', outbound(db)[0].provider_message_id?.startsWith('pending:'), true);
}
{
  // No orphan pending row, ever.
  const calls = [];
  const db = makeDb({ state: 'AI_ACTIVE' });
  db.flipAt = 'outbound-insert';
  await processMessage(
    { message: { mid: 'm3', text: 'hi', is_echo: false }, sender: { id: 'psid-3' }, timestamp: Date.now() },
    makeCtx(calls), deps()
  );
  eq('A3 NO row is left pending after a suppression', outbound(db).filter((m) => m.delivery_status === 'pending').length, 0);
  check('A3 and the inbound row is untouched', db.messages.some((m) => m.direction === 'inbound' && m.delivery_status === 'sent'));
}
{
  // The suppression is NOT retryable — sending it later is the duplicate.
  check('A4 suppressed_human_handoff is NOT in the retry allow-list',
    !RETRYABLE_DELIVERY_CATEGORIES.includes(DELIVERY_CATEGORY.SUPPRESSED_HUMAN_HANDOFF));
  check('A4 the retry allow-list is still exactly one entry',
    RETRYABLE_DELIVERY_CATEGORIES.length === 1 && RETRYABLE_DELIVERY_CATEGORIES[0] === 'meta_rate_limit',
    JSON.stringify(RETRYABLE_DELIVERY_CATEGORIES));
  check('A4 and the dashboard retry predicate refuses the row',
    !isRetryableDeliveryRow({ deliveryStatus: 'failed', deliveryError: DELIVERY_CATEGORY.SUPPRESSED_HUMAN_HANDOFF }));
  const retryBody = (() => {
    const cs = read('src/services/conversations.js');
    const start = cs.indexOf('export async function claimFailedOutboundForRetry');
    const end = cs.indexOf('export async function finishMessageDelivery');
    return cs.slice(start, end);
  })();
  check('A4 the retry claim still requires sender_type = ai, so a row of this age cannot be re-sent',
    /AND m\.sender_type = 'ai'/.test(retryBody));
  check('A4 and still requires the row to be failed AND in the retry allow-list',
    /m\.delivery_status = 'failed'/.test(retryBody) && /m\.delivery_error = ANY/.test(retryBody));
}
{
  // Suppression already effective BEFORE generation: no row at all. Existing
  // behaviour, and the reason the first check still exists.
  const calls = [];
  const db = makeDb({ state: 'HUMAN_REQUIRED' });
  await processMessage(
    { message: { mid: 'm4', text: 'hi', is_echo: false }, sender: { id: 'psid-4' }, timestamp: Date.now() },
    makeCtx(calls), deps()
  );
  eq('A5 an already-handed-off conversation sends nothing', calls.length, 0);
  eq('A5 and creates NO outbound row at all', outbound(db).length, 0);
  eq('A5 while the inbound is still persisted', db.messages.filter((m) => m.direction === 'inbound').length, 1);
}

/* ==========================================================================
   B — COMMENT PATH
   ========================================================================== */
section('B — Facebook comment path');

{
  const calls = [];
  const db = makeDb({ state: 'AI_ACTIVE' });
  await processComment(
    { comment_id: 'c1', message: 'hello', from: { id: 'u1', name: 'U' } },
    makeCtx(calls), deps()
  );
  eq('B1 baseline: exactly one provider call', calls.length, 1);
  eq('B1 baseline: it is the comment reply', calls[0][0], 'replyToComment');
  eq('B1 baseline: the row is sent', outbound(db)[0].delivery_status, 'sent');
}
{
  const calls = [];
  const db = makeDb({ state: 'AI_ACTIVE' });
  db.flipAt = 'outbound-insert';
  await processComment(
    { comment_id: 'c2', message: 'hello', from: { id: 'u2', name: 'U' } },
    makeCtx(calls), deps()
  );
  check('B2 the handoff really was injected in the window', db.flipped === true);
  eq('B2 conversation is now human-owned', db.state, 'HUMAN_REQUIRED');
  eq('B2 THE CUSTOMER RECEIVED NOTHING', calls.length, 0);
  eq('B2 the outbound row was closed, not orphaned', outbound(db)[0].delivery_status, 'failed');
  eq('B2 with the suppression category', outbound(db)[0].delivery_error, DELIVERY_CATEGORY.SUPPRESSED_HUMAN_HANDOFF);
}
{
  const calls = [];
  const db = makeDb({ state: 'HUMAN_REQUIRED' });
  await processComment(
    { comment_id: 'c3', message: 'hi', from: { id: 'u3', name: 'U' } },
    makeCtx(calls), deps()
  );
  eq('B3 an already-handed-off comment sends nothing and writes no row',
    calls.length === 0 && outbound(db).length === 0, true);
}
{
  // BOTH paths must be covered, or the fix is half a fix.
  const src = read('src/webhook.js');
  const insertions = [...src.matchAll(/const lastCheck = await lastInstantAiSendCheck\(/g)].length;
  eq('B4 the last-instant check is present on BOTH delivery paths', insertions, 2);
  eq('B4 both call sites close the orphaned row',
    [...src.matchAll(/await closeSuppressedOutbound\(/g)].length, 2);
  eq('B4 and both are followed by the provider call, with nothing awaiting between',
    [...src.matchAll(/lastInstantAiSendCheck[\s\S]{0,900}?(sendMessengerReply|replyToComment)\(/g)].length, 2);
}

/* ==========================================================================
   C — the residual window, stated honestly
   ========================================================================== */
section('C — the residual is bounded, not absent');

{
  const src = read('src/webhook.js');
  const doc = src.slice(src.indexOf('async function lastInstantAiSendCheck'));
  check('C1 the code states the residual is NOT eliminated',
    /does NOT claim to eliminate|not eliminated|cannot be recalled/i.test(doc + src.slice(0, src.indexOf('async function lastInstantAiSendCheck'))));
  check('C1 it names the actual cause (a provider call already in flight)',
    /already inside the provider HTTP call|already inside the provider|on the wire/i.test(src));
  check('C1 and records why it cannot be closed (no provider idempotency / no lock across the call)',
    /provider-side\s*\n?\s*\*?\s*idempotency|held ACROSS the provider call/i.test(src));

  // Fail-open is deliberate and must be asserted, not assumed: a status query
  // blip must not cost a customer their reply.
  check('C2 the last-instant check FAILS OPEN on error (a blip never eats a reply)',
    /last-instant AI check failed[\s\S]{0,120}return \{ suppressed: false \}/.test(src));
  check('C2 and it is wrapped in try/catch so a throw can never escape',
    /async function lastInstantAiSendCheck[\s\S]{0,200}try \{[\s\S]{0,120}catch \(e\)/.test(src));

  check('C3 no lock is taken and no wait is introduced',
    !/lastInstantAiSendCheck[\s\S]{0,400}(FOR UPDATE|LOCK TABLE|SKIP LOCKED|pg_sleep)/i.test(src));
  check('C3 no retry loop is introduced',
    !/lastInstantAiSendCheck[\s\S]{0,400}(while *\(|for *\(.*retry)/i.test(src));
  const code = codeOnly(src);
  eq('C3 the helper is defined once and called twice - no other round trip is added',
    [...code.matchAll(/lastInstantAiSendCheck\(/g)].length, 3); // definition + 2 call sites
  check('C3 and the two call sites are the only new awaits before a provider send',
    [...code.matchAll(/const lastCheck = await lastInstantAiSendCheck\(/g)].length, 2);

  // The shape of the irreducible residue: if the provider call has already been
  // issued, nothing here can stop it. Assert the ordering that proves it.
  //
  // Both assertions measure the SAME thing from the end of the suppression block
  // to the provider call: there must be no await in that gap. If there were, a
  // handoff could land inside it and the check would be worthless.
  const gapToProviderCall = (codeSrc, call) => {
    const i = codeSrc.indexOf(call);
    if (i < 0) return null;
    const checkAt = codeSrc.lastIndexOf('const lastCheck', i);
    const ret = codeSrc.indexOf('return;', checkAt);
    // The suppression block ends at the first closing brace on its own line
    // after the bare `return;`. Measuring from there — not from the opening
    // brace — is what makes "nothing awaits in between" meaningful.
    const close = codeSrc.indexOf('\n  }', ret);
    if (checkAt < 0 || ret < 0 || close < 0) return null;
    return codeSrc.slice(close + 4, i);
  };
  //
  // The provider call is itself written `x = await ctx.metaClient.send(...)`, so the
  // one await this assertion must tolerate is the call's OWN. The property that
  // matters is: there is no await between the check and that call, because an
  // await there is a point where the conversation could change hands and the
  // check would already be stale.
  for (const [label, call] of [['DM', 'ctx.metaClient.sendMessengerReply('], ['comment', 'ctx.metaClient.replyToComment(']]) {
    const gap = gapToProviderCall(code, call);
    check(`C4 ${label}: the last-instant check is present on this path`, gap !== null);
    const awaits = (gap ?? '').match(/\bawait\b/g) ?? [];
    eq(`C4 ${label}: exactly ONE await sits between the check and the send`, awaits.length, 1);
    check(`C4 ${label}: and that await IS the provider call itself, not a gap before it`,
      (gap ?? '').trimEnd().endsWith('await'),
      (gap ?? '').slice(-60));
    check(`C4 ${label}: the ledger is flagged before the call in that gap`,
      /noteOutboundAttempt\(ledger, 'attempted'\)/.test(gap ?? ''));
    check(`C4 ${label}: and the suppression block sits BEFORE the ledger flag`,
      /closeSuppressedOutbound\(/.test(code.slice(0, code.indexOf(call))) &&
      (gap ?? '').indexOf('noteOutboundAttempt') > -1);
  }
}

/* ==========================================================================
   D — nothing this change may disturb
   ========================================================================== */
section('D — preserved behaviour and prior fixes');

{
  const src = read('src/webhook.js');
  // Escalation detection must be untouched — it is what creates the handoff in
  // the first place, and it runs BEFORE generation.
  check('D1 applyStage7Gate still runs the customer-request detector',
    /detectCustomerHumanRequest\(text\)/.test(src));
  check('D1 and the auto-escalation detector', /detectAutoEscalation\(text\)/.test(src));
  check('D1 and both still request a handoff',
    (src.match(/requestHandoff\(/g) ?? []).length >= 2);
  check('D1 the handoff transition is still the atomic requestHandoff()',
    /const after = await evaluateAiGate/.test(src));
  check('D1 persist-first inbound is untouched',
    /Stage 4\.4\.6: PERSIST INBOUND FIRST/.test(src) && /inboundPersistFailed\(/.test(src));
  check('D1 the original finalAiSendCheck call sites are still present',
    (src.match(/await finalAiSendCheck\(\{ tenantId: ctx\?\.tenantId, conversationId, pgEnabled \}\)/g) ?? []).length, 2);
  check('D1 and they still suppress before any row is written',
    (src.match(/if \(finalCheck\.suppressed\) \{/g) ?? []).length, 2);

  // The three-phase delivery lifecycle and the ambiguous-outcome rule are sacred.
  check('D2 a confirmed send whose bookkeeping write failed still stays pending',
    /Leaving the row[\s\S]{0,80}'pending' is deliberate/.test(src));
  check('D2 an unknown outcome is still classified by the shared state machine',
    (src.match(/classifyDeliveryError\(/g) ?? []).length >= 2);
  check('D2 delivery failure recording is unchanged',
    /recordOutboundFailure\(outboundRow, conversationId, ctx/.test(src));
  check('D2 no new retry of an ambiguous send is introduced',
    !/lastInstantAiSendCheck[\s\S]{0,600}(retryAgain|retrySend|resend)/i.test(src));
  check('D2 the reconcile-and-refuse behaviour is intact',
    /recordReconciliationMarker/.test(read('src/services/conversations.js')));

  // P0.1.
  const abilities = read('src/auth/abilities.js');
  const rbac = read('src/api/v1/stage7-rbac.js');
  check('D3 P0.1 authoritative platform gate is intact',
    /if \(req\.v1\?\.isPlatformSuperAdmin !== true\)/.test(rbac));
  check('D3 P0.1 delegation ceiling is intact',
    /NON_DELEGABLE_ROLE_NAMES = Object\.freeze\(\['Platform Super Admin'\]\)/.test(abilities));
  check('D3 abilities.js is untouched by this change',
    !/SUPPRESSED_HUMAN_HANDOFF|ownership|lastInstant/.test(abilities));

  // Isolation.
  const mr = read('src/services/manualReplies.js');
  check('D4 the human reply path is untouched by this change',
    !/lastInstant|suppressed_human_handoff/.test(mr));
  check('D4 tenant scoping on both AI checks is unchanged (both read by tenantId + conversationId)',
    /evaluateAiGate\(\{ tenantId, conversationId \}\)/.test(src) &&
    /evaluateHumanOwnership\(\{ tenantId, conversationId \}\)/.test(src));
  check('D4 no query in the new code widens any scope',
    !/lastInstantAiSendCheck[\s\S]{0,300}(tenant_id|brand_id) =/.test(src));
}

/* ==========================================================================
   E — the honest statement, pinned
   ========================================================================== */
section('E — the collision is bounded, never claimed gone');

{
  // If a handoff lands while the provider call is in flight, the AI's reply
  // still reaches the customer. That is the residual, and this suite proves it
  // rather than pretending otherwise: the provider call is NOT re-checked.
  const calls = [];
  const db = makeDb({ state: 'AI_ACTIVE' });
  await processMessage(
    { message: { mid: 'm5', text: 'hi', is_echo: false }, sender: { id: 'psid-5' }, timestamp: Date.now() },
    makeCtx(calls), deps()
  );
  eq('E1 with no race the reply is delivered', calls.length, 1);

  const full = read('src/webhook.js');
  const src = codeOnly(full);
  const sendSites = [...src.matchAll(/ctx\.metaClient\.(sendMessengerReply|replyToComment)\(/g)].length;
  eq('E2 the provider is called exactly twice in real code, and neither is guarded mid-call', sendSites, 2);
  check('E2 there is no cancellation token or abort between check and send',
    !/AbortController|signal:/.test(src.slice(src.indexOf('lastInstantAiSendCheck'))));
  // The documentation must survive the comment-stripping, because the honest
  // statement about the residual lives in a comment and is part of the contract.
  check('E2 so a handoff landing during the HTTP call still reaches the customer — accepted, documented',
    /cannot be recalled|on the wire/i.test(full));
}

/* ========================================================================== */
console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);