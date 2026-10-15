/**
 * Stage 8 Batch 3 — Facebook Page self-service OAuth API.
 *
 * Endpoints (mounted at /api/v1/integrations/meta):
 *   POST /authorize   start a consent flow (CSRF + brand.integration.connect)
 *   GET  /callback    Meta redirect — EXEMPT from CSRF, authenticated by a signed
 *                     state that is consumed ATOMICALLY and SESSION-BOUND
 *   GET  /pages       page picker — requires the separate flow token
 *   POST /connect     final connection — CSRF + single-use flow token (hash
 *                     validated in the SAME statement that consumes it)
 *
 * HARD RULES
 *   - The brand is chosen BEFORE consent, carried in the signed state and bound
 *     to the flow. The connect step may not substitute a different brand.
 *   - A flow is authorized by (flowId + token hash + tenant + user + expiry +
 *     unused) verified in ONE UPDATE; a valid flowId without the matching token
 *     connects nothing and consumes nothing.
 *   - Credentials are stored by rotating the EXACT row the channel resolver
 *     selects (same ORDER BY), so a reconnect never adds a duplicate row and
 *     never deletes a historical one. There is no unique constraint on
 *     provider_credentials — verified against production — so this code is the
 *     only thing preventing a second row.
 *   - Page tokens have no documented expiry -> expires_at stays NULL.
 *   - No access token, code or flow secret ever reaches a response, log or audit.
 *   - Provider failures are logged as sanitized codes only.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { audit } from '../../auth/audit.js';
import { brandScopeFromSession, brandIsAccessible } from './brandAccess.js';
import {
  OAUTH_ERRORS, MetaOAuthError, REQUIRED_SCOPES, oauthReadiness, redirectUri, createState,
  parseState, loadStateByNonceHash, verifyStateSignature, consumeState, createFlow, validateFlow,
  consumeFlow, setFlowUserTokenExpiry, storeFlowPages, listFlowPages, pageTokenFor,
  purgeExpiredFlows, exchangeCode, exchangeLongLived, discoverPages, subscribePageWebhook
} from '../../services/metaOAuth.js';
import { encrypt } from '../../db/crypto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sanitized logging: never print provider messages, tokens or SQL params. */
const logSafe = (scope, err) =>
  console.error(`oauth ${scope} failed:`, err?.code ?? err?.name ?? 'error');

