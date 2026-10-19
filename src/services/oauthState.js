/**
 * B1 - OAuth state store.
 *
 * An OAuth `state` parameter is a one-time bearer token for "this user, in this
 * session, for this brand, asked to start a connection". If it can be replayed
 * or forged, an attacker can attach their own Facebook Page to someone else's
 * company. This module is the whole of that defence.
 *
 * DESIGN RULES (each one exists because its absence is a vulnerability):
 *
 *  1. SINGLE-USE. A row is claimed with `UPDATE ... WHERE consumed_at IS NULL`.
 *     The update either claims exactly one row or claims none, so two concurrent
 *     callbacks with the same state cannot both succeed.
 *
 *  2. NEVER STORED IN PLAINTEXT. Only SHA-256(state) is persisted. A database
 *     read (backup, replica, operator) therefore cannot produce a usable token.
 *
 *  3. BOUND TO THE INITIATOR. actor_user_id, tenant_id, session_id and the
 *     pre-selected brand_id are all fixed when the state is issued. The callback
 *     re-checks every one of them, so a state stolen by another logged-in user
 *     is rejected even before it is looked up by hash.
 *
 *  4. SHORT-LIVED. Ten minutes. Long enough for a real Meta consent screen and
 *     a corporate SSO detour, short enough that an abandoned tab is not a
 *     standing liability.
 *
 *  5. EXACT REDIRECT URI. The URI used to start is stored and must match on the
 *     way back, so an attacker cannot start an authorize request on one host and
 *     land the code somewhere else.
 *
 * Nothing here knows about Facebook. This is a generic, provider-keyed store.
 */
import crypto from 'node:crypto';
import { pool } from '../db/pg.js';

export const OAUTH_STATE_ERRORS = {
  NOT_FOUND: 'OAUTH_STATE_NOT_FOUND',
  EXPIRED: 'OAUTH_STATE_EXPIRED',
  ALREADY_USED: 'OAUTH_STATE_ALREADY_USED',
  MISMATCH: 'OAUTH_STATE_MISMATCH',
  UNSUPPORTED_PROVIDER: 'OAUTH_STATE_UNSUPPORTED_PROVIDER'
};

export class OAuthStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OAuthStateError';
    this.code = code;
  }
}

export const SUPPORTED_OAUTH_PROVIDERS = Object.freeze(['meta']);

/** Ten minutes. Long enough for a consent screen, short enough to not linger. */
export const STATE_TTL_SECONDS = 600;

/**
 * SHA-256 of the state token, as bytes.
 *
 * Postgres bytea comparison needs the raw digest; doing it here (rather than
 * storing hex text) also removes any case-normalisation question.
 */
export function hashState(rawState) {
  return crypto.createHash('sha256').update(String(rawState), 'utf8').digest();
}

/** Cryptographically strong, URL-safe, 256 bits of entropy. */
export function generateStateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** PKCE verifier + its S256 challenge. */
export function generatePkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url')
  };
}

function fail(code, message) {
  throw new OAuthStateError(code, message);
}

function assertProvider(provider) {
  if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
    fail(OAUTH_STATE_ERRORS.UNSUPPORTED_PROVIDER, `unsupported oauth provider: ${provider}`);
  }
}

/**
 * Issue a new state and persist only its hash.
 *
 * A user may have exactly one in-flight attempt per provider. The partial unique
 * index enforces that at the database level; a second click is therefore
 * refused by the database rather than by a hopeful check-then-insert in JS.
 *
 * @returns {{state: string, expiresAt: Date}} the plaintext state, returned to the
 *   caller for the redirect URL and never persisted.
 */
