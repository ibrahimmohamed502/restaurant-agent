/**
 * B1 - Meta OAuth provider adapter.
 *
 * Everything Facebook-specific about authorization lives in this file, and
 * nothing above it needs to change if Meta alters a path, a scope name, or the
 * task model. The rest of B1 talks to `beginAuthorization()`, `exchangeCode()`
 * and `discoverPages()`, which are provider-shaped by signature even though only
 * Meta is implemented.
 *
 * GRAPH VERSION — why v26.0, and why this file may not touch the other one
 * ---------------------------------------------------------------------------
 * Verified against Meta's published "Available Graph API Versions" table
 * (developers.facebook.com/docs/graph-api/changelog), read on 2026-10-19:
 *
 *   v26.0  introduced 2026-07-29  available until TBD          <- current
 *   v23.0  introduced 2025-05-29  available until 2027-10-08
 *   v21.0  introduced 2024-10-02  available until 2027-01-21  <- src/facebook.js
 *
 * B1 pins the CURRENT version, v26.0. The endpoints used here are the most
 * stable in the platform - `/oauth/access_token` and `/me/accounts` - so the
 * version carries very little behavioural risk, while pinning an old one on new
 * code buys nothing: v21.0 is still supported but goes end-of-life in about
 * three months, which would put a known deadline on work that has not shipped.
 *
 * The existing reply/comment client in src/facebook.js stays on v21.0. Moving a
 * proven production path onto an API surface this batch never exercises is a
 * separate, deliberate change with its own test pass - it is NOT done here, and
 * it is flagged as a follow-up because v21.0 is end-of-life on 2027-01-21.
 *
 * There is NO fallback. If META_GRAPH_VERSION is set to something unsupported,
 * requests go to that version and fail loudly; the code never silently degrades
 * to a different API surface.
 *
 * CREDENTIALS
 * -----------
 * Secrets are read from the environment at call time and never returned to a
 * caller, logged, or placed in a URL. Read access tokens travel in an
 * Authorization header, never as a query parameter, so they cannot leak through
 * proxy or access logs.
 *
 * THE CODE EXCHANGE — AN OPEN DECISION, NOT A SETTLED ONE
 * -------------------------------------------------------
 * Meta's guide shows the code exchange as a GET with `client_secret` in the query
 * string. THAT IS WHAT THIS ADAPTER DOES BY DEFAULT (`exchangeMethod()` below).
 *
 * The consequence is real and is NOT waived: `client_secret` - the core of the
 * app's security, in Meta's own words - travels in a query string, so it can
 * appear in any proxy log, CDN log or access log between here and Graph. The
 * call is server-to-server, this module never logs the URL, and no error path
 * echoes it, which BOUNDS the exposure. Bounding it is not the same as
 * removing it, and the risk has not been accepted: it is an open decision.
 *
 * Graph also accepts the same parameters over POST, which would keep the secret
 * out of the URL entirely. POST is therefore available as an opt-in
 * (`META_OAUTH_EXCHANGE_METHOD=POST`) but it is UNVERIFIED against the live
 * API, and it is NOT the default.
 *
 * The default was deliberately NOT changed in this batch. Whether to move to
 * POST, or to keep GET and formally accept the residual risk, needs a separate
 * live check against Meta's real endpoint with explicit owner approval.
 *
 * An earlier version of this header claimed POST was what the adapter used. That
 * was wrong. The behaviour described here is the behaviour in the code.
 *
 * (For contrast: `GET /debug_token` DOES reject POST - "Unsupported post
 * request", code 100 / subcode 33. That is a DIFFERENT endpoint and says
 * nothing about `/oauth/access_token`.)
 */

export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/**
 * B1 scopes.
 *
 * Deliberately minimal. Page discovery and read are enough to list and validate
 * a connection; commenting and posting are a later batch and need their own App
 * Review, so requesting them now would block the whole flow for no benefit.
 */
export const B1_SCOPES = Object.freeze([
  'pages_show_list',
  'pages_read_engagement'
]);

