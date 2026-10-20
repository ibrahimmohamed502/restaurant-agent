/**
 * B1 - Facebook Page connection routes.
 *
 * Seven endpoints, all behind an authenticated v1 session and an explicit
 * ability. The abilities already exist from A1 (brand.integration.connect /
 * .disconnect / .reconnect / .status), so B1 added no new permission surface.
 *
 * THE CALLBACK IS THE ONE ROUTE THAT CANNOT REQUIRE AN ABILITY.
 * When Facebook redirects back, the browser may carry no usable session. The
 * callback is therefore authenticated BY the OAuth state: a single-use, expiring,
 * user-bound token minted only after an authenticated user with the right
 * ability asked to connect. That is the right trade, because the state also pins
 * the tenant, the user, the brand and the exact redirect URI.
 *
 * THE USER TOKEN NEVER REACHES THE BROWSER.
 * After the code exchange the grant is parked, encrypted, against the state row.
 * The browser receives a state id and a token-free page list. It picks a pageId
 * and POSTs it; the server re-derives the authoritative page list itself. A token
 * in a redirect would end up in browser history, the Referer header, and every
 * proxy log between here and Meta.
 *
 * No response body ever carries a page access token, a user access token, or the
 * app secret.
 */
import express from 'express';
import { requireV1Auth, apiError } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { brandScopeFromSession, brandIsAccessible } from './brandAccess.js';
import { audit } from '../../auth/audit.js';
import {
  issueOAuthState,
  consumeOAuthState,
  stashUserToken,
  takeUserToken,
  readConsumedState,
  readUnspentState,
  claimGrantForConfirm,
  generatePkce,
  takePkceVerifier,
  OAuthStateError,
  OAUTH_STATE_ERRORS
} from '../../services/oauthState.js';
import {
  listAvailablePages,
  connectPage,
  listConnections,
  disconnectPage,
  disconnectOAuthConnection,
  ConnectionError,
  CONNECTION_ERRORS
} from '../../services/facebookConnections.js';
import {
  buildAuthorizationUrl,
  buildPostLoginRedirect,
  exchangeCode,
  isAllowedRedirectUri,
  mapCallbackError,
  B1_SCOPES,
  MetaOAuthError,
  META_OAUTH_ERRORS
} from '../../providers/meta/oauth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PKCE is opt-in per environment.
 *
 * Meta's PKCE support depends on which login configuration the app uses, and we
 * have not verified it against the real dashboard. Rather than assume it works
 * (a wrong assumption breaks every connect) or silently omit it (leaving a
 * defence-in-depth measure off), it is configurable and ON by default.
 */
function pkceEnabled() {
  return String(process.env.META_OAUTH_PKCE ?? 'true').toLowerCase() !== 'false';
}

/** The one place the app declares its own callback. Never read from a request. */
function configuredRedirectUri() {
  return process.env.META_OAUTH_REDIRECT_URI || '';
}

/**
 * Where the browser lands after the callback: the app, inside the origin of the
 * allowlisted callback URL. Path-only by construction, so this cannot become an
 * open redirect no matter what a request supplies.
 */
function postLoginUrl(params) {
  const origin = new URL(configuredRedirectUri()).origin;
  return buildPostLoginRedirect({
    origin,
    path: process.env.META_OAUTH_APP_PATH || '/integrations/facebook',
    params
  });
}

function statusForServiceError(code) {
  switch (code) {
    case CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE:
    case CONNECTION_ERRORS.BRAND_REQUIRED:
      return 403;
    case CONNECTION_ERRORS.CHANNEL_NOT_FOUND:
      return 404;
    case CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT:
    case CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED:
    case CONNECTION_ERRORS.CROSS_BRAND_TRANSFER_FORBIDDEN:
      return 409;
    case CONNECTION_ERRORS.PAGE_NOT_IN_ACCOUNT:
    case CONNECTION_ERRORS.PAGE_NOT_CONNECTABLE:
    case CONNECTION_ERRORS.CREDENTIAL_MISSING:
      return 422;
    default:
      return 502;
  }
}