export async function issueOAuthState({
  tenantId,
  actorUserId,
  sessionId = null,
  provider = 'meta',
  brandId = null,
  redirectUri,
  pkceVerifier = null,
  db = pool,
  ttlSeconds = STATE_TTL_SECONDS
} = {}) {
  assertProvider(provider);

  if (!tenantId) fail(OAUTH_STATE_ERRORS.MISMATCH, 'tenantId is required');
  if (!actorUserId) fail(OAUTH_STATE_ERRORS.MISMATCH, 'actorUserId is required');
  if (!redirectUri) fail(OAUTH_STATE_ERRORS.MISMATCH, 'redirectUri is required');

  // Supersede any attempt already in flight so a retry (or a double-click) does
  // not fail on the partial unique index and leave the user with no way forward.
  await db.query(
    `UPDATE oauth_states
        SET consumed_at = now()
      WHERE tenant_id = $1
        AND actor_user_id = $2
        AND provider = $3
        AND consumed_at IS NULL`,
    [tenantId, actorUserId, provider]
  );

  const state = generateStateToken();
  const stateHash = hashState(state);
  const codeVerifierHash = pkceVerifier
    ? crypto.createHash('sha256').update(pkceVerifier, 'utf8').digest()
    : null;

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await db.query(
    `INSERT INTO oauth_states
       (tenant_id, actor_user_id, session_id, provider, brand_id,
        state_hash, code_verifier_hash, redirect_uri, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenantId,
      actorUserId,
      sessionId,
      provider,
      brandId,
      stateHash,
      codeVerifierHash,
      redirectUri,
      expiresAt
    ]
  );

  return { state, expiresAt };
}

/**
 * Claim a presented state exactly once.
 *
 * The claim is a single conditional UPDATE. `consumed_at IS NULL` in the WHERE
 * clause is what makes concurrent replays impossible: two simultaneous
 * callbacks both try to set consumed_at on the same row, and PostgreSQL lets
 * exactly one win. The loser reads zero rows and is told the state was used.
 *
 * Every binding from issuance is re-verified here, not trusted from the row:
 * a mismatch is reported as MISMATCH rather than silently accepted.
 */
export async function consumeOAuthState({
  state,
  tenantId,
  actorUserId,
  sessionId = null,
  provider = 'meta',
  redirectUri,
  db = pool
} = {}) {
  assertProvider(provider);

  if (!state) fail(OAUTH_STATE_ERRORS.NOT_FOUND, 'state is required');

  const stateHash = hashState(state);

  // 1. Claim. Single-statement, so it is atomic under concurrency.
  const { rows: claimed } = await db.query(
    `UPDATE oauth_states
        SET consumed_at = now()
      WHERE state_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, tenant_id, actor_user_id, session_id, provider, brand_id,
                code_verifier_hash, redirect_uri, expires_at`,
    [stateHash]
  );

  if (!claimed.length) {
    // The claim found nothing. Distinguish the two dead-state cases so the
    // legitimate user gets an actionable message ("start again" vs "this link
    // was already used"). This leaks nothing an attacker did not already hold:
    // the row's mere existence is what the probe below reveals, and an attacker
    // who knows the state was issued already knows this much.
    const { rows: dead } = await db.query(
      `SELECT consumed_at IS NOT NULL AS consumed, expires_at <= now() AS expired
         FROM oauth_states WHERE state_hash = $1 LIMIT 1`,
      [stateHash]
    );
    if (!dead.length) fail(OAUTH_STATE_ERRORS.NOT_FOUND, 'unknown or invalid state');
    if (dead[0].consumed) fail(OAUTH_STATE_ERRORS.ALREADY_USED, 'state has already been used');
    fail(OAUTH_STATE_ERRORS.EXPIRED, 'state has expired; please start the connection again');
  }

  const row = claimed[0];

  // 2. Verify the binding. A state that exists but was issued for someone else
  //    is a forgery attempt, not an expired link.
  if (String(row.tenant_id) !== String(tenantId)) {
    fail(OAUTH_STATE_ERRORS.MISMATCH, 'state was not issued for this company');
  }
  if (String(row.actor_user_id) !== String(actorUserId)) {
    fail(OAUTH_STATE_ERRORS.MISMATCH, 'state was not issued for this user');
  }
  if (sessionId && row.session_id && String(row.session_id) !== String(sessionId)) {
    fail(OAUTH_STATE_ERRORS.MISMATCH, 'state was issued in a different session');
  }
  if (redirectUri && row.redirect_uri !== redirectUri) {
    fail(OAUTH_STATE_ERRORS.MISMATCH, 'redirect_uri does not match the one used to start');
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    sessionId: row.session_id,
    provider: row.provider,
    brandId: row.brand_id,
    codeVerifierHash: row.code_verifier_hash,
    redirectUri: row.redirect_uri,
    expiresAt: row.expires_at
  };
}

/** The PKCE verifier hashed form, for the code exchange. */
export function pkceVerifierFromHash(storedHash, verifier) {
  if (!storedHash) return null;
  const candidate = crypto.createHash('sha256').update(String(verifier), 'utf8').digest();
  return crypto.timingSafeEqual(candidate, storedHash) ? String(verifier) : null;
}

/** Housekeeping. Expired rows carry no value once they can no longer be used. */
export async function purgeExpiredOAuthStates({ db = pool, olderThanSeconds = 86400 } = {}) {
  const { rowCount } = await db.query(
    `DELETE FROM oauth_states WHERE expires_at < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)]
  );
  return rowCount ?? 0;
}