export const META_OAUTH_ERRORS = {
  MISSING_CONFIG: 'META_MISSING_CONFIG',
  ACCESS_DENIED: 'META_ACCESS_DENIED',
  CODE_EXCHANGE_FAILED: 'META_CODE_EXCHANGE_FAILED',
  DISCOVERY_FAILED: 'META_DISCOVERY_FAILED',
  NO_MANAGED_PAGES: 'META_NO_MANAGED_PAGES',
  INVALID_REDIRECT_URI: 'META_INVALID_REDIRECT_URI',
  UPSTREAM_UNAVAILABLE: 'META_UPSTREAM_UNAVAILABLE',
  UPSTREAM_ERROR: 'META_UPSTREAM_ERROR',
  TOKEN_INVALID: 'META_TOKEN_INVALID',
  TOKEN_EXPIRED: 'META_TOKEN_EXPIRED',
  TOKEN_WRONG_APP: 'META_TOKEN_WRONG_APP',
  TOKEN_WRONG_TYPE: 'META_TOKEN_WRONG_TYPE',
  TOKEN_WRONG_PAGE: 'META_TOKEN_WRONG_PAGE'
};

export class MetaOAuthError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MetaOAuthError';
    this.code = code;
    this.detail = detail;
  }
}

function appId() {
  const id = process.env.FB_APP_ID;
  if (!id) throw new MetaOAuthError(META_OAUTH_ERRORS.MISSING_CONFIG, 'FB_APP_ID is not configured');
  return id;
}

function appSecret() {
  const s = process.env.FB_APP_SECRET;
  if (!s) throw new MetaOAuthError(META_OAUTH_ERRORS.MISSING_CONFIG, 'FB_APP_SECRET is not configured');
  return s;
}

/**
 * Exact-match redirect URI allowlist.
 *
 * A prefix or wildcard match would let an attacker who can influence the host
 * header route the authorization code somewhere they control. Only the single
 * configured URI is accepted, and it is compared with strict equality.
 */
function allowedRedirectUris() {
  const raw = process.env.META_OAUTH_REDIRECT_URIS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isAllowedRedirectUri(uri) {
  return allowedRedirectUris().includes(uri);
}

export function assertAllowedRedirectUri(uri) {
  if (!uri || !isAllowedRedirectUri(uri)) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.INVALID_REDIRECT_URI,
      'redirect_uri is not in the configured allowlist'
    );
  }
}

/**
 * Facebook Login for Business Configuration ID.
 *
 * Login for Business configurations are addressed explicitly by `config_id` on
 * the authorization URL. An app that has one usable DEFAULT configuration needs
 * nothing here, and B1 must keep working exactly as before when this is unset -
 * so it is optional, never required, and never hardcoded.
 *
 * The value is validated rather than interpolated blindly: it goes into a URL
 * that a browser is sent to, and it comes from the environment. Only a plain
 * identifier is accepted; anything else is a configuration error and fails
 * loudly at connect time rather than producing a request Meta will reject with
 * an opaque message.
 */
export function configId() {
  const raw = String(process.env.META_OAUTH_CONFIG_ID || '').trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.MISSING_CONFIG,
      'META_OAUTH_CONFIG_ID must be a plain identifier (letters, digits, dash, underscore)'
    );
  }
  return raw;
}

/**
 * Build the Meta authorize URL.
 *
 * `state` is passed through untouched: the caller generated it and stored only
 * its hash, so this function must not transform it.
 *
 * config_id AND scope ARE MUTUALLY EXCLUSIVE
 * ------------------------------------------
 * Meta's Facebook Login for Business documentation is explicit about
 * configuration-based flows: "config_id has replaced scope (which should not be
 * used)". A configuration carries its own permission list, so sending `scope`
 * alongside it is not additive - it is two competing declarations of the same
 * thing, and which one wins is not something to bet a first production connect
 * on.
 *
 * So the two modes are mutually exclusive by construction:
 *
 *   META_OAUTH_CONFIG_ID set   -> config_id, and NO scope
 *   META_OAUTH_CONFIG_ID unset -> scope, and NO config_id  (plain Facebook Login)
 *
 * The unset path is byte-identical to the behaviour before config_id existed, so
 * nothing that relied on plain Facebook Login changes.
 */
