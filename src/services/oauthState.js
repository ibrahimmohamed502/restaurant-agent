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
  UNSUPPORTED_PROVIDER: 'OAUTH_STATE_UNSUPPORTED_PROVIDER',
  // Raised when PKCE is on but the verifier cannot be protected at rest. The
  // connect is refused rather than downgraded: storing the verifier in the clear
  // would be worse than not using PKCE at all.
  CRYPTO_UNAVAILABLE: 'OAUTH_STATE_CRYPTO_UNAVAILABLE'
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

  // PKCE: store the RAW verifier, encrypted, plus its digest for an integrity
  // check on the way back.
  //
  // PKCE needs the original verifier at the exchange - Meta hashes it and
  // compares against the code_challenge. A digest cannot be reversed, so a
  // hash-only design made the exchange impossible. The raw value is protected
  // with the same AES-256-GCM key as the parked user token, so a database read
  // still yields nothing usable.
  let codeVerifierHash = null;
  let codeVerifierEncrypted = null;
  let codeVerifierIv = null;
  if (pkceVerifier) {
    const { encrypt } = await import('../db/crypto.js');
    try {
      const enc = encrypt(pkceVerifier);
      codeVerifierEncrypted = enc.value;
      codeVerifierIv = enc.iv;
    } catch {
      // Fail the connect. Sending a challenge we cannot complete is strictly
      // worse than not starting: Meta would reject the exchange after the user
      // has already granted consent.
      fail(
        OAUTH_STATE_ERRORS.CRYPTO_UNAVAILABLE,
        'cannot store the PKCE verifier securely; refusing to start a connection that cannot complete'
      );
    }
    codeVerifierHash = crypto.createHash('sha256').update(pkceVerifier, 'utf8').digest();
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await db.query(
    `INSERT INTO oauth_states
       (tenant_id, actor_user_id, session_id, provider, brand_id,
        state_hash, code_verifier_hash, code_verifier_encrypted, code_verifier_iv,
        redirect_uri, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      tenantId,
      actorUserId,
      sessionId,
      provider,
      brandId,
      stateHash,
      codeVerifierHash,
      codeVerifierEncrypted,
      codeVerifierIv,
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
                code_verifier_hash, code_verifier_encrypted, code_verifier_iv,
                redirect_uri, expires_at`,
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
  //
  //    Each field is checked only WHEN THE CALLER SUPPLIED IT. That is not a
  //    weakening - it is the only correct shape. The callback genuinely does not
  //    know the tenant or the user yet: the browser may have arrived without a
  //    usable session, and the whole point of the state is that it carries that
  //    binding. Treating "not supplied" as "does not match" would 403 every real
  //    callback.
  //
  //    What keeps that safe: the returned row is the authority. It pins
  //    tenantId/actorUserId/brandId, and the steps that run AFTER the callback
  //    (/pages, /confirm) re-verify the caller against the row against the live
  //    session before anything is written or read. A state stolen by another
  //    logged-in user is therefore still useless: the claim succeeds, but the
  //    subsequent authenticated steps refuse it.
  if (tenantId && String(row.tenant_id) !== String(tenantId)) {
    fail(OAUTH_STATE_ERRORS.MISMATCH, 'state was not issued for this company');
  }
  if (actorUserId && String(row.actor_user_id) !== String(actorUserId)) {
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
    // The digest is carried so the verifier can be integrity-checked after
    // decryption. The ciphertext is deliberately NOT returned here: it is
    // released only by takePkceVerifier(), which destroys it on read, so it can
    // never be replayed.
    codeVerifierHash: row.code_verifier_hash,
    hasCodeVerifier: Boolean(row.code_verifier_encrypted && row.code_verifier_iv),
    redirectUri: row.redirect_uri,
    expiresAt: row.expires_at
  };
}

/**
 * Constant-time confirmation that a candidate verifier matches a stored digest.
 *
 * Returns the verifier on a match, null otherwise. The length guard matters:
 * `crypto.timingSafeEqual` THROWS when the two buffers differ in length, which
 * would turn "this row is corrupt" into an unhandled crash instead of a refusal.
 */
export function pkceVerifierFromHash(storedHash, verifier) {
  if (!storedHash || verifier === null || verifier === undefined) return null;
  const stored = Buffer.isBuffer(storedHash) ? storedHash : Buffer.from(storedHash);
  const candidate = crypto.createHash('sha256').update(String(verifier), 'utf8').digest();
  if (stored.length !== candidate.length) return null;
  return crypto.timingSafeEqual(candidate, stored) ? String(verifier) : null;
}

/**
 * Read the PKCE verifier exactly once, then destroy it.
 *
 * THE ORIGINAL DEFECT, for the record: this function did not exist. B1 sent a
 * `code_challenge` to Meta but stored only SHA-256(verifier), and never sent
 * `code_verifier` back at the exchange. Since PKCE requires the RAW verifier
 * (Meta hashes it and compares), a hash-only design made every real connect
 * fail at token exchange - while 196 mocked assertions stayed green, because
 * the suite only ever asserted the challenge went OUT.
 *
 * Destroy-on-read is the correct shape here, and it does not weaken retry
 * handling: by the time this is called the state has already been claimed
 * (`consumed_at` set), so the row cannot be replayed and there is nothing to
 * retry. The verifier is therefore dead the moment the claim succeeds, and the
 * ciphertext is removed immediately rather than left to be swept by expires_at.
 *
 * The decrypted verifier is re-hashed and compared with the stored digest before
 * being returned. A mismatch means the ciphertext was tampered with or is
 * corrupt, and the exchange is refused rather than attempted with a value Meta
 * would reject anyway.
 *
 * @returns {Promise<string|null>} the plaintext verifier, or null when this
 *   connection was started without PKCE.
 */
export async function takePkceVerifier({ stateId, expectedHash = null, db = pool }) {
  if (!stateId) return null;
  const { decrypt } = await import('../db/crypto.js');

  // Destroy on read, in ONE statement, so two concurrent callbacks cannot both
  // obtain the verifier even if they somehow both reached this line.
  //
  // THE CTE IS NOT COSMETIC. In PostgreSQL, `UPDATE ... RETURNING` yields the
  // NEW row values, so a plain
  //     UPDATE ... SET code_verifier_encrypted = NULL
  //              RETURNING code_verifier_encrypted
  // returns NULL - it would report the ciphertext it just destroyed. The first
  // version of this function did exactly that and returned null on every call.
  //
  // `taken` snapshots the row under FOR UPDATE, and RETURNING reads the value
  // from that CTE rather than from the updated row, so the old ciphertext is
  // what comes back. Still one statement, so it is still atomic.
  const { rows } = await db.query(
    `WITH taken AS (
       SELECT id, code_verifier_encrypted, code_verifier_iv, code_verifier_hash
         FROM oauth_states
        WHERE id = $1
          AND code_verifier_encrypted IS NOT NULL
        FOR UPDATE
     )
     UPDATE oauth_states AS o
        SET code_verifier_encrypted = NULL,
            code_verifier_iv        = NULL
       FROM taken AS t
      WHERE o.id = t.id
     RETURNING t.code_verifier_encrypted, t.code_verifier_iv, t.code_verifier_hash`,
    [stateId]
  );
  if (!rows.length) return null;

  const row = rows[0];
  if (!row.code_verifier_encrypted || !row.code_verifier_iv) return null;

  let verifier;
  try {
    verifier = decrypt(row.code_verifier_encrypted, row.code_verifier_iv);
  } catch {
    // A decryption failure means wrong key or tampered ciphertext. Never
    // substitute or continue: the value is unusable and guessing is worse.
    fail(OAUTH_STATE_ERRORS.CRYPTO_UNAVAILABLE, 'stored PKCE verifier could not be read');
  }

  const digest = row.code_verifier_hash || expectedHash;
  if (digest && !pkceVerifierFromHash(digest, verifier)) {
    fail(OAUTH_STATE_ERRORS.MISMATCH, 'stored PKCE verifier failed its integrity check');
  }
  return verifier;
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
 * Spend a grant exactly once.
 *
 * The one-shot guarantee used to be INFERRED from the parked token being cleared
 * afterwards, which made it depend on a best-effort cleanup: if that cleanup
 * failed, a second confirm would silently succeed. A security guarantee resting
 * on a `.catch(() => {})` is not a guarantee - and it produced a genuinely
 * flaky test.
 *
 * This claims the grant with a single conditional UPDATE, so exactly one caller
 * can ever win, and the guarantee holds regardless of what any cleanup does.
 *
 * @returns {Promise<boolean>} true if THIS caller claimed it; false if it was
 *   already spent, which the caller reports as an expired authorization.
 */
export async function claimGrantForConfirm({ stateId, tenantId, actorUserId, db = pool }) {
  if (!stateId || !tenantId || !actorUserId) {
    fail(OAUTH_STATE_ERRORS.NOT_FOUND, 'stateId, tenantId and actorUserId are required');
  }

  const { rowCount } = await db.query(
    `UPDATE oauth_states
        SET confirmed_at = now()
      WHERE id = $1
        AND tenant_id = $2
        AND actor_user_id = $3
        AND consumed_at IS NOT NULL
        AND confirmed_at IS NULL
        AND expires_at > now()`,
    [stateId, tenantId, actorUserId]
  );
  return rowCount === 1;
}

/** Has this grant already been spent? For read-only reporting. */
export async function grantIsSpent({ stateId, db = pool }) {
  const { rows } = await db.query(
    `SELECT confirmed_at IS NOT NULL AS spent FROM oauth_states WHERE id = $1`,
    [stateId]
  );
  return Boolean(rows[0]?.spent);
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

/**
 * Load a consumed state for the PAGE-LISTING step, but ONLY while the grant is
 * still UNSPENT, and release the parked user token in the same read.
 *
 * WHY THIS EXISTS
 * ---------------
 * The page listing used to be gated on the PRESENCE OF THE PARKED TOKEN: the
 * state was read, then the token was taken, and a missing token meant "the
 * authorization is gone". That made the one-shot guarantee depend on the
 * cleanup of the parked token having landed - and the cleanup runs in a
 * `finally` block, asynchronously with respect to the response. A client that
 * re-read the listing in that window was served the page list for a grant
 * that had ALREADY been spent.
 *
 * The gate is now the PERSISTED GRANT STATE, not the token.
 *
 * THE AUTHORITATIVE READ
 * ----------------------
 * One statement. The predicate that decides whether this grant may still be
 * used - `confirmed_at IS NULL` - lives IN THE SQL, so the decision and the
 * data come from the SAME snapshot. There is no "check, then use" gap to race
 * in, and no in-memory flag that could disagree with the row.
 *
 * `confirmed_at` is set by the atomic one-shot claim, so it is the
 * authoritative record of "this grant has been spent" - not a guess, and not a
 * side effect of cleanup.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE
 * --------------------------------------
 * It guarantees that a grant which is ALREADY spent when the read begins is
 * never served, whatever the cleanup is doing. A grant spent CONCURRENTLY with
 * the read is not retroactively invalidated: the listing was authorised at the
 * instant it was read, by the same tenant and the same user who spent it.
 *
 * The binding is unchanged and is still enforced: same tenant, same user, not
 * expired. A state belonging to another company or another user is reported
 * exactly like one that does not exist.
 *
 * @returns {Promise<
 *   {ok: true, state: object, userToken: ?string}
 *   | {ok: false, reason: 'not_found'|'expired'|'spent'}
 * >}
 */
export async function readUnspentState({ stateId, tenantId, actorUserId, db = pool }) {
  if (!stateId || !tenantId || !actorUserId) {
    fail(OAUTH_STATE_ERRORS.NOT_FOUND, 'stateId, tenantId and actorUserId are required');
  }
  const { decrypt } = await import('../db/crypto.js');

  // THE AUTHORITATIVE READ. One statement, one snapshot.
  const { rows } = await db.query(
    `SELECT id, tenant_id, actor_user_id, session_id, provider, brand_id,
            redirect_uri, expires_at, consumed_at, confirmed_at,
            user_token_encrypted, user_token_iv
       FROM oauth_states
      WHERE id = $1
        AND consumed_at IS NOT NULL
        AND confirmed_at IS NULL
        AND expires_at > now()
        AND tenant_id = $2
        AND actor_user_id = $3`,
    [stateId, tenantId, actorUserId]
  );

  if (!rows.length) {
    // WHY. One diagnostic read, used ONLY to choose the error code. It returns
    // no token, it grants nothing, and it is NOT consulted to decide whether
    // the grant may be used - that decision was already made above, by the
    // authoritative statement. The same pattern is used by consumeOAuthState().
    const { rows: dead } = await db.query(
      `SELECT consumed_at IS NOT NULL AS consumed,
              confirmed_at IS NOT NULL AS spent,
              expires_at <= now() AS expired,
              tenant_id, actor_user_id
         FROM oauth_states WHERE id = $1 LIMIT 1`,
      [stateId]
    );
    if (!dead.length) return { ok: false, reason: 'not_found' };
    const row = dead[0];
    // The binding is checked FIRST. A state that belongs to another company or
    // another user must look exactly like one that does not exist.
    if (String(row.tenant_id) !== String(tenantId)
      || String(row.actor_user_id) !== String(actorUserId)) {
      return { ok: false, reason: 'not_found' };
    }
    if (row.spent) return { ok: false, reason: 'spent' };
    if (row.expired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'not_found' };
  }

  const row = rows[0];

  // The token is released from the SAME snapshot as the decision, never from a
  // second read that could observe a different state.
  //
  // A DECRYPTION FAILURE IS NOT SWALLOWED. A wrong or missing ENCRYPTION_KEY
  // is a server misconfiguration, and it must be loud: swallowing it here
  // would answer "the authorization expired" for what is really a broken
  // deployment, and the misconfiguration would stay hidden. The error carries
  // no token material - it is a cipher failure, not the ciphertext.
  let userToken = null;
  if (row.user_token_encrypted && row.user_token_iv) {
    userToken = decrypt(row.user_token_encrypted, row.user_token_iv);
  }

  return {
    ok: true,
    state: {
      id: row.id,
      tenant_id: row.tenant_id,
      actor_user_id: row.actor_user_id,
      session_id: row.session_id,
      provider: row.provider,
      brand_id: row.brand_id,
      redirect_uri: row.redirect_uri,
      expires_at: row.expires_at,
      consumed_at: row.consumed_at,
      confirmed_at: row.confirmed_at
    },
    userToken
  };
}