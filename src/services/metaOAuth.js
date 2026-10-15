/**
 * Stage 8 Batch 3 — Facebook Page self-service OAuth service.
 *
 * Responsibilities (deliberately narrow — token lifecycle automation, Instagram
 * and health writeback are later batches):
 *   1. Mint + verify a signed, single-use OAuth state (session-bound).
 *   2. Exchange the Meta authorization code and discover the Pages the admin
 *      actually has a role on.
 *   3. Hold page tokens server-side, encrypted, behind a SEPARATE short-lived
 *      flow authorization used by the page picker + connect step.
 *   4. Store the channel + credential transactionally, then (bounded) subscribe
 *      the Page webhook.
 *
 * SECURITY RULES
 *   - Tenant/brand identity always comes from the session (the caller), never
 *     from query parameters; the state merely *carries* the signed identity.
 *   - State consumption is ONE atomic statement that is also session-bound, so
 *     an unauthorized session can neither consume nor steal another user's state.
 *   - The page picker and connect step require the separate flow token
 *     (`X-Flow-Token`); the OAuth state alone is not sufficient.
 *   - Tokens/codes never appear in URLs, logs, audit rows or API responses.
 *   - `redirect_uri` is built ONLY from PUBLIC_BASE_URL (never the Host header).
 *   - All Graph errors are mapped to allow-listed codes (healthCodes.js).
 *
 * META SEMANTICS (re-verified against Meta docs, 2026-10):
 *   - Long-lived USER token: GET /oauth/access_token?grant_type=fb_exchange_token
 *     with client_id + client_secret + fb_exchange_token → returns expires_in.
 *     `offline_access` is NOT required and is not requested.
 *   - Page tokens: returned by GET /me/accounts with a long-lived user token.
 *     Meta documents that long-lived PAGE tokens have NO expiration date and can
 *     be invalidated at any time → we therefore NEVER write a page expiry.
 *   - Page webhook subscription: POST /{page_id}/subscribed_apps?subscribed_fields=…
 *     requires pages_manage_metadata + pages_show_list and a page token from a
 *     person with a MANAGE/MODERATE/CREATE_CONTENT task.
 */

import crypto from 'node:crypto';
import { pool } from '../db/pg.js';
import { encrypt, decrypt } from '../db/crypto.js';

const GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** OAuth state / flow lifetime. Both are short-lived by design. */
export const STATE_TTL_SECONDS = 600;
export const FLOW_TTL_SECONDS = 600;

/** Bounded, SHORT subscription attempts — an HTTP request is never held long. */
export const SUBSCRIBE_ATTEMPTS = 2;
export const SUBSCRIBE_BACKOFF_MS = 1000;

/** Fields requested from /me/accounts. Tokens are read here and never returned. */
const PAGE_FIELDS = 'id,name,access_token,tasks,category,fan_count';

/** Webhook fields we ask the Page to subscribe to (app level must match — see docs). */
export const SUBSCRIBED_FIELDS = 'feed,messages';

/** Scopes requested at consent. No offline_access (server-side exchange instead). */
export const REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_engagement'
];

export const OAUTH_ERRORS = {
  NOT_CONFIGURED: 'OAUTH_NOT_CONFIGURED',
  STATE_INVALID: 'OAUTH_STATE_INVALID',
  SESSION_MISMATCH: 'OAUTH_SESSION_MISMATCH',
  CONSENT_DENIED: 'OAUTH_CONSENT_DENIED',
  CODE_INVALID: 'OAUTH_CODE_INVALID',
  EXCHANGE_FAILED: 'OAUTH_TOKEN_EXCHANGE_FAILED',
  DISCOVERY_FAILED: 'OAUTH_PAGE_DISCOVERY_FAILED',
  NOT_AUTHORIZED: 'OAUTH_NOT_AUTHORIZED',
  FLOW_INVALID: 'OAUTH_FLOW_INVALID',
  PAGE_ALREADY_CONNECTED: 'PAGE_ALREADY_CONNECTED',
  BRAND_CONFLICT: 'BRAND_CONFLICT',
  SUBSCRIPTION_FAILED: 'SUBSCRIPTION_FAILED'
};

export const CONNECTION_STATES = {
  NOT_CONNECTED: 'not_connected',
  PENDING_SUBSCRIPTION: 'pending_subscription',
  SUBSCRIPTION_FAILED: 'subscription_failed',
  NEEDS_ATTENTION: 'needs_attention',
  CONNECTED: 'connected',
  UNKNOWN: 'unknown'
};

