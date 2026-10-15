/**
 * Stage 8 Batch 3 — Facebook Page self-service OAuth API.
 *
 * Endpoints (mounted at /api/v1/integrations/meta):
 *   POST /authorize   start a consent flow (CSRF + brand.integration.connect)
 *   GET  /callback    Meta redirect target — EXEMPT from CSRF, authenticated by
 *                     signed state + atomic, session-bound consumption
 *   GET  /pages       page picker — requires the separate flow token
 *   POST /connect     final connection — CSRF + flow token (single use)
 *
 * Every response is provider-neutral metadata. No access token, code or state
 * secret is ever returned to a client, logged or audited.
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

export function createIntegrationsMetaRouter({ pool }) {
  const router = express.Router();

  // The callback is a top-level browser redirect from Meta: it cannot carry the
  // CSRF header, so it is authenticated by signed state + session binding.
  const authOnly = requireV1Auth;

  /* --------------------------- POST /authorize --------------------------- */
  router.post('/authorize', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const readiness = oauthReadiness();
    if (!readiness.enabled) {
      // Fail closed: no tunnel fallback, no Host-header derived redirect_uri.
      return apiError(res, 503, OAUTH_ERRORS.NOT_CONFIGURED, 'self-service connection is not configured');
    }
    const brandId = req.body?.brandId ? String(req.body.brandId) : null;
    const scope = brandScopeFromSession(req.v1);
    try {
      if (brandId && !UUID_RE.test(brandId)) return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
      if (brandId) {
        const allowed = await brandIsAccessible({ db: req.db, tenantId: req.v1.tenantId, brandId, scope });
        if (!allowed) return apiError(res, 404, 'BRAND_NOT_FOUND', 'brand not found');
      }
      await purgeExpiredFlows();

      const { state, nonceHash, expiresAt } = createState({
        tenantId: req.v1.tenantId,
        userId: req.v1.user.id,
        brandId
      });
      await pool.query(
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
      console.error('oauth authorize failed:', err?.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ---------------------------- GET /callback ---------------------------- */
  router.get('/callback', authOnly, async (req, res) => {
    const ru = redirectUri();
    if (!ru) return apiError(res, 503, OAUTH_ERRORS.NOT_CONFIGURED, 'self-service connection is not configured');

    const parsed = parseState(String(req.query.state ?? ''));
    if (!parsed) {
      audit({
        tenantId: req.v1?.tenantId ?? null, actorUserId: req.v1?.user?.id ?? null,
        action: 'integration.oauth_denied', objectType: 'oauth_state',
        ip: req.ip, metadata: { reason: 'state_parse_failed' }
      });
      return apiError(res, 400, OAUTH_ERRORS.STATE_INVALID, 'invalid or expired authorization state');
    }

    // The stored identity is authoritative; the session must match it exactly.
    const row = await loadStateByNonceHash(parsed.nonceHash);
    if (!row || !verifyStateSignature(parsed, row)) {
      audit({
        tenantId: req.v1?.tenantId ?? null, actorUserId: req.v1?.user?.id ?? null,
        action: 'integration.oauth_denied', objectType: 'oauth_state',
        ip: req.ip, metadata: { reason: 'state_signature_failed' }
      });
      return apiError(res, 400, OAUTH_ERRORS.STATE_INVALID, 'invalid or expired authorization state');
    }
    if (row.tenant_id !== req.v1.tenantId || row.user_id !== req.v1.user.id) {
      // Do NOT consume another tenant's/user's state.
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
        action: 'integration.oauth_denied', objectType: 'oauth_state',
        ip: req.ip, metadata: { reason: 'session_mismatch' }
      });
      return apiError(res, 403, OAUTH_ERRORS.SESSION_MISMATCH, 'authorization state belongs to another session');
    }

    // Atomic, session-bound consumption (one statement, replay-safe).
    const consumed = await consumeState({ stateId: row.id, tenantId: req.v1.tenantId, userId: req.v1.user.id });
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
      const flow = await createFlow({ stateRow: consumed });
      await setFlowUserTokenExpiry({ flowId: flow.flowId, expiresAt: longLived.expiresAt });
      const pages = await discoverPages({ userToken: longLived.userToken });
      await storeFlowPages({ flowId: flow.flowId, pages });

      audit({
        tenantId: consumed.tenant_id, actorUserId: consumed.user_id,
        action: 'integration.oauth_consent', objectType: 'oauth_flow', objectId: flow.flowId,
        ip: req.ip, metadata: { pageCount: pages.length, brandId: consumed.brand_id ?? null }
      });

      // The flow token is handed to the browser once, in the URL FRAGMENT so it
      // never reaches server logs or referrers.
      const webBase = (redirectUri() ?? '').replace(/\/api\/v1\/integrations\/meta\/callback$/, '');
      const target = new URL(`${webBase}/integrations`);
      target.hash = new URLSearchParams({ flow: flow.flowId, t: flow.flowToken }).toString();
      return res.redirect(303, target.toString());
    } catch (err) {
      const codeOut = err instanceof MetaOAuthError ? err.code : OAUTH_ERRORS.EXCHANGE_FAILED;
      audit({
        tenantId: consumed.tenant_id, actorUserId: consumed.user_id,
        action: 'integration.oauth_denied', objectType: 'oauth_state',
        ip: req.ip, metadata: { reason: codeOut }
      });
      return apiError(res, 502, codeOut, 'facebook authorization could not be completed');
    }
  });

  /* ----------------------------- GET /pages ------------------------------ */
  router.get('/pages', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    try {
      const flowId = String(req.query.flow ?? req.query.flowId ?? '');
      const flowToken = String(req.get('x-flow-token') ?? '');
      const flow = await validateFlow({ flowId, flowToken, tenantId: req.v1.tenantId, userId: req.v1.user.id });
      if (!flow) return apiError(res, 403, OAUTH_ERRORS.FLOW_INVALID, 'connection flow is invalid or expired');
      const pages = await listFlowPages({ flowId: flow.id });
      return res.json({ data: { flowId: flow.id, brandId: flow.brand_id ?? null, pages } });
    } catch (err) {
      console.error('oauth pages failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ---------------------------- POST /connect ---------------------------- */
  router.post('/connect', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const flowId = String(req.body?.flowId ?? req.query?.flow ?? '');
    const flowToken = String(req.get('x-flow-token') ?? '');
    const pageId = String(req.body?.pageId ?? '');
    const requestedBrand = req.body?.brandId ? String(req.body.brandId) : null;

    try {
      // Single-use: the final connection consumes the flow authorization.
      const flow = await consumeFlow({ flowId, tenantId: req.v1.tenantId, userId: req.v1.user.id });
      if (!flow) return apiError(res, 403, OAUTH_ERRORS.FLOW_INVALID, 'connection flow is invalid, expired or already used');

      const scope = brandScopeFromSession(req.v1);
      const brandId = requestedBrand ?? flow.brand_id ?? null;
      if (brandId) {
        const allowed = await brandIsAccessible({ db: req.db, tenantId: req.v1.tenantId, brandId, scope });
        if (!allowed) return apiError(res, 404, 'BRAND_NOT_FOUND', 'brand not found');
      }

      // Ownership proof: the page must be in the server-held set for this flow.
      const pageToken = await pageTokenFor({ flowId, pageId });
      if (!pageToken) return apiError(res, 403, OAUTH_ERRORS.NOT_AUTHORIZED, 'this facebook page is not available for this connection');

      const client = await req.db.connect();
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
          // Cross-tenant claim: fixed message, no owner disclosure.
          await client.query('ROLLBACK');
          audit({
            tenantId: req.v1.tenantId, actorUserId: req.v1.user.id,
            action: 'integration.conflict', objectType: 'channel',
            ip: req.ip, metadata: { reason: 'page_claimed_by_other_tenant' }
          });
          return apiError(res, 409, OAUTH_ERRORS.PAGE_ALREADY_CONNECTED, 'this page is already connected to another workspace');
        }
        if (found && (brandId ?? null) !== found.brand_id) {
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

        // Page tokens have no documented expiry -> expires_at stays NULL.
        const enc = encrypt(pageToken);
        await client.query(
          `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, expires_at)
           VALUES ($1,$2,'page_access_token',$3,$4,NULL)`,
          [req.v1.tenantId, channelId, enc.value, enc.iv]
        );
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
        throw err;
      } finally {
        client.release();
      }

      // Subscription happens AFTER the durable write and stays bounded/short.
      const sub = await subscribePageWebhook({ pageId, pageToken });
      await pool.query(
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
      console.error('oauth connect failed:', err?.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  return router;
}