export function createIntegrationsMetaRouter({ pool }) {
  const router = express.Router();

  /* --------------------------- POST /authorize --------------------------- */
  router.post('/authorize', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const db = req.db ?? pool;
    if (!oauthReadiness().enabled) {
      // Fail closed: no Host-header redirect_uri, no Quick Tunnel fallback.
      return apiError(res, 503, OAUTH_ERRORS.NOT_CONFIGURED, 'self-service connection is not configured');
    }
    const brandId = req.body?.brandId ? String(req.body.brandId) : null;
    const scope = brandScopeFromSession(req.v1);
    try {
      if (brandId && !UUID_RE.test(brandId)) return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
      if (brandId) {
        const allowed = await brandIsAccessible({ db, tenantId: req.v1.tenantId, brandId, scope });
        if (!allowed) return apiError(res, 404, 'BRAND_NOT_FOUND', 'brand not found');
      }
      await purgeExpiredFlows({ db });

      const { state, nonceHash, expiresAt } = createState({
        tenantId: req.v1.tenantId, userId: req.v1.user.id, brandId
      });
      await db.query(
        `INSERT INTO oauth_connect_states (nonce_hash, tenant_id, user_id, brand_id, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [nonceHash, req.v1.tenantId, req.v1.user.id, brandId, expiresAt]
      );

      const url = new URL(`https://www.facebook.com/${process.env.FB_GRAPH_VERSION || 'v21.0'}/dialog/oauth`);
      url.searchParams.set('client_id', process.env.FB_APP_ID ?? '');
      url.searchParams.set('redirect_uri', redirectUri());
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
      return res.json({ data: { authorizeUrl: url.toString(), expiresAt } });
    } catch (err) {
      logSafe('authorize', err);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ---------------------------- GET /callback ---------------------------- */
  router.get('/callback', requireV1Auth, async (req, res) => {
    const db = req.db ?? pool;
    const ru = redirectUri();
    if (!ru) return apiError(res, 503, OAUTH_ERRORS.NOT_CONFIGURED, 'self-service connection is not configured');

    const parsed = parseState(String(req.query.state ?? ''));
    if (!parsed) {
      audit({
        tenantId: req.v1?.tenantId ?? null, actorUserId: req.v1?.user?.id ?? null,
        action: 'integration.oauth_denied', objectType: 'oauth_state', ip: req.ip,
        metadata: { reason: 'state_parse_failed' }
      });
      return apiError(res, 400, OAUTH_ERRORS.STATE_INVALID, 'invalid or expired authorization state');
    }

    const row = await loadStateByNonceHash(parsed.nonceHash, { db });
    if (!row || !verifyStateSignature(parsed, row)) {
      audit({
        tenantId: req.v1?.tenantId ?? null, actorUserId: req.v1?.user?.id ?? null,
        action: 'integration.oauth_denied', objectType: 'oauth_state', ip: req.ip,
        metadata: { reason: 'state_signature_failed' }
      });
      return apiError(res, 400, OAUTH_ERRORS.STATE_INVALID, 'invalid or expired authorization state');
    }
    if (row.tenant_id !== req.v1.tenantId || row.user_id !== req.v1.user.id) {
      // Does NOT consume another tenant's/user's state.
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
        action: 'integration.oauth_denied', objectType: 'oauth_state', ip: req.ip,
        metadata: { reason: 'session_mismatch' }
      });
      return apiError(res, 403, OAUTH_ERRORS.SESSION_MISMATCH, 'authorization state belongs to another session');
    }

    // Atomic + session-bound consumption (one statement, replay-safe).
    const consumed = await consumeState({ stateId: row.id, tenantId: req.v1.tenantId, userId: req.v1.user.id }, { db });
    if (!consumed) return apiError(res, 400, OAUTH_ERRORS.STATE_INVALID, 'invalid or expired authorization state');

    if (String(req.query.error ?? '') === 'access_denied') {
      audit({
        tenantId: consumed.tenant_id, actorUserId: consumed.user_id,
        action: 'integration.oauth_denied', objectType: 'oauth_state', ip: req.ip,
        metadata: { reason: 'consent_denied' }
      });
      return apiError(res, 400, OAUTH_ERRORS.CONSENT_DENIED, 'authorization was declined');
    }
    const code = String(req.query.code ?? '');
    if (!code) return apiError(res, 400, OAUTH_ERRORS.CODE_INVALID, 'missing authorization code');

    try {
      const { userToken } = await exchangeCode({ code, redirectUri: ru });
      const longLived = await exchangeLongLived({ userToken });
      // The brand chosen before consent travels with the flow (signed, server-held).
      const flow = await createFlow({ stateRow: consumed }, { db });
      await setFlowUserTokenExpiry({ flowId: flow.flowId, expiresAt: longLived.expiresAt }, { db });
      const pages = await discoverPages({ userToken: longLived.userToken });
      await storeFlowPages({ flowId: flow.flowId, pages }, { db });

      audit({
        tenantId: consumed.tenant_id, actorUserId: consumed.user_id,
        action: 'integration.oauth_consent', objectType: 'oauth_flow', objectId: flow.flowId,
        ip: req.ip, metadata: { pageCount: pages.length, brandId: consumed.brand_id ?? null }
      });

      // The flow token goes to the browser once, in the FRAGMENT (never a query param).
      const webBase = ru.replace(/\/api\/v1\/integrations\/meta\/callback$/, '');
      const target = new URL(`${webBase}/integrations`);
      target.hash = new URLSearchParams({ flow: flow.flowId, t: flow.flowToken }).toString();
      return res.redirect(303, target.toString());
    } catch (err) {
      const safeCode = err instanceof MetaOAuthError ? err.code : OAUTH_ERRORS.EXCHANGE_FAILED;
      audit({
        tenantId: consumed.tenant_id, actorUserId: consumed.user_id,
        action: 'integration.oauth_denied', objectType: 'oauth_state', ip: req.ip,
        metadata: { reason: safeCode }
      });
      return apiError(res, 502, safeCode, 'facebook authorization could not be completed');
    }
  });

  /* ----------------------------- GET /pages ------------------------------ */
  router.get('/pages', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const db = req.db ?? pool;
    try {
      const flowId = String(req.query.flow ?? '');
      const flowToken = String(req.get('x-flow-token') ?? '');
      const flow = await validateFlow({ flowId, flowToken, tenantId: req.v1.tenantId, userId: req.v1.user.id }, { db });
      if (!flow) return apiError(res, 403, OAUTH_ERRORS.FLOW_INVALID, 'connection flow is invalid or expired');
      const pages = await listFlowPages({ flowId: flow.id }, { db });
      // Page metadata only — page tokens are never returned.
      return res.json({ data: { flowId: flow.id, brandId: flow.brand_id ?? null, pages } });
    } catch (err) {
      logSafe('pages', err);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ---------------------------- POST /connect ---------------------------- */
  router.post('/connect', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const db = req.db ?? pool;
    const flowId = String(req.body?.flowId ?? '');
    const flowToken = String(req.get('x-flow-token') ?? '');
    const pageId = String(req.body?.pageId ?? '');
    const requestedBrand = req.body?.brandId ? String(req.body.brandId) : null;

    try {
      // ONE statement: token hash + tenant + user + expiry + unused + consume.
      const flow = await consumeFlow({
        flowId, flowToken, tenantId: req.v1.tenantId, userId: req.v1.user.id
      }, { db });
      if (!flow) return apiError(res, 403, OAUTH_ERRORS.FLOW_INVALID, 'connection flow is invalid, expired or already used');

      // Brand binding: the authorized brand is authoritative; no substitution.
      const boundBrandId = flow.brand_id ?? null;
      if (requestedBrand && requestedBrand !== boundBrandId) {
        audit({
          tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
          action: 'integration.oauth_denied', objectType: 'oauth_flow', objectId: flow.id,
          ip: req.ip, metadata: { reason: 'brand_substitution_attempt' }
        });
        return apiError(res, 403, 'BRAND_MISMATCH', 'the brand bound to this authorization cannot be changed');
      }
      // Revalidate brand ownership + the caller's current access at connect time.
      if (boundBrandId) {
        const scope = brandScopeFromSession(req.v1);
        const stillAllowed = await brandIsAccessible({ db, tenantId: req.v1.tenantId, brandId: boundBrandId, scope });
        if (!stillAllowed) return apiError(res, 404, 'BRAND_NOT_FOUND', 'brand not found');
      }
      const brandId = boundBrandId;

      // Ownership proof: the page must be in the server-held set for this flow.
      const pageToken = await pageTokenFor({ flowId, pageId }, { db });
      if (!pageToken) return apiError(res, 403, OAUTH_ERRORS.NOT_AUTHORIZED, 'this facebook page is not available for this connection');

      const client = await db.connect();
      let channelId = null;
      let reconnected = false;
      try {
        await client.query('BEGIN');

        const existing = await client.query(
          `SELECT id, tenant_id, brand_id FROM channels WHERE provider = 'meta' AND external_id = $1`,
          [pageId]
        );
        const found = existing.rows[0];

        if (found && found.tenant_id !== req.v1.tenantId) {
          await client.query('ROLLBACK');
          audit({
            tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
            action: 'integration.conflict', objectType: 'channel', ip: req.ip,
            metadata: { reason: 'page_claimed_by_other_tenant' }
          });
          return apiError(res, 409, OAUTH_ERRORS.PAGE_ALREADY_CONNECTED, 'this page is already connected to another workspace');
        }
        if (found && (found.brand_id ?? null) !== brandId) {
          await client.query('ROLLBACK');
          return apiError(res, 409, OAUTH_ERRORS.BRAND_CONFLICT, 'this page is already connected to a different brand');
        }

        if (found) {
          channelId = found.id;
          reconnected = true;
          await client.query(
            `UPDATE channels SET status = 'active', subscription_state = 'pending_subscription',
                                subscription_error = NULL, brand_id = $2
              WHERE id = $1`,
            [channelId, brandId]
          );
        } else {
          const ins = await client.query(
            `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status, subscription_state)
             VALUES ($1,$2,'meta',$3,$4,'active','pending_subscription') RETURNING id`,
            [req.v1.tenantId, brandId, pageId, `Facebook Page ${pageId}`]
          );
          channelId = ins.rows[0].id;
        }

        // Credential: rotate the EXACT row the resolver will select.
        //
        //   * Historical rows are NEVER deleted. A reconnect rewrites one row in
        //     place, so the row count for a channel can only stay the same or
        //     grow by one (the very first connect), never shrink.
        //   * provider_credentials has NO unique constraint on
        //     (channel_id, kind) — verified against production — so there is no
        //     conflict target and nothing but this code prevents a second row.
        //     That is why we update rather than insert when a row exists.
        //   * The ORDER BY below is identical to channelResolver.js and to the
        //     resubscribe/reverify lookups, so the token written is provably the
        //     token that will be used for inbound routing.
        //   * The advisory lock serializes concurrent connects for the same page
        //     inside this transaction, so two requests can never both observe
        //     "no credential row" and each insert one.
        //   * Page tokens have no documented expiry -> expires_at stays NULL.
        const enc = encrypt(pageToken);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`meta:page:${pageId}`]);
        const updated = await client.query(
          `UPDATE provider_credentials
              SET value_encrypted = $3, iv = $4, expires_at = NULL, last_rotated_at = now()
            WHERE id = (
              SELECT id FROM provider_credentials
               WHERE channel_id = $1 AND tenant_id = $2 AND kind = 'page_access_token'
               ORDER BY created_at DESC, id DESC LIMIT 1
            )
            RETURNING id`,
          [channelId, req.v1.tenantId, enc.value, enc.iv]
        );
        if (updated.rowCount === 0) {
          await client.query(
            `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, expires_at)
             VALUES ($1,$2,'page_access_token',$3,$4,NULL)`,
            [req.v1.tenantId, channelId, enc.value, enc.iv]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err?.code === '23505') {
          audit({
            tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
            action: 'integration.conflict', objectType: 'channel', ip: req.ip,
            metadata: { reason: 'unique_violation' }
          });
          return apiError(res, 409, OAUTH_ERRORS.PAGE_ALREADY_CONNECTED, 'this page is already connected to another workspace');
        }
        logSafe('connect', err);
        throw err;
      } finally {
        client.release();
      }

      // Subscription happens AFTER the durable write and stays bounded/short.
      const sub = await subscribePageWebhook({ pageId, pageToken });
      await db.query(
        `UPDATE channels SET subscription_state = $2, subscription_error = $3, verified_at = now() WHERE id = $1`,
        [channelId, sub.ok ? 'subscribed' : 'subscription_failed', sub.ok ? null : sub.errorCode]
      );

      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
        action: reconnected ? 'integration.reconnect' : 'integration.connect',
        objectType: 'channel', objectId: channelId, ip: req.ip,
        metadata: { brandId: brandId ?? null, subscription: sub.ok ? 'subscribed' : 'subscription_failed' }
      });
      if (!sub.ok) {
        audit({
          tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
          action: 'integration.subscription_failed', objectType: 'channel', objectId: channelId,
          ip: req.ip, metadata: { code: sub.errorCode }
        });
      }

      return res.json({
        data: {
          connected: sub.ok,
          reconnected,
          channelId,
          subscriptionState: sub.ok ? 'subscribed' : 'subscription_failed',
          errorCode: sub.ok ? null : sub.errorCode
        }
      });
    } catch (err) {
      logSafe('connect', err);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  return router;
}