export class MetaOAuthError extends Error {
  constructor(code, status = 400, detail = '') {
    super(detail || code);
    this.name = 'MetaOAuthError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ config */

/** Secret used to sign OAuth state. Dedicated var preferred; ENCRYPTION_KEY fallback. */
function stateSecret() {
  const s = process.env.OAUTH_STATE_SECRET || process.env.ENCRYPTION_KEY;
  if (!s || s.length < 32) return null;
  return s;
}

/**
 * PUBLIC_BASE_URL is the ONLY source of the OAuth callback. The request Host
 * header is never trusted (host-header injection would leak the code).
 * Returns null when unset/invalid → OAuth stays disabled (fail closed).
 */
export function publicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const url = raw.trim().replace(/\/+$/, '');
  const allowHttp = process.env.ALLOW_INSECURE_OAUTH_HTTP === 'true';
  if (!/^https:\/\//i.test(url) && !(allowHttp && /^http:\/\//i.test(url))) return null;
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/** Everything required for self-service must be present; otherwise stay disabled. */
export function oauthReadiness() {
  const base = publicBaseUrl();
  const secret = Boolean(stateSecret());
  const appId = Boolean(process.env.FB_APP_ID);
  const appSecret = Boolean(process.env.FB_APP_SECRET);
  const enabled = Boolean(base && secret && appId && appSecret);
  return {
    enabled,
    // Never expose secret material — booleans only.
    missing: [
      !base ? 'PUBLIC_BASE_URL' : null,
      !secret ? 'OAUTH_STATE_SECRET' : null,
      !appId ? 'FB_APP_ID' : null,
      !appSecret ? 'FB_APP_SECRET' : null
    ].filter(Boolean)
  };
}

export function redirectUri() {
  const base = publicBaseUrl();
  return base ? `${base}/api/v1/integrations/meta/callback` : null;
}

/* ------------------------------------------------------------------- state */

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function sign(payload) {
  return crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex');
}

/** Create the signed state. Returns the opaque state string + its nonce hash. */
export function createState({ tenantId, userId, brandId }) {
  const secret = stateSecret();
  if (!secret) throw new MetaOAuthError(OAUTH_ERRORS.NOT_CONFIGURED, 503);
  const nonce = crypto.randomBytes(24).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  const payload = `${nonce}|${tenantId}|${userId}|${brandId ?? ''}|${exp}`;
  const state = `${nonce}.${sign(payload)}.${exp}`;
  return { state, nonceHash: sha256(nonce), expiresAt: new Date(exp * 1000) };
}

/** Pure parse of the opaque state string. Performs NO database access. */
export function parseState(state) {
  if (typeof state !== 'string' || state.length > 512) return null;
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [nonce, mac, expRaw] = parts;
  const exp = Number(expRaw);
  if (!nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return null;
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
  return { nonce, mac, exp, nonceHash: sha256(nonce), expiresAt: new Date(exp * 1000) };
}

/** Load the state row by nonce hash (the raw nonce is never stored). */
export async function loadStateByNonceHash(nonceHash, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT id, tenant_id, user_id, brand_id, expires_at, consumed_at
       FROM oauth_connect_states WHERE nonce_hash = $1`,
    [nonceHash]
  );
  return rows[0] ?? null;
}

/** Verify the MAC against the AUTHORITATIVE stored identity (brand included). */
export function verifyStateSignature(parsed, row) {
  const secret = stateSecret();
  if (!secret || !parsed || !row) return false;
  const expected = sign(`${parsed.nonce}|${row.tenant_id}|${row.user_id}|${row.brand_id ?? ''}|${parsed.exp}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.mac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * ATOMIC + SESSION-BOUND consumption.
 *
 * The tenant and user are part of the WHERE clause, so a session that is not the
 * one that started the flow matches ZERO rows — it can neither consume the state
 * nor learn that it exists. A concurrent callback wins exactly once.
 */
export async function consumeState({ stateId, tenantId, userId }, { db = pool } = {}) {
  const { rows } = await db.query(
    `UPDATE oauth_connect_states
        SET consumed_at = now()
      WHERE id = $1
        AND tenant_id = $2
        AND user_id = $3
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, tenant_id, user_id, brand_id, expires_at`,
    [stateId, tenantId, userId]
  );
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------- flow */

/**
 * Separate short-lived server-side authorization for the page picker + connect.
 * The raw token is returned once; only its hash is stored.
 */
export async function createFlow({ stateRow }, { db = pool } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await db.query(
    `INSERT INTO oauth_connect_flows (state_id, tenant_id, user_id, brand_id, token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
     RETURNING id, expires_at`,
    [stateRow.id, stateRow.tenant_id, stateRow.user_id, stateRow.brand_id ?? null, sha256(token), String(FLOW_TTL_SECONDS)]
  );
  return { flowId: rows[0].id, flowToken: token, expiresAt: rows[0].expires_at };
}

/** Validate + touch a flow. Session-bound; returns the row or null. */
export async function validateFlow({ flowId, flowToken, tenantId, userId }, { db = pool } = {}) {
  if (!flowId || !flowToken || String(flowId).length > 64 || String(flowToken).length > 128) return null;
  const { rows } = await db.query(
    `UPDATE oauth_connect_flows
        SET last_used_at = now()
      WHERE id::text = $1
        AND tenant_id = $2
        AND user_id = $3
        AND token_hash = $4
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, state_id, brand_id, user_token_expires_at, expires_at`,
    [String(flowId), tenantId, userId, sha256(flowToken)]
  );
  return rows[0] ?? null;
}

/**
 * ATOMIC validation + consumption of the connection flow.
 *
 * One UPDATE verifies EVERYTHING that authorizes the connect step — token
 * hash, tenant, user, expiry and unused status — and consumes it. A valid
 * flowId without the matching token matches ZERO rows: it connects nothing
 * and leaves the flow unused for the rightful owner. Concurrent requests
 * therefore race on the row lock and exactly one wins.
 */
export async function consumeFlow({ flowId, flowToken, tenantId, userId }, { db = pool } = {}) {
  if (typeof flowToken !== 'string' || flowToken.length < 16 || flowToken.length > 128) return null;
  const { rows } = await db.query(
    `UPDATE oauth_connect_flows
        SET consumed_at = now(), last_used_at = now()
      WHERE id::text = $1 AND tenant_id = $2 AND user_id = $3
        AND token_hash = $4
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, state_id, brand_id, user_token_expires_at, expires_at`,
    [String(flowId), tenantId, userId, sha256(flowToken)]
  );
  return rows[0] ?? null;
}

/** Record the user-token expiry on the flow (diagnostics only, never a Page expiry). */
export async function setFlowUserTokenExpiry({ flowId, expiresAt }, { db = pool } = {}) {
  if (!expiresAt) return;
  await db.query(`UPDATE oauth_connect_flows SET user_token_expires_at = $2 WHERE id::text = $1`, [String(flowId), expiresAt]);
}

/* ----------------------------------------------------------- page storage */

/** Store the pages discovered for this flow. Page tokens are encrypted at rest. */
export async function storeFlowPages({ flowId, pages }, { db = pool } = {}) {
  for (const p of pages) {
    const enc = encrypt(p.accessToken);
    await db.query(
      `INSERT INTO oauth_connect_pages (flow_id, page_id, page_name, page_tasks, page_category, token_encrypted, iv)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (flow_id, page_id) DO UPDATE
         SET token_encrypted = EXCLUDED.token_encrypted,
             iv = EXCLUDED.iv,
             page_name = EXCLUDED.page_name,
             page_tasks = EXCLUDED.page_tasks`,
      [flowId, p.id, p.name ?? null, p.tasks ?? null, p.category ?? null, enc.value, enc.iv]
    );
  }
}

/** Page metadata for the picker. Page tokens are NEVER returned. */
export async function listFlowPages({ flowId }, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT page_id, page_name, page_tasks, page_category
       FROM oauth_connect_pages WHERE flow_id = $1 ORDER BY page_name NULLS LAST, page_id`,
    [flowId]
  );
  return rows.map((r) => ({
    id: r.page_id,
    name: r.page_name,
    tasks: r.page_tasks ?? [],
    category: r.page_category ?? null
  }));
}

/** Fetch + decrypt one page token. Server-side use only. */
export async function pageTokenFor({ flowId, pageId }, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT token_encrypted, iv FROM oauth_connect_pages WHERE flow_id = $1 AND page_id = $2`,
    [flowId, String(pageId)]
  );
  if (!rows[0]) return null;
  return decrypt(rows[0].token_encrypted, rows[0].iv);
}

/** Lazy cleanup — no cron in this batch. Called when a new flow is started. */
export async function purgeExpiredFlows({ db = pool } = {}) {
  await db.query(`DELETE FROM oauth_connect_states WHERE expires_at < now() - interval '1 hour'`).catch(() => undefined);
}

/* ------------------------------------------------------------ meta calls */

/**
 * Map a Graph error payload to an allow-listed short code.
 * Accepts the provider payload object OR a string. The payload text is used
 * ONLY for this classification and is never stored on, logged from or returned
 * with the thrown error.
 */
function mapGraphError(err) {
  const payload = typeof err === 'object' && err !== null ? err : null;
  const msg = `${payload?.message ?? (typeof err === 'string' ? err : '')} code ${payload?.code ?? ''}`;
  if (/code 190|Invalid OAuth 2.0 Access Token|access token has expired/i.test(msg)) return 'META_GRAPH_AUTH';
  if (/code 200|Permission|OAuthException|not authorized/i.test(msg)) return 'META_GRAPH_PERMISSION';
  if (/code 4\d\d|rate limit|too many requests|#17/i.test(msg)) return 'META_GRAPH_RATE_LIMIT';
  return 'META_GRAPH_ERROR';
}

async function graphGet(path, accessToken) {
  const res = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = new Error('Graph API request failed');
    e.safeCode = mapGraphError(data?.error);
    throw e;
  }
  return data;
}

async function graphPost(path, accessToken) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = new Error('Graph API request failed');
    e.safeCode = mapGraphError(data?.error);
    throw e;
  }
  return data;
}

/** code → short-lived user token. */
export async function exchangeCode({ code, redirectUri: ru }) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('client_id', process.env.FB_APP_ID ?? '');
  url.searchParams.set('client_secret', process.env.FB_APP_SECRET ?? '');
  url.searchParams.set('redirect_uri', ru);
  url.searchParams.set('code', String(code));
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error || !data?.access_token) {
    throw new MetaOAuthError(OAUTH_ERRORS.CODE_INVALID, 400);
  }
  return { userToken: data.access_token };
}

/** Short-lived → long-lived user token. Expiry comes from the response, never assumed. */
export async function exchangeLongLived({ userToken }) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', process.env.FB_APP_ID ?? '');
  url.searchParams.set('client_secret', process.env.FB_APP_SECRET ?? '');
  url.searchParams.set('fb_exchange_token', String(userToken));
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error || !data?.access_token) {
    throw new MetaOAuthError(OAUTH_ERRORS.EXCHANGE_FAILED, 502);
  }
  const expiresAt = Number.isFinite(Number(data.expires_in))
    ? new Date(Date.now() + Number(data.expires_in) * 1000)
    : null;
  return { userToken: data.access_token, expiresAt };
}

