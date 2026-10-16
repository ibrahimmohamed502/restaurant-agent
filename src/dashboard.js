/**
 * Admin dashboard — Stage 2: real auth (DB sessions + RBAC) with legacy fallback.
 *   GET  /dashboard/login     → login page (email+password; single password in legacy mode)
 *   POST /dashboard/login     → creates DB session (or legacy cookie)
 *   GET  /dashboard/logout
 *   GET  /dashboard           → main panel (RTL, auto-refresh, Team tab for admins)
 *   GET  /dashboard/api/me
 *   GET  /dashboard/api/stats · /events · /escalations · POST .../escalations/:id/resolve
 */
import express from 'express';
// logEvent is still used by the webhook path; the read/resolve helpers are no
// longer called because the endpoints they backed are retired above.
import { logEvent } from './db.js';
import {
  claimFailedOutboundForRetry,
  finishMessageDelivery,
  recordReconciliationMarker,
  summarizeUnresolvedOutbound,
  getConversationChannelContext,
} from './services/conversations.js';
import { resolveMetaChannel } from './services/channelResolver.js';
import { can } from './auth/abilities.js';
import {
  classifyDeliveryError,
  createOutboundLedger,
  DELIVERY_CATEGORY
} from './services/deliveryOutcome.js';
import { safeErrorCode } from './services/redact.js';
import {
  brandScopeFromSession,
  brandScopeSql
} from './api/v1/brandAccess.js';
import { createMetaClient } from './facebook.js';
import { enabled, pool } from './db/pg.js';
import { requireAuth, makeLegacyToken } from './auth/middleware.js';
import { createSession, revokeSession, sessionCookie } from './auth/sessions.js';
import { verifyPassword } from './auth/passwords.js';
import { lockedSeconds, recordFailedLogin, resetLoginAttempts } from './auth/ratelimit.js';
import { audit } from './auth/audit.js';

export const dashboardRouter = express.Router();

/* --------------------------------- login --------------------------------- */

dashboardRouter.get('/dashboard/login', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول — LWC Dashboard</title>
<style>${BASE_CSS}</style></head><body class="center">
<form class="card login" method="POST" action="/dashboard/login">
  <div class="logo">🍫</div>
  <h1>Life with Cacao</h1><p class="muted">لوحة تحكم الـ AI Agent</p>
  ${enabled ? `
  <input type="email" name="email" placeholder="البريد الإلكتروني" autocomplete="username" required>
  <input type="password" name="password" placeholder="كلمة السر" autocomplete="current-password" required>` : `
  <input type="password" name="legacy_password" placeholder="كلمة السر" autofocus required>`}
  <button type="submit">دخول</button>
</form></body></html>`);
});

dashboardRouter.post('/dashboard/login', express.urlencoded({ extended: false }), async (req, res) => {
  // Legacy mode (no Postgres yet): single shared password
  if (!enabled) {
    const ok = req.body.legacy_password === (process.env.DASHBOARD_PASSWORD || '');
    if (!ok) return res.redirect('/dashboard/login?e=1');
    res.cookie('lwc_dash', makeLegacyToken(), { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    return res.redirect('/dashboard');
  }

  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!email || !password) return res.redirect('/dashboard/login?e=1');

  const locked = await lockedSeconds(email, req.ip);
  if (locked > 0) {
    audit({ action: 'auth.login.locked', objectType: 'user', ip: req.ip, metadata: { email, locked } });
    return res.type('html').send(`<html lang="ar" dir="rtl"><body style="font-family:sans-serif;display:grid;place-items:center;min-height:100vh;background:#f4f1ec"><div style="background:#fff;padding:30px;border-radius:14px;text-align:center">⏳ محاولات كتير غلط — جرب تاني بعد <b>${Math.ceil(locked / 60)}</b> دقيقة<br><br><a href="/dashboard/login">رجوع</a></div></body></html>`);
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.password_hash, u.status,
            COALESCE(json_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '[]') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.email = $1 GROUP BY u.id`,
    [email]
  );
  const user = rows[0];

  if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
    await recordFailedLogin(email, req.ip);
    audit({ action: 'auth.login.fail', objectType: 'user', ip: req.ip, metadata: { email } });
    return res.redirect('/dashboard/login?e=1');
  }

  await resetLoginAttempts(email, req.ip);
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  const { token, expiresAt } = await createSession({
    tenantId: user.tenant_id,
    userId: user.id,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  audit({ tenantId: user.tenant_id, actorUserId: user.id, action: 'auth.login.success', objectType: 'user', objectId: user.id, ip: req.ip });
  res.cookie(sessionCookie, token, { httpOnly: true, sameSite: 'lax', maxAge: expiresAt.getTime() - Date.now() });
  res.redirect('/dashboard');
});

dashboardRouter.get('/dashboard/logout', async (req, res) => {
  const { sessionCookie: cookie } = await import('./auth/sessions.js');
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((p) => p.trim()).find((p) => p.startsWith(cookie + '='));
  if (match) await revokeSession(decodeURIComponent(match.slice(cookie.length + 1)));
  res.clearCookie(cookie);
  res.clearCookie('lwc_dash');
  res.redirect('/dashboard/login');
});

/* ---------------------------------- API ---------------------------------- */