export function buildAuthorizationUrl({ redirectUri, state, scopes = B1_SCOPES, codeChallenge = null }) {
  assertAllowedRedirectUri(redirectUri);

  // Validated BEFORE the URL is assembled, so a malformed value fails with our
  // own error code instead of producing a request Meta rejects opaquely.
  const cid = configId();

  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);

  if (cid) {
    url.searchParams.set('config_id', cid);
  } else {
    url.searchParams.set('scope', scopes.join(','));
  }

  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/**
 * Build the URL the browser is sent back to in the web app after the callback.
 *
 * OPEN-REDIRECT SAFETY BY CONSTRUCTION: the destination is the ORIGIN of an
 * already-allowlisted redirect URI plus a fixed PATH plus a fixed set of query
 * parameters. No part of it is ever taken from the request, so no attacker-
 * controlled host, scheme or path can reach here. `stateId` is a uuid, not a
 * secret: reading it requires the caller's own session, the same tenant and the
 * same user, so putting it in a URL exposes nothing. The access token is NOT in
 * this URL, which is the entire point.
 */
export function buildPostLoginRedirect({ origin, path = '/integrations/facebook', params = {} } = {}) {
  if (!origin) throw new MetaOAuthError(META_OAUTH_ERRORS.INVALID_REDIRECT_URI, 'no allowlisted origin');
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * POST to Graph and normalise failures.
 *
 * The token is sent in the Authorization header. A Graph error body is reduced
 * to its code and subcode: the free-text message can echo request parameters,
 * so it is logged nowhere and returned to no caller.
 */
async function graphPost(path, params, accessToken = null) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res;
  try {
    res = await fetch(`${META_GRAPH_BASE}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString()
    });
  } catch {
    throw new MetaOAuthError(META_OAUTH_ERRORS.UPSTREAM_UNAVAILABLE, 'Meta Graph API is unreachable');
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MetaOAuthError(META_OAUTH_ERRORS.UPSTREAM_ERROR, `Meta returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || data?.error) {
    const code = data?.error?.code ?? res.status;
    const subcode = data?.error?.error_subcode ?? null;
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.UPSTREAM_ERROR,
      `Meta Graph API error (code ${code}${subcode !== null ? `, subcode ${subcode}` : ''})`,
      { code, subcode }
    );
  }
  return data;
}

/**
 * GET against Graph, for read-only discovery calls.
 *
 * The one exception is /oauth/access_token, which legitimately carries NO
 * bearer token: it authenticates with client_id/client_secret as parameters,
 * because that is the documented shape when META_OAUTH_EXCHANGE_METHOD=GET.
 * Every other read still requires a token, so this cannot become a way to call
 * Graph unauthenticated.
 */
async function graphGet(path, params, accessToken) {
  const isCodeExchange = path === '/oauth/access_token';
  if (!accessToken && !isCodeExchange) {
    throw new MetaOAuthError(META_OAUTH_ERRORS.MISSING_CONFIG, 'access token required');
  }
  const url = new URL(`${META_GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new MetaOAuthError(META_OAUTH_ERRORS.UPSTREAM_UNAVAILABLE, 'Meta Graph API is unreachable');
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MetaOAuthError(META_OAUTH_ERRORS.UPSTREAM_ERROR, `Meta returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || data?.error) {
    const code = data?.error?.code ?? res.status;
    const subcode = data?.error?.error_subcode ?? null;
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.UPSTREAM_ERROR,
      `Meta Graph API error (code ${code}${subcode !== null ? `, subcode ${subcode}` : ''})`,
      { code, subcode }
    );
  }
  return data;
}

/**
 * Trade the authorization code for a short-lived User Access Token.
 *
 * Returns the token to the caller for immediate use. This function never
 * persists it and never logs it: storage is the connection service's job, and
 * only after a Page has been chosen and validated.
 */