/** Pages this user actually has a task role on — the ownership proof. */
export async function discoverPages({ userToken }) {
  try {
    const data = await graphGet(`/me/accounts?fields=${encodeURIComponent(PAGE_FIELDS)}`, userToken);
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    throw new MetaOAuthError(OAUTH_ERRORS.DISCOVERY_FAILED, 502, err?.safeCode ?? '');
  }
}

/** Inspect a token (validity + granted scopes). Diagnostics only. */
export async function inspectToken({ token }) {
  try {
    const url = new URL(`${GRAPH_BASE}/debug_token`);
    url.searchParams.set('input_token', String(token));
    url.searchParams.set('access_token', `${process.env.FB_APP_ID ?? ''}|${process.env.FB_APP_SECRET ?? ''}`);
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const info = data?.data ?? {};
    return {
      isValid: Boolean(info.is_valid),
      scopes: Array.isArray(info.scopes) ? info.scopes : [],
      expiresAt: info.expires_at ? new Date(Number(info.expires_at) * 1000) : null
    };
  } catch {
    return { isValid: false, scopes: [], expiresAt: null };
  }
}

/**
 * Subscribe the Page webhook. Bounded, short attempts only (never a long-held
 * HTTP request). Returns a sanitized code on failure.
 */
export async function subscribePageWebhook({ pageId, pageToken, attempts = SUBSCRIBE_ATTEMPTS }) {
  for (let i = 0; i < attempts; i++) {
    try {
      await graphPost(`/${encodeURIComponent(String(pageId))}/subscribed_apps?subscribed_fields=${SUBSCRIBED_FIELDS}`, pageToken);
      return { ok: true, errorCode: null };
    } catch (err) {
      if (i === attempts - 1) return { ok: false, errorCode: err?.safeCode ?? 'META_GRAPH_ERROR' };
      await new Promise((r) => setTimeout(r, SUBSCRIBE_BACKOFF_MS));
    }
  }
  return { ok: false, errorCode: 'META_GRAPH_ERROR' };
}

/* -------------------------------------------------------- status semantics */

/**
 * Truthful connection state. Never derived from token presence alone: a channel
 * is "connected" only with a credential AND a confirmed webhook subscription
 * AND an enabled channel.
 */
export function deriveConnectionState({ channelStatus, hasCredential, subscriptionState }) {
  if (channelStatus && channelStatus !== 'active') return CONNECTION_STATES.NEEDS_ATTENTION;
  if (!hasCredential) return CONNECTION_STATES.NOT_CONNECTED;
  if (subscriptionState === 'subscribed') return CONNECTION_STATES.CONNECTED;
  if (subscriptionState === 'pending_subscription') return CONNECTION_STATES.PENDING_SUBSCRIPTION;
  if (subscriptionState === 'subscription_failed') return CONNECTION_STATES.SUBSCRIPTION_FAILED;
  return CONNECTION_STATES.UNKNOWN;
}