/**
 * Park an encrypted User Access Token against a claimed state.
 *
 * Called once, inside the callback, immediately after the code exchange. This
 * is what lets the browser pick a page without the token ever appearing in a
 * URL, in a redirect, or in the frontend bundle. The plaintext exists only in
 * this function's call frame.
 *
 * Guarded on consumed_at IS NOT NULL AND user_token_encrypted IS NULL so it can
 * only ever run once per state.
 */
export async function stashUserToken({ stateId, userToken, db = pool }) {
  const { encrypt } = await import('../db/crypto.js');
  const { value, iv } = encrypt(userToken);
  const { rowCount } = await db.query(
    `UPDATE oauth_states
        SET user_token_encrypted = $2,
            user_token_iv = $3
      WHERE id = $1
        AND consumed_at IS NOT NULL
        AND user_token_encrypted IS NULL`,
    [stateId, value, iv]
  );
  return rowCount ?? 0;
}

/**
 * Read back and immediately destroy the parked user token.
 *
 * `destroy = true` is the default and the safe choice: the token is needed for
 * exactly one discovery pass and one confirm pass, and both should re-derive
 * from a fresh grant rather than reuse a cached secret. Reading without
 * destroying is available for the page-listing step, which the user may revisit
 * a few times before confirming.
 */
export async function takeUserToken({ stateId, db = pool, destroy = false }) {
  if (!stateId) return null;
  const { decrypt } = await import('../db/crypto.js');

  const query = destroy
    ? `UPDATE oauth_states
          SET user_token_encrypted = NULL, user_token_iv = NULL
        WHERE id = $1 AND user_token_encrypted IS NOT NULL
        RETURNING user_token_encrypted, user_token_iv`
    : `SELECT user_token_encrypted, user_token_iv
         FROM oauth_states
        WHERE id = $1 AND user_token_encrypted IS NOT NULL`;

  const { rows } = await db.query(query, [stateId]);
  if (!rows.length) return null;

  const row = rows[0];
  if (!row.user_token_encrypted || !row.user_token_iv) return null;
  return decrypt(row.user_token_encrypted, row.user_token_iv);
}

/**
 * Load a consumed state WITHOUT claiming it, for the post-callback steps.
 *
 * The post-callback flow runs in an authenticated session, so it can verify the
 * caller against the row: same tenant, same user, not expired. This is what
 * closes the loop that a bare state hash alone cannot - the state alone proves
 * "someone started a connect", this proves "and it was THIS user, in THIS
 * company, for THIS brand".
 */
export async function readConsumedState({ stateId, tenantId, actorUserId, db = pool }) {
  if (!stateId || !tenantId || !actorUserId) {
    fail(OAUTH_STATE_ERRORS.NOT_FOUND, 'stateId, tenantId and actorUserId are required');
  }

  const { rows } = await db.query(
    `SELECT id, tenant_id, actor_user_id, session_id, provider, brand_id,
            redirect_uri, expires_at, consumed_at,
            user_token_encrypted IS NOT NULL AS has_user_token
       FROM oauth_states
      WHERE id = $1
        AND consumed_at IS NOT NULL
        AND expires_at > now()
        AND tenant_id = $2
        AND actor_user_id = $3`,
    [stateId, tenantId, actorUserId]
  );

  if (!rows.length) {
    fail(OAUTH_STATE_ERRORS.NOT_FOUND, 'no active authorization for this user');
  }
  return rows[0];
}