/**
 * HTTP method for the code exchange.
 *
 * RESEARCHED 2026-10-19 against Meta's official documentation. Every official
 * page that shows this endpoint uses GET with the parameters in the query string:
 *   - Facebook Login, "Manually Build a Login Flow"  -> GET
 *   - Facebook Login, "Get a Long-Lived User Access Token" -> curl -X GET
 *   - "Access Tokens for Meta Technologies"         -> curl -X GET
 *   - Marketing API, "Authentication"               -> GET
 * POST appears only in community threads, where developers report that it works.
 * That is evidence of tolerance, NOT of documented support.
 *
 * SO THE DEFAULT IS THE DOCUMENTED FORM: GET. Choosing an undocumented path for
 * the first real integration would mean betting the entire connect flow on
 * undocumented tolerance, and the cost of being wrong is total failure of B1.
 *
 * The residual risk of GET is that client_secret travels in a query string. It
 * is bounded here because the call is server-to-server, the URL is never logged
 * by this module, and no error path can echo it - all asserted in the suite.
 *
 *   GET  (default)  - the documented form. client_secret IS in the query string.
 *   POST (opt-in)   - undocumented; keeps client_secret out of the URL. Set
 *                     META_OAUTH_EXCHANGE_METHOD=POST only after confirming it
 *                     works against the live API.
 *
 * NOT A WAIVER. The default was left at GET because switching it is a security
 * decision that has not been taken, not because the GET risk was evaluated and
 * accepted. The open question is recorded in the file header: does Graph accept
 * POST on /oauth/access_token? Answering it needs a live Meta call, which
 * needs its own explicit owner approval. Until that happens the code keeps the
 * documented form and the risk stays visible and unresolved.
 */
export function exchangeMethod() {
  const m = String(process.env.META_OAUTH_EXCHANGE_METHOD || 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'POST') {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.MISSING_CONFIG,
      'META_OAUTH_EXCHANGE_METHOD must be GET or POST'
    );
  }
  return m;
}

/**
 * Trade the authorization code for a short-lived User Access Token.
 *
 * Returns the token to the caller for immediate use. This function never
 * persists it and never logs it: storage is the connection service's job, and
 * only after a Page has been chosen and validated.
 */
export async function exchangeCode({ code, redirectUri, codeVerifier = null }) {
  if (!code) throw new MetaOAuthError(META_OAUTH_ERRORS.CODE_EXCHANGE_FAILED, 'authorization code is required');
  assertAllowedRedirectUri(redirectUri);

  const params = {
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri,
    code,
    grant_type: 'authorization_code'
  };
  if (codeVerifier) params.code_verifier = codeVerifier;

  const data = exchangeMethod() === 'GET'
    ? await transport.get('/oauth/access_token', params, null)
    : await transport.post('/oauth/access_token', params);
  if (!data?.access_token) {
    throw new MetaOAuthError(META_OAUTH_ERRORS.CODE_EXCHANGE_FAILED, 'Meta did not return an access token');
  }

  return {
    accessToken: data.access_token,
    // Meta omits expires_in for Page-derived tokens because they do not expire.
    // `null` means "no stated expiry", which is NOT the same as "never expires";
    // the connection service treats it as unknown rather than eternal.
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null
  };
}

/**
 * List the Pages the authorizing user actually manages.
 *
 * `tasks` is the field that matters. A Page appearing in `pages_show_list`
 * only proves the user is associated with it; the task list is what proves the
 * app can act. B1 records the tasks so a connection that can list but not manage
 * is visible as such instead of silently failing later.
 */
export async function discoverPages({ userAccessToken, limit = 100 } = {}) {
  const data = await transport.get(
    '/me/accounts',
    { fields: 'id,name,access_token,tasks,category,picture{url}', limit: String(limit) },
    userAccessToken
  );

  const pages = Array.isArray(data?.data) ? data.data : [];
  const normalized = pages.map((p) => ({
    pageId: String(p.id),
    name: p.name ?? null,
    category: p.category ?? null,
    pictureUrl: p?.picture?.data?.url ?? p?.picture?.url ?? null,
    // Normalised to lowercase so comparison and persistence are case-insensitive.
    tasks: Array.isArray(p.tasks) ? p.tasks.map((t) => String(t).toUpperCase()) : [],
    pageAccessToken: p.access_token ?? null
  }));

  return normalized;
}

