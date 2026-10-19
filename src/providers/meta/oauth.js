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
 * DELIBERATE DEVIATION FROM META'S DOCUMENTED EXAMPLE
 * --------------------------------------------------
 * Meta's guide shows the code exchange as a GET with client_secret in the query
 * string. That is not used. A GET puts the app secret - the core of the app's
 * security, in Meta's own words - into every proxy log, CDN log and access log
 * between here and Graph. Graph accepts the same parameters over POST, and that
 * is what this adapter uses. The behaviour and the response are identical.
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
  UPSTREAM_ERROR: 'META_UPSTREAM_ERROR'
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
 * Build the Meta authorize URL.
 *
 * `state` is passed through untouched: the caller generated it and stored only
 * its hash, so this function must not transform it.
 */
export function buildAuthorizationUrl({ redirectUri, state, scopes = B1_SCOPES, codeChallenge = null }) {
  assertAllowedRedirectUri(redirectUri);

  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(','));
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

/** Same as graphPost but GET, for read-only discovery calls. */
async function graphGet(path, params, accessToken) {
  if (!accessToken) {
    throw new MetaOAuthError(META_OAUTH_ERRORS.MISSING_CONFIG, 'access token required');
  }
  const url = new URL(`${META_GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
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

  const data = await transport.post('/oauth/access_token', params);
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
 * Decide whether a discovered Page can be connected by B1.
 *
 * Tasks that permit reading content and replying to comments are sufficient for
 * B1's connection semantics. Read-only access is explicitly NOT treated as
 * sufficient: a Page the app can see but not act on would connect successfully and
 * then fail silently on the first real use, which is worse than refusing.
 */
export const B1_REQUIRED_TASKS = Object.freeze(['MANAGE', 'CREATE_CONTENT', 'MODERATE']);

export function assessPagePermissions(tasks = []) {
  const upper = new Set(tasks.map((t) => String(t).toUpperCase()));
  const granted = B1_REQUIRED_TASKS.filter((t) => upper.has(t));
  const missing = B1_REQUIRED_TASKS.filter((t) => !upper.has(t));
  return {
    connectable: missing.length === 0,
    grantedTasks: granted,
    missingTasks: missing
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