/**
 * Authorisation guard for conversation-scoped dashboard routes.
 *
 * Two independent checks, both mandatory:
 *   1. an explicit ABILITY (server-authoritative; the UI is not a boundary);
 *   2. a BRAND SCOPE derived from that ability or from explicit grants.
 *
 * Returns the resolved scope, or null after having already sent the denial.
 * Never grants tenant-wide access implicitly: brandScopeFromSession() resolves
 * an absent grant from the caller's abilities, and denies everything else.
 */
function authorizeConversationAccess(req, res, ability, { denyCode = 'INSUFFICIENT_PERMISSION' } = {}) {
  const roles = req.auth?.roles ?? [];
  if (!can(roles, ability)) {
    audit({
      tenantId: req.auth?.tenantId ?? null,
      actorUserId: req.auth?.user?.id ?? null,
      action: 'dashboard.access.denied',
      objectType: 'conversation',
      objectId: String(req.params?.id ?? req.params?.conversationId ?? ''),
      ip: req.ip,
      metadata: { ability, deniedBy: 'ability' }
    });
    res.status(403).json({ error: 'forbidden', code: denyCode });
    return null;
  }
  return brandScopeFromSession(req.auth);
}

/** SQL fragment + params that restrict a channels-joined query to this scope. */
function scopePredicate(scope, startParam) {
  const f = brandScopeSql('ch', { tenantWideParam: startParam, brandIdsParam: startParam + 1 });
  return { sql: f.sql, params: f.params(scope) };
}

dashboardRouter.get('/dashboard/api/me', requireAuth, (req, res) => {
  res.json({ user: req.auth.user, roles: req.auth.roles });
});

/*
 * LEGACY JSON-STORE ENDPOINTS - RETIRED, FAILING CLOSED.
 *
 * These four routes read and wrote src/db.js, a single process-wide JSON file
 * (data/dashboard.json) that stores events and escalations with NO tenant_id and
 * NO brand_id. Because the records carry no company or brand dimension, brand
 * scoping cannot be applied to them at all: every row belongs to every tenant.
 *
 * As written they were therefore cross-tenant exposures of raw customer names,
 * customer message text and AI reply text, and the resolve route let ANY
 * authenticated user close ANY escalation id in the shared store with no
 * ownership check whatsoever.
 *
 * The authoritative data lives in Postgres and IS brand-scoped:
 *   GET  /api/v1/dashboard        - brand-scoped KPIs and preview rows
 *   GET  /api/v1/conversations    - brand-scoped Unified Inbox
 * The callers below are kept so the imports stay referenced and the removal is
 * obvious in review; nothing else in this file uses them.
 *
 * Nothing is deleted: data/dashboard.json is left exactly as it was, and the
 * Postgres rows these used to shadow are untouched.
 */
const LEGACY_STORE_RETIRED = (_req, res) => res.status(410).json({
  error: 'retired',
  code: 'LEGACY_UNPARTITIONED_STORE',
  message: 'This endpoint read a shared store with no tenant or brand dimension, '
    + 'so it could never be safely scoped. Use the brand-scoped /api/v1 endpoints instead.',
  replacements: {
    stats: '/api/v1/dashboard',
    events: '/api/v1/dashboard',
    escalations: '/api/v1/dashboard',
    conversationInbox: '/api/v1/conversations'
  }
});

dashboardRouter.get('/dashboard/api/stats', requireAuth, LEGACY_STORE_RETIRED);
dashboardRouter.get('/dashboard/api/events', requireAuth, LEGACY_STORE_RETIRED);
dashboardRouter.get('/dashboard/api/escalations', requireAuth, LEGACY_STORE_RETIRED);
dashboardRouter.post('/dashboard/api/escalations/:id/resolve', requireAuth, LEGACY_STORE_RETIRED);

/* --------------------------- Stage 3: Inbox API --------------------------- */

dashboardRouter.get('/dashboard/api/conversations', requireAuth, async (req, res) => {
  if (!enabled) return res.json([]);
  const scope = authorizeConversationAccess(req, res, 'conversation.read');
  if (!scope) return;

  // Brand visibility is enforced in the query itself, so a restricted operator
  // never sees another brand's conversations in the inbox at all.
  const sc = scopePredicate(scope, 2);
  const { rows } = await pool.query(
    `SELECT c.id, c.state, c.last_message_at, c.language, c.priority,
            cu.display_name AS customer_name, ch.provider,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_text
     FROM conversations c
     LEFT JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN channels ch ON ch.id = c.channel_id
     WHERE c.tenant_id = $1
       AND ${sc.sql}
     ORDER BY c.last_message_at DESC NULLS LAST
     LIMIT 100`,
    [req.auth.tenantId, ...sc.params]
  );
  res.json(rows);
});