/**
 * Which Page Tasks a connection must carry.
 *
 * CONNECT SCOPE vs FEATURE SCOPE. These are different questions and conflating
 * them is what made the original threshold wrong.
 *
 *   - CONNECT asks: may this Page be linked to a brand? B1 does nothing more
 *     than store a Page access token and list it. It does not post, reply or
 *     moderate.
 *   - FEATURE asks: may the agent post / reply / moderate? That belongs to the
 *     Inbox, publishing and automation batches, and each should check its own
 *     task at the moment it needs it.
 *
 * Demanding CREATE_CONTENT and MODERATE at connect time asks a Page to prove it
 * supports features that do not exist yet. That is asking for future capability
 * without justification, and it refuses legitimate Pages for the sake of later
 * batches.
 *
 * DEFAULT: MANAGE only. It is the smallest task that establishes genuine Page
 * administration rather than mere visibility, so it is a real gate and not a
 * formality. READ_CONTENT is explicitly NOT sufficient: a Page the app can see
 * but not act on would connect and then fail silently on first use.
 *
 * THE LADDER (set META_OAUTH_REQUIRED_TASKS, comma-separated):
 *   MANAGE                        - default; connect-only scope
 *   MANAGE,CREATE_CONTENT         - add when a publishing feature ships
 *   MANAGE,CREATE_CONTENT,MODERATE- original threshold; keep as the post-Inbox target
 *   READ_CONTENT                  - not recommended; reintroduces silent failure
 *
 * The ACTUAL task values Meta returns for this app are unverified and are on the
 * Meta Dashboard inspection list. If they differ, every Page is reported as not
 * connectable with the missing names listed - visible, not silent.
 */
export const B1_DEFAULT_REQUIRED_TASKS = Object.freeze(['MANAGE']);

/** Documented ladder, surfaced so the UI and the operator agree on the options. */
export const PAGE_TASK_LADDER = Object.freeze({
  connectOnly: Object.freeze(['MANAGE']),
  withPublishing: Object.freeze(['MANAGE', 'CREATE_CONTENT']),
  withModeration: Object.freeze(['MANAGE', 'CREATE_CONTENT', 'MODERATE'])
});

export function requiredPageTasks() {
  const raw = process.env.META_OAUTH_REQUIRED_TASKS;
  if (!raw) return B1_DEFAULT_REQUIRED_TASKS;
  const list = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return list.length ? Object.freeze(list) : B1_DEFAULT_REQUIRED_TASKS;
}

export function assessPagePermissions(tasks = []) {
  const required = requiredPageTasks();
  const upper = new Set(tasks.map((t) => String(t).toUpperCase()));
  const granted = required.filter((t) => upper.has(t));
  const missing = required.filter((t) => !upper.has(t));
  return {
    connectable: missing.length === 0,
    grantedTasks: granted,
    missingTasks: missing,
    // Reported so the UI can explain the ACTUAL tasks held, not just the
    // requirement, when the threshold is configured.
    requiredTasks: required
  };
}

/**
 * Inspect an access token WITHOUT using it to do anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * Meta's own documented way to learn what a token can do is `GET /debug_token`,
 * which returns the token's type, the scopes it carries, the Page it is bound to,
 * and when it expires. It is a READ. It never posts, never comments, never
 * messages. A capability check that sent a real message would be a write to a
 * customer's Page, which is not a diagnostic and is not acceptable here.
 *
 * It needs an app access token to inspect a token. The app secret never leaves
 * the server, and the inspecting request is a server-to-server GET.
 *
 * The RESULT is deliberately a small, sanitised object: type, scopes, Page id,
 * expiry. No token value is returned, stored in it, or loggable from it.
 *
 * @param {object}  args
 * @param {string}  args.token            the token to inspect (never returned)
 * @param {string?} args.expectedPageId   the Page this token must be bound to
 * @returns {Promise<{valid:boolean,type:?string,scopes:?string[],pageId:?string,expiresAt:?number,appId:?string}>}
 *
 * THREE STATES PER FIELD, NOT TWO
 * -------------------------------
 * Meta's answer is allowed to be partial, and a partial answer is not the same
 * as an empty one. Every field below therefore distinguishes three cases:
 *
 *   scopes     a list  -> Meta CONFIRMED these scopes
 *             absent   -> UNKNOWN. Not an empty list, and never reported as one.
 *   expiresAt  > 0     -> a real expiry, in seconds since the epoch
 *             0       -> Meta states the token NEVER expires (a positive fact)
 *             absent   -> UNKNOWN. Not "never expires", and never reported so.
 *
 * Collapsing any of those unknowns into a definite value is how a connection
 * ends up displaying a state nobody verified.
 */