function statusForStateError(code) {
  switch (code) {
    case OAUTH_STATE_ERRORS.NOT_FOUND:
      return 400;
    case OAUTH_STATE_ERRORS.ALREADY_USED:
    case OAUTH_STATE_ERRORS.EXPIRED:
      return 409;
    case OAUTH_STATE_ERRORS.MISMATCH:
      return 403;
    case OAUTH_STATE_ERRORS.CRYPTO_UNAVAILABLE:
      // Server-side misconfiguration (missing/rotated ENCRYPTION_KEY), not a
      // client error. 500 so it is not mistaken for "you did something wrong"
      // and retried by the user.
      return 500;
    default:
      return 400;
  }
}

function sendServiceError(res, e) {
  if (e instanceof ConnectionError) {
    return apiError(res, statusForServiceError(e.code), e.code, e.message);
  }
  if (e instanceof OAuthStateError) {
    return apiError(res, statusForStateError(e.code), e.code, e.message);
  }
  return null;
}

export function createMetaOAuthRouter({ pool }) {
  const router = express.Router();

  /**
   * POST /integrations/facebook/connect
   *
   * Step 1. Mints an OAuth state bound to this session, tenant, user and the
   * brand just chosen, then returns the URL to send the browser to. Nothing is
   * persisted except the state row.
   */
  router.post('/connect', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const tenantId = req.v1?.tenantId;
    const actorUserId = req.v1?.user?.id;
    const brandId = req.body?.brandId ? String(req.body.brandId) : null;

    if (!UUID.test(String(brandId))) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
    }

    const scope = brandScopeFromSession(req.v1);
    const allowed = await brandIsAccessible({ db: req.db, tenantId, brandId, scope });
    if (!allowed) {
      return apiError(res, 403, CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE, 'brand is not available to this user');
    }

    const redirectUri = configuredRedirectUri();
    if (!isAllowedRedirectUri(redirectUri)) {
      return apiError(res, 500, META_OAUTH_ERRORS.INVALID_REDIRECT_URI, 'oauth redirect uri is not configured');
    }

    let state;
    let codeChallenge = null;
    try {
      const pkce = pkceEnabled() ? generatePkce() : null;
      if (pkce) codeChallenge = pkce.challenge;

      state = await issueOAuthState({
        tenantId,
        actorUserId,
        sessionId: req.v1?.sessionId ?? null,
        provider: 'meta',
        brandId,
        redirectUri,
        pkceVerifier: pkce?.verifier ?? null,
        db: req.db
      });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }

    const authorizeUrl = buildAuthorizationUrl({
      redirectUri,
      state: state.state,
      scopes: B1_SCOPES,
      codeChallenge
    });

    audit({
      tenantId,
      actorUserId,
      action: 'integrations.facebook.connect.started',
      objectType: 'brand',
      objectId: brandId,
      ip: req.ip,
      metadata: { scopes: B1_SCOPES }
    });

    return res.json({ data: { authorizeUrl, state: state.state, expiresAt: state.expiresAt } });
  });

  /**
   * GET /integrations/facebook/callback
   *
   * Step 2. Facebook redirects here. Note the ABSENCE of requireV1Auth: the
   * state token is the credential.
   *
   * Meta can deliver either the code or an error. Both are handled, and an error
   * is reported without leaking Meta's description text (it can echo request
   * parameters).
   */
  router.get('/callback', async (req, res) => {
    const redirectUri = configuredRedirectUri();
    const { code, state, error, error_reason } = req.query || {};

    // No state at all is refused before anything else is trusted.
    if (!state) {
      return apiError(res, 400, OAUTH_STATE_ERRORS.NOT_FOUND, 'state parameter is required');
    }

    if (!code) {
      const mapped = mapCallbackError(error);
      audit({
        action: 'integrations.facebook.connect.denied',
        objectType: 'oauth',
        objectId: null,
        ip: req.ip,
        // error_reason is Meta's classification and is safe to record. The
        // description is deliberately not read at all.
        metadata: { upstream: error ?? null, reason: error_reason ?? null }
      });
      // Back into the app so the user sees a real message instead of JSON. The
      // code is ours, never Meta's text.
      return res.redirect(303, postLoginUrl({ error: mapped.code }));
    }

    // --- Authorization-code path. `code` is never logged. -------------------

    let claimed;
    try {
      // tenantId/actorUserId are unknown until the row is read, so they are not
      // supplied here. They are NOT taken on trust either: the row pins them,
      // and /confirm re-verifies them against the caller's live session before
      // anything is written.
      claimed = await consumeOAuthState({ state, redirectUri, db: req.db });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }

    let token;
    try {
      // PKCE: release the verifier that was encrypted against this state, and
      // destroy it in the same step. It is needed for exactly one exchange, and
      // the state is already claimed so there is no retry path to protect.
      // Returning null here is correct and non-fatal: it means this connection
      // was started with META_OAUTH_PKCE=false.
      const codeVerifier = await takePkceVerifier({
        stateId: claimed.id,
        expectedHash: claimed.codeVerifierHash,
        db: req.db
      });
      token = await exchangeCode({ code, redirectUri, codeVerifier });
    } catch (e) {
      if (e instanceof MetaOAuthError || e instanceof OAuthStateError) {
        audit({
          tenantId: claimed.tenantId,
          actorUserId: claimed.actorUserId,
          action: 'integrations.facebook.connect.exchange_failed',
          objectType: 'oauth',
          objectId: claimed.id,
          ip: req.ip,
          // Our own error code only. The verifier, the authorization code and
          // Meta's description are never recorded.
          metadata: { upstream: e.code }
        });
        // A browser redirect, for the same reason as the discovery failure
        // below: the user is returning from Meta's consent screen and needs a
        // page with an explanation, not a JSON body.
        if (e instanceof MetaOAuthError) {
          return res.redirect(303, postLoginUrl({ error: e.code }));
        }
        const sent = sendServiceError(res, e);
        if (sent) return sent;
        return apiError(res, statusForStateError(e.code), e.code, e.message);
      }
      throw e;
    }

    let pages;
    try {
      await stashUserToken({ stateId: claimed.id, userToken: token.accessToken, db: req.db });
      pages = await listAvailablePages({ db: req.db, userAccessToken: token.accessToken });
    } catch (e) {
      // Clear the parked grant on any failure so it cannot linger unused.
      await takeUserToken({ stateId: claimed.id, db: req.db, destroy: true }).catch(() => {});
      // The callback is a BROWSER REDIRECT, not an API call. A person has just
      // come back from Meta's consent screen; showing them raw JSON is a dead
      // end with no way forward. Redirect into the app with our own error code
      // so the connect page can explain what happened and offer a retry.
      if (e instanceof ConnectionError) {
        return res.redirect(303, postLoginUrl({ error: e.code }));
      }
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      if (e instanceof MetaOAuthError) return apiError(res, 502, e.code, e.message);
      throw e;
    }

    audit({
      tenantId: claimed.tenantId,
      actorUserId: claimed.actorUserId,
      action: 'integrations.facebook.connect.authorized',
      objectType: 'oauth',
      objectId: claimed.id,
      ip: req.ip,
      metadata: { pageCount: pages.length }
    });

    // The browser is a person who just clicked through a consent screen, not an
    // API client, so it is redirected into the app rather than shown raw JSON.
    // It receives a state id and nothing else - the page list is fetched by the
    // app over an authenticated call, so no token crosses this redirect.
    return res.redirect(303, postLoginUrl({ stateId: claimed.id }));
  });

  /**
   * GET /integrations/facebook/pages
   *
   * Step 3. Re-reads the grant parked by the callback.
   *
   * The state must belong to THIS user in THIS tenant. Without that check, a
   * stateId observed in one company could be replayed from another to enumerate
   * that administrator's Facebook pages.
   */
  router.get('/pages', requireV1Auth, requireAbility('brand.integration.connect'), async (req, res) => {
    const stateId = String(req.query?.stateId || '');
    if (!UUID.test(stateId)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'stateId must be a uuid');
    }

    // THE GRANT MUST STILL BE UNSPENT.
    //
    // The state and the parked token are read by ONE authoritative statement
    // that requires `confirmed_at IS NULL`. A grant that has already been
    // spent is refused here EVEN IF the parked token has not been cleaned up
    // yet - the old gate depended on that cleanup having landed, which raced
    // the response and could serve the page list for a spent grant.
    let grant;
    try {
      grant = await readUnspentState({
        stateId,
        tenantId: req.v1?.tenantId,
        actorUserId: req.v1?.user?.id,
        db: req.db
      });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }

    if (!grant.ok) {
      if (grant.reason === 'spent') {
        // The authorization was already used. Same response as a cleaned-up
        // grant, and now DETERMINISTIC instead of timing-dependent.
        return apiError(res, 410, 'AUTHORIZATION_EXPIRED', 'the Facebook authorization is no longer available; please reconnect');
      }
      // Not found, expired, or issued to somebody else - all indistinguishable
      // on purpose, so this cannot be used to probe for another user's grants.
      return apiError(res, 400, OAUTH_STATE_ERRORS.NOT_FOUND, 'no active authorization for this user');
    }

    const claimed = grant.state;
    const userToken = grant.userToken;
    if (!userToken) {
      return apiError(res, 410, 'AUTHORIZATION_EXPIRED', 'the Facebook authorization is no longer available; please reconnect');
    }

    try {
      const discovered = await listAvailablePages({ db: req.db, userAccessToken: userToken });
      // Re-project, never pass through. listAvailablePages() carries the per-Page
      // access token because the server needs it to store the credential; that
      // object must not be handed to a browser. Only the fields the chooser needs
      // leave this function.
      return res.json({
        data: {
          brandId: claimed.brand_id,
          pages: discovered.map(({ pageId, name, category, tasks, connectable, missingTasks }) => ({
            pageId, name, category, tasks, connectable, missingTasks
          }))
        }
      });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }
  });

  /**
   * POST /integrations/facebook/confirm
   *
   * Step 4. Persists the connection for the chosen page.
   *
   * The server re-derives the page list from the parked grant instead of
   * trusting the browser's list, and destroys the grant immediately afterwards
   * whether or not the connect succeeded: one authorization, one use.
   */
  router.post('/confirm', requireV1Auth, requireAbility('brand.integration.connect', 'brand.integration.reconnect'), async (req, res) => {
    const tenantId = req.v1?.tenantId;
    const actorUserId = req.v1?.user?.id;
    const { brandId, pageId, mode, stateId } = req.body || {};

    if (!UUID.test(String(brandId))) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
    }
    if (!UUID.test(String(stateId))) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'stateId must be a uuid');
    }
    if (!pageId) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'pageId is required');
    }

    const scope = brandScopeFromSession(req.v1);

    let claimed;
    try {
      claimed = await readConsumedState({ stateId: String(stateId), tenantId, actorUserId, db: req.db });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }

    // EXACT BRAND BINDING.
    //
    // The grant was minted for exactly one brand, chosen BEFORE the consent
    // screen. A confirm that names a different brand is rejected outright.
    //
    // Previously the body's brandId won and the state's was ignored. That was
    // not directly exploitable - connectPage re-checks the brand against the
    // tenant and the caller's scope inside the transaction, so a caller could
    // only ever target a brand they were already entitled to - but it meant the
    // binding recorded at issuance was decorative, and the one moment the user
    // was told "you are connecting this page to THIS brand" was not the moment
    // the database recorded.
    //
    // Changing the brand is still possible, but only by starting a new connect
    // flow with the new brand selected, which re-runs the whole authorization
    // and re-binds the state. There is deliberately no silent override here:
    // an explicit re-selection flow would have to be designed and reviewed
    // before it exists, not bolted on as an escape hatch.
    if (String(claimed.brand_id) !== String(brandId)) {
      return apiError(
        res,
        409,
        'BRAND_DOES_NOT_MATCH_GRANT',
        'this authorization was started for a different brand; start again to connect the page to this one'
      );
    }

    const userToken = await takeUserToken({ stateId: String(stateId), db: req.db });
    if (!userToken) {
      return apiError(res, 410, 'AUTHORIZATION_EXPIRED', 'the Facebook authorization is no longer available; please reconnect');
    }

    // SPEND THE GRANT, ATOMICALLY, BEFORE DOING ANY WORK.
    //
    // One-shot used to be inferred from the parked token being cleared in a
    // finally block whose errors are swallowed. That made a security guarantee
    // depend on best-effort cleanup, and it was observably flaky: a second
    // confirm could succeed when that cleanup did not land.
    //
    // This is a single conditional UPDATE, so exactly one caller can win and the
    // guarantee holds regardless of what happens afterwards. A failed connect
    // still spends the grant, which is the intended fail-closed behaviour: the
    // user starts again rather than retrying a half-used authorization.
    const claimedGrant = await claimGrantForConfirm({
      stateId: String(stateId),
      tenantId,
      actorUserId,
      db: req.db
    });
    if (!claimedGrant) {
      return apiError(res, 410, 'AUTHORIZATION_EXPIRED', 'this Facebook authorization has already been used; please connect again');
    }

    let result = null;
    let failure = null;
    try {
      const availablePages = await listAvailablePages({ db: req.db, userAccessToken: userToken });

      result = await connectPage({
        tenantId,
        actorUserId,
        brandId: String(brandId),
        brandScope: scope,
        availablePages,
        pageId: String(pageId),
        // What B1 ASKED for. The service stores what Meta CONFIRMED, which it
        // reads from the token inspection - never this list.
        requestedScopes: B1_SCOPES,
        actorIp: req.ip,
        mode: mode === 'reconnect' ? 'reconnect' : 'connect',
        db: pool
      });
    } catch (e) {
      failure = e;
    } finally {
      // The parked grant is destroyed BEFORE any response is sent.
      //
      // The `finally` used to run AFTER `res.json(...)`, so the client could
      // observe the response while the cleanup was still in flight. Every
      // response is now sent after this block, so the cleanup always lands
      // first.
      //
      // This is hygiene, NOT the guarantee. The one-shot guarantee is the
      // atomic claim above, and the /pages gate is the persisted-state check
      // in readUnspentState(). Nothing here is relied upon for security.
      await takeUserToken({ stateId: String(stateId), db: req.db, destroy: true }).catch(() => {});
    }

    if (failure) {
      const sent = sendServiceError(res, failure);
      if (sent) return sent;
      throw failure;
    }
    return res.status(201).json({ data: { connection: result } });
  });

  /**
   * GET /integrations/facebook/connections
   *
   * Lists the caller's connections, scoped to their authorised brands. Reports
   * credential presence and expiry only.
   */
  router.get('/connections', requireV1Auth, requireAbility('brand.integration.status'), async (req, res) => {
    const tenantId = req.v1?.tenantId;
    const brandId = req.query?.brandId ? String(req.query.brandId) : null;
    if (brandId && !UUID.test(brandId)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'brandId must be a uuid');
    }
    try {
      const connections = await listConnections({
        db: req.db,
        tenantId,
        brandId,
        scope: brandScopeFromSession(req.v1)
      });
      return res.json({ data: { connections } });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }
  });

  /**
   * DELETE /integrations/facebook/connections/:id
   */
  router.delete('/connections/:id', requireV1Auth, requireAbility('brand.integration.disconnect'), async (req, res) => {
    if (!UUID.test(String(req.params.id))) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'connection id must be a uuid');
    }
    // scope=oauth removes ONLY the OAuth connection. The legacy credential, the
    // Messenger/Comments channels and an active legacy channel are untouched.
    // The default (full) removes the channel and is refused on a legacy-
    // dependent channel, because that would stop a working integration.
    const scope = String(req.query?.scope || 'full');
    if (scope !== 'full' && scope !== 'oauth') {
      return apiError(res, 400, 'VALIDATION_ERROR', 'scope must be "full" or "oauth"');
    }
    try {
      const result = scope === 'oauth'
        ? await disconnectOAuthConnection({
          db: pool,
          tenantId: req.v1?.tenantId,
          actorUserId: req.v1?.user?.id,
          channelId: String(req.params.id),
          // The authenticated session's brand scope. A restricted Supervisor must
          // not be able to disconnect another brand's connection inside their own
          // tenant, so the scope is enforced server-side, not in the UI.
          scope: brandScopeFromSession(req.v1),
          actorIp: req.ip
        })
        : await disconnectPage({
          db: pool,
          tenantId: req.v1?.tenantId,
          actorUserId: req.v1?.user?.id,
          channelId: String(req.params.id),
          scope: brandScopeFromSession(req.v1),
          actorIp: req.ip
        });
      return res.json({ data: result });
    } catch (e) {
      const sent = sendServiceError(res, e);
      if (sent) return sent;
      throw e;
    }
  });

  // NOTE: there is deliberately NO customer-facing "purge" endpoint.
  //
  // The cleanup used to be reachable as POST /integrations/facebook/purge-states
  // behind `brand.integration.status` - an ability that the AGENT role holds.
  // That put a GLOBAL, cross-tenant delete behind a READ permission, and it
  // was not audited. The endpoint is gone.
  //
  // The cleanup is now an internal job in the worker
  // (src/workers/metaEventWorker.js -> startOAuthStateCleanupSweeper), which
  // scrubs the secret material from grants that can no longer be used and then
  // deletes the rows past their retention, under a PostgreSQL advisory lock so
  // exactly one worker replica runs a pass at a time.

  return router;
}