dashboardRouter.get('/dashboard/api/conversations/:id', requireAuth, async (req, res) => {
  if (!enabled) return res.json(null);
  const scope = authorizeConversationAccess(req, res, 'conversation.read');
  if (!scope) return;

  const sc = scopePredicate(scope, 3);
  const { rows: [conv] } = await pool.query(
    `SELECT c.*, cu.display_name AS customer_name, ch.provider, ch.display_name AS channel_name
     FROM conversations c
     LEFT JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN channels ch ON ch.id = c.channel_id
     WHERE c.id = $1 AND c.tenant_id = $2
       AND ${sc.sql}`,
    [req.params.id, req.auth.tenantId, ...sc.params]
  );
  // Out-of-scope is indistinguishable from non-existent: the API must not work
  // as an existence oracle for brands the caller cannot see.
  if (!conv) return res.status(404).json({ error: 'not found' });
  const { rows: messages } = await pool.query(
    `SELECT id, direction, sender_type, text, created_at, delivery_status, delivery_error, retry_count, last_retry_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [conv.id]
  );
  res.json({ conversation: conv, messages });
});

/* ------------------------------ main page ------------------------------ */

// TEMP-DEBUG: public render to inspect the page (revert after diagnosing)
dashboardRouter.get('/dashboard-debug', (_req, res) => {
  _renderDashboard(res, { user: { id: 'debug', email: 'debug@debug', name: 'Debug' }, roles: ['Company Admin'], tenantId: 'debug' });
});

dashboardRouter.get('/dashboard', requireAuth, (req, res) => {
  _renderDashboard(res, req.auth);
});

/* ------------- unresolved outbound reconciliation (read-only) ------------- */
// GET /dashboard/api/reconciliation
// Aggregate counts of outbound messages whose record is incomplete. Same
// ability + tenant + brand policy as every other conversation-scoped route.
// Returns counts only: no ids, no customer names, no message bodies, no tokens.
dashboardRouter.get('/dashboard/api/reconciliation', requireAuth, async (req, res) => {
  if (!enabled) return res.status(503).json({ error: 'unavailable', code: 'DB_DISABLED' });
  const scope = authorizeConversationAccess(req, res, 'conversation.read', {
    denyCode: 'INSUFFICIENT_PERMISSION'
  });
  if (!scope) return;

  const summary = await summarizeUnresolvedOutbound({ tenantId: req.auth.tenantId, scope });
  // Fail closed: an unavailable report is never reported as "nothing unresolved".
  if (summary.unavailable) return res.status(503).json({ error: 'unavailable', code: 'RECONCILIATION_UNAVAILABLE' });
  res.json(summary);
});

/* ---------------- Stage 4.4.7: manual delivery retry ---------------- */
// POST /dashboard/api/conversations/:conversationId/messages/:messageId/retry
// Atomic failed → pending claim; only the winner performs the single Meta POST.
const retryLocks = new Map(); // messageId -> promise (in-process extra guard)
dashboardRouter.post('/dashboard/api/conversations/:conversationId/messages/:messageId/retry', requireAuth, async (req, res) => {
  const { conversationId, messageId } = req.params;
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return res.status(403).json({ error: 'forbidden', code: 'TENANT_REQUIRED' });
  if (!enabled) return res.status(503).json({ error: 'unavailable', code: 'DB_DISABLED' });

  // (1) AUTHORISATION — an explicit server-side ability, before anything is
  //     claimed. 'conversation.reply' is held by Company Admin and Supervisor
  //     only. Agent has 'conversation.reply_own' and is therefore denied;
  //     Platform Super Admin holds platform.* / company.* and is denied, so
  //     platform privileges never imply sending on behalf of a company.
  if (!can(req.auth?.roles ?? [], 'conversation.reply')) {
    audit({
      tenantId,
      actorUserId: req.auth?.user?.id ?? null,
      action: 'message.retry',
      objectType: 'message',
      objectId: messageId,
      ip: req.ip,
      metadata: { outcome: 'denied', deniedBy: 'ability', conversationId }
    });
    return res.status(403).json({ error: 'forbidden', code: 'INSUFFICIENT_PERMISSION' });
  }

  // (2) BRAND SCOPE — derived from an explicit ability or explicit grants.
  //     An absent grant is NOT tenant-wide: brandScopeFromSession() denies
  //     anything the caller's roles do not authorise.
  const scope = brandScopeFromSession(req.auth);

  // process-local concurrency guard (defense in depth; the DB claim is authoritative)
  if (retryLocks.has(messageId)) return res.status(409).json({ error: 'retry in progress', code: 'RETRY_IN_PROGRESS' });
  const lock = (async () => {
    // (3) ATOMIC CLAIM — tenant AND brand are evaluated inside the same
    //     conditional UPDATE that performs the state change, so there is no
    //     window between a permission check and the mutation.
    const claimed = await claimFailedOutboundForRetry({ tenantId, conversationId, messageId, scope });
    if (!claimed) {
      // The database refused the claim. Explain why so the operator is not left
      // clicking a button that can never work — and, more importantly, so an
      // UNKNOWN delivery outcome is never mistaken for a safe retry.
      const why = await describeRetryRefusal({ tenantId, conversationId, messageId });
      audit({
        tenantId,
        actorUserId: req.auth?.user?.id ?? null,
        action: 'message.retry',
        objectType: 'message',
        objectId: messageId,
        ip: req.ip,
        metadata: { outcome: 'refused', reason: why, conversationId }
      });
      return res.status(409).json({ error: 'not retryable', code: 'NOT_RETRYABLE', reason: why });
    }

    audit({
      tenantId,
      actorUserId: req.auth?.user?.id ?? null,
      action: 'message.retry',
      objectType: 'message',
      objectId: messageId,
      ip: req.ip,
      metadata: { outcome: 'claimed', conversationId, brandScope: scope.mode }
    });

    // ===================================================================
    // THREE ISOLATED PHASES
    //
    // The Meta call is the ONLY irreversible step, so it is isolated from both
    // the guards before it and the bookkeeping after it. They previously shared
    // ONE try/catch, so a failure to RECORD a successful send was handled by
    // the same branch as a failed send and written back as 'failed' — which is
    // what could make an already-delivered reply eligible for another send.
    //
    // The ledger records that an irreversible request was started. Once it is
    // set, no later failure may write a retryable state.
    // ===================================================================
    const ledger = createOutboundLedger();

    try {
      // ---- Phase 1: resolve routing + credential (nothing sent yet) ----
      const context = await getConversationChannelContext({ tenantId, conversationId });
      if (!context || context.tenant_id !== tenantId || !context.channel_id) {
        await finishMessageDelivery({ tenantId, messageId, deliveryStatus: 'failed', errorCategory: 'routing_unavailable' });
        return res.status(409).json({ error: 'not retryable', code: 'ROUTING_UNAVAILABLE' });
      }
      const resolved = await resolveMetaChannel(context.external_id, { includeCredential: true });
      if (resolved.channelId !== context.channel_id || resolved.tenantId !== tenantId || !resolved.credential) {
        await finishMessageDelivery({ tenantId, messageId, deliveryStatus: 'failed', errorCategory: 'credential_unavailable' });
        return res.status(409).json({ error: 'not retryable', code: 'CREDENTIAL_UNAVAILABLE' });
      }
      const threadKey = context.external_key ?? null;
      if (!threadKey) {
        await finishMessageDelivery({ tenantId, messageId, deliveryStatus: 'failed', errorCategory: 'missing_thread_context' });
        return res.status(409).json({ error: 'not retryable', code: 'MISSING_THREAD_CONTEXT' });
      }
      const client = createMetaClient({ accessToken: resolved.credential });

      // ---- Phase 2: the single Meta POST (the irreversible step) ----
      let providerId = null;
      try {
        // Flagged BEFORE the call, so neither a crash nor a late error can be
        // mistaken for "nothing was attempted".
        ledger.started = true;
        ledger.outcome = 'attempted';
        const resp = context.provider === 'meta_dm'
          ? await client.sendMessengerReply(threadKey, claimed.text)   // threadKey = PSID
          : await client.replyToComment(threadKey, claimed.text);     // threadKey = comment id
        providerId = resp?.message_id ?? resp?.id ?? null;
        ledger.outcome = 'delivered';
        ledger.category = null;
      } catch (err) {
        // The STRICT classifier decides the stored state:
        //   verified refusal -> 'failed' + a category the retry gate may allow
        //   unknown outcome  -> 'pending' + delivery_unknown, NEVER retryable
        // No automatic retry is introduced for an unknown outcome.
        const outcome = classifyDeliveryError(err);
        let recorded = false;
        try {
          // A zero-row UPDATE returns null rather than throwing, so the RETURNING
          // result must be checked — otherwise a write that changed nothing would
          // be reported as a recorded failure.
          const written = await finishMessageDelivery({
            tenantId, messageId,
            deliveryStatus: outcome.deliveryStatus,
            errorCategory: outcome.category
          });
          recorded = Boolean(written);
        } catch { /* the database rejected the write entirely */ }

        // BEST-EFFORT reconciliation marker. Attempted only because the outcome
        // is known, persisted only if the write succeeds, and never assumed.
        // It records that a state may have been lost; it never enables a resend.
        let marked = false;
        if (!recorded) {
          marked = await recordReconciliationMarker({
            tenantId,
            messageId,
            category: DELIVERY_CATEGORY.REFUSED_UNRECORDED
          }).catch(() => false);
        }

        console.warn(`⚠️ retry ${messageId} send failed [${outcome.category}] outcome=${outcome.outcome} recorded=${recorded} marked=${marked}`);
        // Sanitized category only — never a provider message, token or reply text.
        audit({
          tenantId,
          actorUserId: req.auth?.user?.id ?? null,
          action: 'message.retry',
          objectType: 'message',
          objectId: messageId,
          ip: req.ip,
          metadata: {
            outcome: 'send_failed',
            category: outcome.category,
            deliveryOutcome: outcome.outcome,
            retryable: outcome.retryable,
            recorded,
            marked,
            conversationId
          }
        });
        return res.status(502).json({
          ok: false,
          code: 'RETRY_FAILED',
          category: outcome.category,
          deliveryOutcome: outcome.outcome,
          retryable: outcome.retryable
        });
      }

      // ---- Phase 3: bookkeeping (delivery already CONFIRMED) ----
      let updated = null;
      let unrecordedReason = null;
      try {
        updated = await finishMessageDelivery({
          tenantId, messageId,
          deliveryStatus: 'sent',
          providerMessageId: providerId
        });
        // finishMessageDelivery returns rows[0] ?? null — a zero-row UPDATE does
        // NOT throw. Treating that null as success would write a false audit
        // record and a false success to the operator while nothing was stored.
        if (!updated) {
          unrecordedReason = 'no_row_updated';
        }
      } catch (dbErr) {
        unrecordedReason = safeErrorCode(dbErr);
      }

      if (!updated) {
        // Meta CONFIRMED this reply; the record was not updated.
        //
        // The row is left exactly as the claim set it — 'pending' with a cleared
        // category — which claimFailedOutboundForRetry refuses. Writing 'failed'
        // here is precisely what would let an operator re-send a message the
        // customer has already received.
        //
        // BEST-EFFORT marker: attempted because Meta confirmed delivery,
        // persisted only if the write succeeds, and never assumed to have landed.
        const marked = await recordReconciliationMarker({
          tenantId,
          messageId,
          category: DELIVERY_CATEGORY.DELIVERED_UNRECORDED
        }).catch(() => false);

        console.error(`❌ retry ${messageId} delivered to Meta but not recorded [${unrecordedReason}] marked=${marked}`);
        audit({
          tenantId,
          actorUserId: req.auth?.user?.id ?? null,
          action: 'message.retry',
          objectType: 'message',
          objectId: messageId,
          ip: req.ip,
          metadata: {
            outcome: 'delivered_unrecorded',
            reason: unrecordedReason,
            marked,
            conversationId
          }
        });
        // 200: the reply reached the customer. recorded=false tells the operator
        // not to retry; the row is not re-sendable in any case.
        return res.json({ ok: true, recorded: false, code: 'DELIVERED_UNRECORDED' });
      }

      logEvent({ channel: 'retry', customerName: null, customerId: null, message: `retry ${messageId} → sent`, reply: null, intent: null, inScope: true, lang: null, escalate: false });
      audit({
        tenantId,
        actorUserId: req.auth?.user?.id ?? null,
        action: 'message.retry',
        objectType: 'message',
        objectId: messageId,
        ip: req.ip,
        metadata: { outcome: 'sent', conversationId }
      });
      return res.json({ ok: true, message: updated });
    } catch (err) {
      // Phase 1 failed before any send. Recording the failure is safe because
      // the ledger proves nothing was sent.
      console.warn(`⚠️ retry ${messageId} could not be prepared [${safeErrorCode(err)}]`);
      audit({
        tenantId,
        actorUserId: req.auth?.user?.id ?? null,
        action: 'message.retry',
        objectType: 'message',
        objectId: messageId,
        ip: req.ip,
        metadata: {
          outcome: ledger.started ? 'aborted_after_send' : 'prepare_failed',
          code: safeErrorCode(err),
          conversationId
        }
      });
      return res.status(409).json({ ok: false, code: ledger.started ? 'ABORTED_AFTER_SEND' : 'PREPARE_FAILED' });
    } finally {
      retryLocks.delete(messageId);
    }
  })();
  retryLocks.set(messageId, lock);
  return lock;
});

/**
 * Why claimFailedOutboundForRetry refused, in operator-facing terms.
 *
 * The retry gate is enforced in SQL; this only makes the refusal legible. It
 * never widens what is allowed — claimFailedOutboundForRetry has already run and
 * said no.
 */
async function describeRetryRefusal({ tenantId, conversationId, messageId }) {
  try {
    const { rows } = await pool.query(
      `SELECT delivery_status, delivery_error FROM messages
         WHERE id = $1 AND conversation_id = $2 AND tenant_id = $3`,
      [messageId, conversationId, tenantId]
    );
    const row = rows[0];
    if (!row) return 'NOT_FOUND';
    if (row.delivery_status === 'sent') return 'ALREADY_SENT';
    if (row.delivery_status === 'pending' && row.delivery_error === 'delivery_unknown') {
      return 'DELIVERY_UNKNOWN_DO_NOT_RESEND';
    }
    // Meta CONFIRMED the send; the record was never updated. The customer has
    // this reply, so it must never be re-sent.
    if (row.delivery_status === 'pending' && row.delivery_error === 'delivered_unrecorded') {
      return 'DELIVERED_UNRECORDED_DO_NOT_RESEND';
    }
    // Meta definitively refused; the refusal was never recorded. Nothing was sent.
    if (row.delivery_status === 'pending' && row.delivery_error === 'refused_unrecorded') {
      return 'REFUSED_UNRECORDED';
    }
    if (row.delivery_status === 'pending') return 'STILL_PENDING';
    if (row.delivery_error === 'meta_auth_expired') return 'NEEDS_REAUTH';
    if (row.delivery_error === 'meta_permission') return 'NEEDS_PERMISSION';
    return 'NON_RETRYABLE_CATEGORY';
  } catch {
    return 'UNKNOWN';
  }
}

function _renderDashboard(res, auth) {
  const isAdmin = auth.roles.includes('Company Admin');
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LWC — AI Agent Dashboard</title>
<style>${BASE_CSS}</style></head><body>
<header>
  <div class="brand">🍫 Life with Cacao <span class="muted">· AI Agent Dashboard</span></div>
  <div class="hdr-right">
    <span class="who">${auth.user.name} · ${auth.roles.join(', ')}</span>
    <span id="live" class="dot"></span>
    <a class="muted" href="/dashboard/logout">خروج</a>
  </div>
</header>

<main>
  <section class="cards" id="cards"></section>

  <nav class="tabs">
    <button class="tab active" data-tab="inbox">📥 Inbox</button>
    <button class="tab" data-tab="events">📜 سجل النشاط</button>
    <button class="tab" data-tab="esc">🚨 التصعيدات <span id="escBadge" class="badge hidden"></span></button>
    ${isAdmin ? '<button class="tab" data-tab="team">👥 الفريق</button>' : ''}
  </nav>

  <section id="inbox" class="panel">
    <div id="convList"></div>
    <div id="convDetail" class="hidden"></div>
  </section>
  <section id="events" class="panel hidden"></section>
  <section id="esc" class="panel hidden"></section>
  ${isAdmin ? `
  <section id="team" class="panel hidden">
    <div class="card" style="text-align:right;margin-bottom:14px">
      <h3 style="margin-bottom:10px">➕ إضافة موظف</h3>
      <form id="addUserForm" class="addform">
        <input name="email" type="email" placeholder="البريد الإلكتروني" required>
        <input name="name" placeholder="الاسم" required>
        <input name="password" type="password" placeholder="كلمة سر (8+ أحرف)" minlength="8" required>
        <label><input type="checkbox" name="role" value="Company Admin"> Admin</label>
        <label><input type="checkbox" name="role" value="Supervisor" checked> Supervisor</label>
        <label><input type="checkbox" name="role" value="Agent"> Agent</label>
        <button type="submit">إضافة</button>
      </form>
      <div id="addUserMsg" class="muted"></div>
    </div>
    <div id="usersList"></div>
  </section>` : ''}
</main>

<script>
const IS_ADMIN = ${isAdmin};
const $ = (s) => document.querySelector(s);
const fmtTime = (ts) => new Date(ts).toLocaleString('en-GB', { hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const chan = (c) => c === 'messenger' ? '💬 DM' : '💭 تعليق';

async function load() {
  const [stats, events, escs] = await Promise.all([
    fetch('/dashboard/api/stats').then(r => r.json()),
    fetch('/dashboard/api/events?limit=50').then(r => r.json()),
    fetch('/dashboard/api/escalations').then(r => r.json())
  ]);

  $('#cards').innerHTML = \`
    <div class="card"><div class="num">\${stats.today.total}</div><div class="lbl">تفاعلات اليوم</div></div>
    <div class="card"><div class="num">\${stats.today.comments}</div><div class="lbl">تعليقات</div></div>
    <div class="card"><div class="num">\${stats.today.dms}</div><div class="lbl">رسايل DM</div></div>
    <div class="card \${stats.newEscalations ? 'alert' : ''}"><div class="num">\${stats.newEscalations}</div><div class="lbl">تصعيدات جديدة</div></div>
    <div class="card"><div class="num">\${stats.byIntent.slice(0,2).map(([i,n]) => n + '× ' + i).join('<br>') || '—'}</div><div class="lbl">أكثر النوايا</div></div>\`;

  const newCount = escs.filter(x => x.status === 'new').length;
  const badge = $('#escBadge');
  badge.textContent = newCount;
  badge.classList.toggle('hidden', !newCount);

  $('#events').innerHTML = events.map(e => \`
    <div class="row \${e.escalate ? 'esc' : ''}">
      <div class="meta"><b>\${chan(e.channel)}</b> · \${esc(e.customerName)} · \${fmtTime(e.ts)}
        <span class="tag">\${esc(e.intent)}</span> <span class="tag">\${e.lang}</span>
        \${e.escalate ? '<span class="tag red">🚨 تصعيد</span>' : ''}</div>
      <div class="msg">👤 \${esc(e.message) || '<i>(بدون نص)</i>'}</div>
      <div class="reply">🤖 \${esc(e.reply)}</div>
    </div>\`).join('') || '<p class="muted pad">لا يوجد نشاط بعد.</p>';

  $('#esc').innerHTML = escs.map(x => \`
    <div class="row \${x.status === 'done' ? 'done' : 'esc'}">
      <div class="meta"><b>\${chan(x.channel)}</b> · \${esc(x.customerName)} · \${fmtTime(x.ts)}
        <span class="tag red">\${esc(x.reason)}</span> \${x.status === 'done' ? '<span class="tag green">✅ تم</span>' : ''}</div>
      <div class="msg">👤 \${esc(x.message) || '<i>(بدون نص)</i>'}</div>
      <div class="reply">🤖 \${esc(x.reply)}</div>
      \${x.status === 'new' ? \`<button class="resolve" onclick="resolveEsc('\${x.id}', this)">تم التواصل ✅</button>\` : ''}
    </div>\`).join('') || '<p class="muted pad">لا تصعيدات — كل شيء تمام 🎉</p>';
}

async function resolveEsc(id, btn) {
  btn.disabled = true;
  await fetch('/dashboard/api/escalations/' + id + '/resolve', { method: 'POST' });
  load();
}

/* ------------------------------ team tab ------------------------------ */
async function loadUsers() {
  if (!IS_ADMIN) return;
  const users = await fetch('/dashboard/api/users').then(r => r.json());
  $('#usersList').innerHTML = users.map(u => \`
    <div class="row \${u.status === 'disabled' ? 'done' : ''}">
      <div class="meta">
        <b>\${esc(u.name)}</b> · \${esc(u.email)} ·
        \${u.roles.map(r => \`<span class="tag">\${esc(r)}</span>\`).join('')}
        \${u.status === 'disabled' ? '<span class="tag red">معطّل</span>' : '<span class="tag green">نشط</span>'}
      </div>
      <button class="resolve" style="background:\${u.status === 'disabled' ? '#2e9e5b' : '#b02a20'}"
        onclick="toggleUser('\${u.id}', '\${u.status === 'disabled' ? 'active' : 'disabled'}', this)">
        \${u.status === 'disabled' ? 'تفعيل' : 'تعطيل'}
      </button>
    </div>\`).join('') || '<p class="muted pad">لا يوجد موظفين.</p>';
}

async function toggleUser(id, status, btn) {
  btn.disabled = true;
  await fetch('/dashboard/api/users/' + id + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
  });
  loadUsers();
}

if (IS_ADMIN) {
  $('#addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const roles = [...f.querySelectorAll('input[name="role"]:checked')].map(c => c.value);
    const r = await fetch('/dashboard/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.email.value, name: f.name.value, password: f.password.value, roles })
    });
    const d = await r.json();
    $('#addUserMsg').textContent = r.ok ? '✅ اتضاف بنجاح' : ('❌ ' + (d.error || 'فشل'));
    if (r.ok) { f.reset(); loadUsers(); }
  });
  loadUsers();
}

/* --------------------------- Stage 3: Inbox --------------------------- */
async function loadConversations() {
  var list = await fetch('/dashboard/api/conversations').then(function(r){return r.json();});
  var el = $('#convList');
  if (!list.length) { el.innerHTML = '<p class="muted pad">لا توجد محادثات بعد.</p>'; return; }
  el.innerHTML = list.map(function(c){
    var chan = c.provider === 'meta_dm' ? '💬 DM' : '💭 تعليق';
    var time = c.last_message_at ? new Date(c.last_message_at).toLocaleString('en-GB',{hour12:false}) : '';
    var last = (c.last_text || '').slice(0, 90);
    return '<div class="row conv" data-id="' + c.id + '">'
      + '<div class="meta"><b>' + esc(c.customer_name || 'عميل') + '</b> · ' + chan + ' · ' + time
      + ' <span class="tag">' + esc(c.state) + '</span> <span class="tag">' + esc(c.language || '') + '</span> <span class="tag">' + c.message_count + ' رسالة</span></div>'
      + '<div class="msg">' + esc(last) + '</div>'
      + '</div>';
  }).join('');
  // Event delegation — avoids quote-escaping issues inside template literals
  el.querySelectorAll('.row.conv').forEach(function(row){
    row.addEventListener('click', function(){ openConv(row.dataset.id); });
  });
}
async function openConv(id) {
  conversationIdForRetry = id;
  var d = await fetch('/dashboard/api/conversations/' + id).then(function(r){return r.json();});
  if (!d || !d.conversation) return;
  $('#convList').classList.add('hidden');
  var det = $('#convDetail');
  det.classList.remove('hidden');
  var msgs = d.messages.map(function(m){
    var who = m.direction === 'inbound' ? '👤' : '🤖';
    var cls = m.direction === 'inbound' ? 'bubble cust' : 'bubble ai';
    var st = '';
    if (m.direction === 'outbound') {
      if (m.delivery_status === 'failed') {
        var label = m.delivery_error === 'meta_auth_expired' ? 'فشل الإرسال — انتهت صلاحية الاعتماد'
          : m.delivery_error === 'meta_permission' ? 'فشل الإرسال — لا توجد صلاحية'
          : m.delivery_error === 'meta_rate_limit' ? 'فشل الإرسال — تجاوز الحد'
          : m.delivery_error === 'network_error' ? 'فشل الإرسال — مشكلة شبكة'
          : 'فشل الإرسال';
        st = ' <span class="tag" style="background:#b3261e;color:#fff">' + label + '</span>';
        // The retry button is offered ONLY for categories the database will
        // actually accept. Everything else needs a human decision first, and
        // showing a button that the server refuses just teaches staff to retry.
        if (m.delivery_error === 'meta_rate_limit') {
          st += ' <button class="retrybtn" data-mid="' + m.id + '">إعادة المحاولة</button>';
        } else {
          st += ' <span class="tag" style="background:#5a5a5a;color:#fff">لا تُعاد تلقائياً — تحتاج مراجعة</span>';
        }
      } else if (m.delivery_status === 'pending' && m.delivery_error === 'delivery_unknown') {
        // The provider outcome was never established. The reply may already have
        // reached the customer, so re-sending can duplicate it. Never offer Retry.
        st = ' <span class="tag" style="background:#8a6d00;color:#fff">نتيجة الإرسال غير مؤكدة — لا تُعاد</span>'
          + ' <span class="tag" style="background:#5a5a5a;color:#fff">يحتاج مراجعة يدوية</span>';
      } else if (m.delivery_status === 'pending') {
        st = ' <span class="tag" style="background:#8a6d00;color:#fff">قيد الإرسال</span>';
      } else {
        st = ' <span class="tag" style="background:#1e6b3a;color:#fff">تم الإرسال ✓</span>';
      }
    }
    return '<div class="' + cls + '">' + who + ' ' + esc(m.text || '') + st + '<div class="mtime">' + new Date(m.created_at).toLocaleString('en-GB',{hour12:false}) + '</div></div>';
  }).join('');
  det.innerHTML = '<button class="backbtn" onclick="closeConv()">→ رجوع للقايمة</button>'
    + '<div class="meta" style="margin:8px 0"><b>' + esc(d.conversation.customer_name || 'عميل') + '</b> · ' + esc(d.conversation.provider) + ' · <span class="tag">' + esc(d.conversation.state) + '</span></div>'
    + msgs;
  det.querySelectorAll('.retrybtn').forEach(function(btn){
    btn.addEventListener('click', function(){ retryMessage(conversationIdForRetry, btn.dataset.mid, btn); });
  });
}

// Stage 4.4.7 — manual delivery retry (conversation-scoped, idempotent server-side)
var conversationIdForRetry = null;
async function retryMessage(convId, mid, btn) {
  if (!convId || !mid || !btn || btn.disabled) return;
  btn.disabled = true;
  var old = btn.textContent;
  btn.textContent = 'قيد إعادة المحاولة...';
  try {
    var r = await fetch('/dashboard/api/conversations/' + convId + '/messages/' + mid + '/retry', { method: 'POST' });
    var d = await r.json().catch(function(){ return {}; });
    if (r.ok && d && d.ok) { openConv(convId); return; }
    btn.textContent = 'فشل — أعد المحاولة';
    btn.disabled = false;
  } catch (e) {
    btn.textContent = 'فشل — أعد المحاولة';
    btn.disabled = false;
  }
}
function closeConv() {
  conversationIdForRetry = null;
  $('#convDetail').classList.add('hidden');
  $('#convList').classList.remove('hidden');
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  $('#' + t.dataset.tab).classList.remove('hidden');
}));

load();
loadConversations();
setInterval(function(){ load(); if ($('#convDetail').classList.contains('hidden')) loadConversations(); }, 15000);
</script>
</body></html>`);
}

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; font-family: 'Segoe UI', Tahoma, sans-serif; }
body { background: #f4f1ec; color: #2b2118; min-height: 100vh; }
body.center { display: grid; place-items: center; }
header { background: #4a2c17; color: #fff; padding: 14px 22px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
header a { color: #d9c3a5; text-decoration: none; font-size: 14px; }
.brand { font-weight: 700; } .muted { color: #a08b74; font-weight: 400; font-size: 13px; }
.hdr-right { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.who { color: #e8d9c5; }
main { max-width: 980px; margin: 22px auto; padding: 0 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.card { background: #fff; border-radius: 14px; padding: 16px; text-align: center; box-shadow: 0 1px 4px #0001; }
.card.alert { background: #fdecea; border: 1px solid #e8b4ac; }
.num { font-size: 24px; font-weight: 800; color: #4a2c17; }
.lbl { font-size: 12px; color: #a08b74; margin-top: 4px; }
.tabs { display: flex; gap: 8px; margin: 18px 0 12px; flex-wrap: wrap; }
.tab { border: none; background: #e8dfd2; padding: 9px 16px; border-radius: 999px; cursor: pointer; font-weight: 600; }
.tab.active { background: #4a2c17; color: #fff; }
.badge { background: #d93025; color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.row { background: #fff; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; box-shadow: 0 1px 3px #0001; border-right: 4px solid #c9b8a3; }
.row.esc { border-right-color: #d93025; }
.row.done { opacity: .55; border-right-color: #2e9e5b; }
.meta { font-size: 12px; color: #8d7a64; margin-bottom: 6px; }
.tag { background: #efe6da; border-radius: 6px; padding: 1px 7px; margin-right: 4px; }
.tag.red { background: #fbd9d4; color: #b02a20; } .tag.green { background: #d7f0e0; color: #1e7a44; }
.msg { font-size: 14px; margin: 4px 0; white-space: pre-wrap; }
.reply { font-size: 14px; color: #5c4632; background: #faf6ef; border-radius: 8px; padding: 8px 10px; margin-top: 6px; white-space: pre-wrap; }
.resolve { margin-top: 8px; border: none; background: #2e9e5b; color: #fff; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.hidden { display: none !important; }
.pad { padding: 20px; text-align: center; }
.dot::before { content: '●'; color: #37d67a; margin-left: 6px; font-size: 12px; }
.login { width: 320px; display: grid; gap: 12px; }
.login .logo { font-size: 44px; } .login h1 { font-size: 20px; color: #4a2c17; }
.login input { padding: 12px; border: 1px solid #d8c9b5; border-radius: 10px; font-size: 15px; }
.login button { padding: 12px; border: none; background: #4a2c17; color: #fff; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; }
.addform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.addform input[type="email"], .addform input[type="text"], .addform input[type="password"], .addform input:not([type]) {
  padding: 9px; border: 1px solid #d8c9b5; border-radius: 8px; font-size: 14px; min-width: 150px;
}
.addform label { font-size: 13px; display: flex; gap: 4px; align-items: center; }
.addform button { padding: 9px 16px; border: none; background: #4a2c17; color: #fff; border-radius: 8px; font-weight: 700; cursor: pointer; }
.bubble { max-width: 82%; padding: 8px 12px; border-radius: 12px; margin: 6px 0; white-space: pre-wrap; font-size: 14px; }
.bubble.cust { background: #e8dfd2; margin-right: auto; }
.bubble.ai { background: #4a2c17; color: #fff; margin-left: auto; }
.mtime { font-size: 10px; opacity: .6; margin-top: 3px; }
.row.conv { cursor: pointer; }
.backbtn { border: none; background: #e8dfd2; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; margin-bottom: 8px; }
`;