export async function inspectToken({ token, expectedPageId = null } = {}) {
  if (!token) {
    throw new MetaOAuthError(META_OAUTH_ERRORS.TOKEN_INVALID, 'no token to inspect');
  }

  // The app access token is `app_id|app_secret`. It is used server-side only,
  // never leaves this function, and is sent in the Authorization HEADER - never
  // in a query string and never in the request body. The app secret is the most
  // sensitive value in this codebase; it has no business in a URL.
  const appAccessToken = `${appId()}|${appSecret()}`;

  // The DOCUMENTED form. Meta's reference shows GET, and every SDK example
  // (PHP, JS, Java, iOS) uses HttpMethod.GET. An earlier version tried POST,
  // which is cleaner for the secret, but a live probe against Meta's actual
  // endpoint proved POST is NOT supported for this edge:
  //
  //   POST with params    -> HTTP 400 "Unsupported post request"
  //                          (code 100, subcode 33)
  //   GET  with params    -> HTTP 200, a well-formed inspection result
  //
  // So POST is a dead end here. The app secret travels in the
  // Authorization header (never the URL), and the token under inspection is in
  // the query string, because the documented form requires it. The token is
  // short-lived and page-scoped; the app secret is the value that must never
  // leave the server, and it does not.
  //
  // The inspected token therefore appears in one server-to-server URL to Meta's
  // own API. That is the same posture the documented code exchange already has
  // for client_secret, and it is the only supported shape for this endpoint.
  let data;
  try {
    data = await transport.get('/debug_token', { input_token: token }, appAccessToken);
  } catch (e) {
    // FAIL CLOSED. A network error or an auth failure is a real rejection:
    // the token is not stored.
    throw e;
  }

  const d = data?.data;
  if (!d) {
    throw new MetaOAuthError(META_OAUTH_ERRORS.TOKEN_INVALID, 'Meta returned no token metadata');
  }

  // SCOPES: confirmed list, or UNKNOWN.
  //
  // An absent `scopes` array is not an empty one. "Meta confirmed this token
  // carries no scopes" is a fact; "Meta did not say" is unknown. Only the first
  // may ever be presented as a confirmed list, so the absent case is carried as
  // `null` and NEVER as `[]`.
  const scopes = Array.isArray(d.scopes) ? d.scopes.map(String) : null;

  const pageId = d.profile_id ? String(d.profile_id) : null;

  // EXPIRY: the same three-way distinction.
  //   > 0    a real expiry, in seconds since the epoch
  //   0      Meta states the token NEVER expires - a positive statement
  //   absent Meta said nothing - unknown
  const expiresAt = typeof d.expires_at === 'number' ? d.expires_at : null;

  // The checks below are REJECTIONS, not capability gates. A token that is
  // invalid, expired, issued for a different app, of the wrong type, or bound to
  // a different Page is not a usable credential for this connection and must not
  // be stored.
  //
  // A token that is merely MISSING Messenger or Comments scopes is NOT rejected.
  // Basic Page connection must not depend on services activated later.
  //
  // FAIL CLOSED ON VALIDITY. `is_valid` must be EXPLICITLY true.
  //
  // A response that omits `is_valid` is not a pass. Treating "Meta did not say
  // the token is valid" as "the token is valid" is precisely the assumption
  // this inspection exists to remove, so an absent flag is a REJECTION.
  if (d.is_valid !== true) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.TOKEN_INVALID,
      d.is_valid === false
        ? 'Meta reports the token is not valid'
        : 'Meta did not confirm the token is valid'
    );
  }
  if (expiresAt !== null && expiresAt > 0 && expiresAt * 1000 <= Date.now()) {
    // A POSITIVE expiry that has already passed. `expires_at === 0` is not an
    // expiry in the past - it is Meta saying the token never expires - so it is
    // deliberately not matched here.
    throw new MetaOAuthError(META_OAUTH_ERRORS.TOKEN_EXPIRED, 'the token has already expired');
  }
  if (d.app_id && String(d.app_id) !== String(appId())) {
    throw new MetaOAuthError(META_OAUTH_ERRORS.TOKEN_WRONG_APP, 'the token was issued for a different app');
  }

  // `type` is USER for a user token and PAGE for a Page token. A Page token
  // carries `profile_id` - the Page it is bound to. Either signal identifies it;
  // if neither is present the token cannot be confirmed as a Page token.
  const type = d.type ? String(d.type) : null;
  if (type && type.toUpperCase() !== 'PAGE' && !pageId) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.TOKEN_WRONG_TYPE,
      'the token is not a Page access token'
    );
  }
  if (!type && !pageId) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.TOKEN_WRONG_TYPE,
      'the token could not be confirmed as a Page access token'
    );
  }
  if (expectedPageId && pageId && pageId !== String(expectedPageId)) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.TOKEN_WRONG_PAGE,
      'the token is bound to a different Page'
    );
  }
  if (expectedPageId && !pageId) {
    throw new MetaOAuthError(
      META_OAUTH_ERRORS.TOKEN_WRONG_PAGE,
      'the token does not identify a Page'
    );
  }

  // Sanitised result. No token value, no error text, nothing free-form.
  return {
    // True because the code above only reaches here when Meta EXPLICITLY said
    // so. There is no "assumed valid" path.
    valid: true,
    type,
    // null means Meta did not state the scopes. It is NOT an empty list.
    scopes,
    pageId,
    // 0 means "never expires"; null means "Meta said nothing".
    expiresAt,
    appId: d.app_id ? String(d.app_id) : null
  };
}

/** Translate a Meta `error=...` callback parameter into our own codes. */
export function mapCallbackError(error, errorDescription = null) {
  switch (error) {
    case 'access_denied':
      return {
        code: META_OAUTH_ERRORS.ACCESS_DENIED,
        message: 'Permission to connect this Facebook account was denied.'
      };
    case 'invalid_request':
      return {
        code: META_OAUTH_ERRORS.INVALID_REDIRECT_URI,
        message: 'Meta rejected the request as invalid. Check the redirect URI allowlist.'
      };
    case 'temporarily_unavailable':
      return {
        code: META_OAUTH_ERRORS.UPSTREAM_UNAVAILABLE,
        message: 'Facebook is temporarily unavailable. Please try again.'
      };
    default:
      return {
        code: META_OAUTH_ERRORS.UPSTREAM_ERROR,
        // The description can echo request parameters, so it is deliberately
        // dropped rather than logged or returned.
        message: 'Facebook returned an error during authorization.',
        upstreamError: error ?? null
      };
  }
}

/**
 * Injectable Graph transport.
 *
 * The default is the real HTTP implementation above. Tests swap in a
 * deterministic mock so the whole connect flow can be exercised without a
 * network call, a real Facebook account, or a real token.
 *
 * Every call site goes through this binding rather than through graphPost /
 * graphGet directly - that indirection is the whole point, and a direct call
 * would silently bypass the mock and hit Meta for real.
 */
let transport = { post: graphPost, get: graphGet };

export function setGraphTransport(next) {
  transport = { post: graphPost, get: graphGet, ...(next || {}) };
}

export function resetGraphTransport() {
  transport = { post: graphPost, get: graphGet };
}

export function getGraphTransport() {
  return transport;
}