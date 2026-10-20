/**
 * B1 - Facebook Page connection service.
 *
 * Owns the lifecycle of a Facebook Page <-> Brand connection: connect, reconnect,
 * disconnect, and listing. Deliberately knows nothing about HTTP or Express.
 *
 * INVARIANTS ENFORCED HERE (server-side; the UI is not a boundary):
 *
 *  1. TENANT + BRAND ISOLATION. Every read and write is scoped by tenantId, and
 *     the brand must be inside the caller's authorised brand scope. A brand
 *     outside the scope is treated as not existing, so this service cannot be
 *     used to probe for other companies' brands.
 *
 *  2. ONE PAGE, ONE OWNER. `channels_meta_tenant_owner_uidx` (migration 023)
 *     plus the pre-existing global index mean a Page cannot be attached to two
 *     tenants. A conflict is reported as a conflict, never resolved by silently
 *     taking the page away from its existing owner.
 *
 *  3. TOKENS ARE STORED ENCRYPTED, ONCE, AND NEVER RETURNED. The existing
 *     AES-256-GCM helper is reused. Reads report presence and expiry only.
 *
 *  4. EVERY MUTATION IS AUDITED, INCLUDING FAILURES. A refused connect is a
 *     security event worth recording, not just a successful one.
 *
 *  5. NO PARTIAL STATE. The channel row, its credential and its audit event are
 *     written in one transaction. A failure leaves nothing half-connected.
 */
import { encrypt } from '../db/crypto.js';
import { brandIsAccessible, BRAND_SCOPE_TENANT } from '../api/v1/brandAccess.js';
import {
  discoverPages,
  assessPagePermissions,
  inspectToken,
  B1_SCOPES,
  META_OAUTH_ERRORS,
  MetaOAuthError
} from '../providers/meta/oauth.js';

export const CONNECTION_ERRORS = {
  BRAND_NOT_ACCESSIBLE: 'BRAND_NOT_ACCESSIBLE',
  BRAND_REQUIRED: 'BRAND_REQUIRED',
  PAGE_NOT_IN_ACCOUNT: 'PAGE_NOT_IN_ACCOUNT',
  PAGE_NOT_CONNECTABLE: 'PAGE_NOT_CONNECTABLE',
  PAGE_OWNED_BY_ANOTHER_TENANT: 'PAGE_OWNED_BY_ANOTHER_TENANT',
  PAGE_ALREADY_CONNECTED: 'PAGE_ALREADY_CONNECTED',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  UPSTREAM_ERROR: 'CONNECTION_UPSTREAM_ERROR',
  // A disconnect was refused because the channel still carries a legacy
  // credential that the live Messenger/Comments path depends on.
  LEGACY_CREDENTIAL_PRESENT: 'CONNECTION_LEGACY_CREDENTIAL_PRESENT',
  // The stored token failed inspection: invalid, expired, wrong app, wrong
  // type, or bound to a different Page.
  TOKEN_REJECTED: 'CONNECTION_TOKEN_REJECTED'
};

/**
 * The credential kinds this service writes.
 *
 * `page_access_token`        - the LEGACY kind. The live Messenger/Comments
 *                              resolver reads exactly this kind. It is NEVER
 *                              written, replaced or deleted by the OAuth path.
 * `page_access_token_oauth`  - the kind OAuth-obtained tokens are stored under.
 *                              The live resolver does not read it, so connecting
 *                              a Page can never silently switch the running
 *                              integration onto a different token.
 *
 * Storing under a distinct kind is what makes the OAuth path non-destructive:
 * the legacy credential is not deleted, not modified, and not re-pointed.
 */
export const CREDENTIAL_KIND_LEGACY = 'page_access_token';
export const CREDENTIAL_KIND_OAUTH = 'page_access_token_oauth';

/**
 * How a credential that Meta confirmed NEVER expires is stored.
 *
 * WHY A FAR-FUTURE DATE AND NOT NULL
 * ----------------------------------
 * `provider_credentials.expires_at` is a nullable timestamptz, so it can carry
 * two different facts only if one of them is encoded:
 *
 *   NULL            -> "Meta did not state an expiry"          (UNKNOWN)
 *   this timestamp  -> "Meta stated the token never expires"   (CONFIRMED)
 *   a real date     -> "Meta stated this expiry"               (CONFIRMED)
 *
 * Collapsing the second into the first is what made a freshly connected,
 * perfectly working Page display "needs reconnect" immediately: Meta reports
 * `expires_at: 0` for a non-expiring Page token, `0` was treated as "no
 * information", and the unknown-expiry rule then correctly - but uselessly -
 * asked for a reconnect.
 *
 * The sentinel is a valid timestamptz (PostgreSQL accepts year 9999) and is
 * recognised explicitly on read, so the year 9999 never reaches the API or the
 * UI as a date.
 */
export const CREDENTIAL_NEVER_EXPIRES_AT = new Date('9999-12-31T23:59:59.000Z');
const NEVER_EXPIRES_MS = CREDENTIAL_NEVER_EXPIRES_AT.getTime();

/**
 * The expiry to STORE, from an inspection result.
 *
 * THREE STATES IN, THREE STATES OUT
 * ---------------------------------
 *   expiresAt > 0     -> the real expiry
 *   expiresAt === 0   -> Meta stated "never expires" -> the sentinel
 *   expiresAt == null -> Meta said nothing            -> NULL (unknown)
 *   no inspection     -> NULL (unknown); never a guess
 *
 * @param {?{expiresAt:?number}} inspection
 * @returns {?Date}
 */
export function expiryFromInspection(inspection) {
  if (!inspection) return null;
  const expiresAt = inspection.expiresAt;
  if (expiresAt === null || expiresAt === undefined) return null;
  if (expiresAt === 0) return CREDENTIAL_NEVER_EXPIRES_AT;
  if (!Number.isFinite(expiresAt)) return null;
  const date = new Date(expiresAt * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The scopes Meta CONFIRMED for a token.
 *
 * A scope list Meta did not return is UNKNOWN, not empty. An empty list is a
 * fact ("this token carries no scopes"); an absent one is silence. Only the
 * fact may be presented as confirmed, so the two are kept apart here and the
 * caller decides how to present the unknown case.
 *
 * @param {?string[]} granted  the scopes Meta returned, or null when it returned none
 * @returns {{verified: boolean, scopes: ?string[]}}
 */
export function assessGrantedScopes({ granted = null } = {}) {
  if (!Array.isArray(granted)) {
    return { verified: false, scopes: null };
  }
  return { verified: true, scopes: granted.map(String) };
}

/**
 * THE connection-status rule. One function, one place, used by the API and
 * consumed by the UI.
 *
 * WHY IT IS A FUNCTION AND NOT AN INLINE EXPRESSION
 * -----------------------------------------------
 * The status was previously derived in three places - the page phase, the
 * connected-count badge and the per-row indicator - and they disagreed: a Page
 * with a healthy legacy credential and an EXPIRED OAuth token was reported as
 * connected by the badge while the page said "needs reconnect". One rule, one
 * owner, no re-derivation downstream.
 *
 * THE RULE
 *   oauthConnected        the channel claims an OAuth connection
 *                         (oauth_connected_at is set)
 *   oauthHealthy          connected AND the credential is provably valid
 *   oauthRequiresReconnect  connected, but the credential is missing, expired
 *                         or of unknown validity
 *   connectionHealthy     the same as oauthHealthy - the state of the OAuth
 *                         connection this page is about
 *
 * A channel that was NEVER OAuth-connected is neither healthy nor "needs
 * reconnect": there is nothing to reconnect. And a legacy credential NEVER
 * makes an expired OAuth token look healthy - the two are independent.
 *
 * @param {object} args
 * @param {boolean} args.oauthConnected  the channel claims an OAuth connection
 * @param {boolean} args.oauthPresent    an OAuth credential row exists
 * @param {Date|string|null} args.expiresAt  the observed expiry, or null
 * @param {number|Date} [args.now]      reference time, injectable for tests
 */
export function assessConnectionStatus({
  oauthConnected = false,
  oauthPresent = false,
  expiresAt = null,
  now = Date.now()
} = {}) {
  const credential = assessCredentialState({ present: oauthPresent, expiresAt, now });
  const connected = Boolean(oauthConnected);
  const healthy = connected && oauthPresent && !credential.requiresReconnect;
  return {
    oauthConnected: connected,
    oauthHealthy: healthy,
    oauthRequiresReconnect: connected && !healthy,
    connectionHealthy: healthy,
    oauthCredentialExpired: credential.expired,
    oauthCredentialExpiryUnknown: credential.expiryUnknown,
    // Meta stated the token never expires. That is a CONFIRMED state, and it
    // is what stops a healthy, non-expiring Page from asking for a reconnect.
    oauthCredentialNeverExpires: credential.neverExpires
  };
}

/**
 * Assess a stored credential: is it PRESENT, and can we say it is still valid?
 *
 * WHY THIS IS A SEPARATE, PURE FUNCTION
 * -------------------------------------
 * "A credential row exists" and "this credential still works" are different
 * facts. Reporting the first as the second is how an expired token ends up
 * displayed as a healthy connection: the row is still there, the channel is
 * still active, and nothing in the UI can tell the difference - until a Graph
 * call fails deep inside a reply.
 *
 * THREE STATES, NOT TWO
 * ---------------------
 *   present + expiry known + in the future -> healthy
 *   present + expiry known + in the past   -> EXPIRED, requires reconnect
 *   present + expiry UNKNOWN               -> NOT provably valid
 *   present + expiry stated as "never"     -> healthy, and CONFIRMED not to expire
 *
 * An unknown expiry is NOT treated as validity. We cannot assert that a
 * credential works when we do not know when it stops working. This is a
 * deliberately conservative reading: it can produce a false "needs reconnect",
 * which is safe and actionable. The opposite error - calling a dead credential
 * healthy - is the one that must never happen.
 *
 * The fourth case is separate because it is a FACT, not an absence: Meta said
 * the token never expires. Treating that as "unknown" would ask for a
 * reconnect on every single healthy, non-expiring connection.
 *
 * @param {object}  args
 * @param {boolean} args.present      a credential row exists
 * @param {Date|string|null} args.expiresAt  the observed expiry, or null if unknown
 * @param {number|Date} [args.now]    reference time, injectable for tests
 */
export function assessCredentialState({ present = false, expiresAt = null, now = Date.now() } = {}) {
  if (!present) {
    return {
      present: false,
      expired: false,
      expiryUnknown: true,
      neverExpires: false,
      healthy: false,
      requiresReconnect: true
    };
  }
  if (expiresAt === null || expiresAt === undefined) {
    return {
      present: true,
      expired: false,
      expiryUnknown: true,
      neverExpires: false,
      // Unknown is not validity.
      healthy: false,
      requiresReconnect: true
    };
  }
  const at = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  // Meta CONFIRMED this token never expires. A positive statement, not missing
  // information: healthy, expired is false, and no reconnect is requested.
  if (at === NEVER_EXPIRES_MS) {
    return {
      present: true,
      expired: false,
      expiryUnknown: false,
      neverExpires: true,
      healthy: true,
      requiresReconnect: false
    };
  }
  const expired = Number.isFinite(at) && at <= new Date(now).getTime();
  return {
    present: true,
    expired,
    expiryUnknown: false,
    neverExpires: false,
    healthy: !expired,
    requiresReconnect: expired
  };
}

/**
 * Assess a LEGACY credential.
 *
 * WHY THIS IS NOT THE OAUTH RULE
 * -------------------------------
 * The OAuth credential is judged strictly: an unknown expiry means "not
 * provably valid", because B1 wrote that credential itself and knows exactly
 * when it was issued and for how long.
 *
 * A legacy credential is a different animal. It was provisioned OUTSIDE B1, it
 * has been serving the live Messenger/Comments integration for as long as
 * that integration has existed, and Meta has normally stated NO expiry for it
 * at all. Judging it by the OAuth rule would report a WORKING production
 * integration as "not healthy" on every single page load - a false alarm about
 * a live system.
 *
 * WHAT `healthy` MEANS HERE - AND WHAT IT DOES NOT MEAN
 * ------------------------------------------------------
 * "The credential is present and is not KNOWN to have expired." That is a
 * COMPATIBILITY state, not a statement about live connectivity.
 *
 * It is NOT a proof that the integration currently answers. Nothing in this
 * function has spoken to Meta, and nothing here can. A caller that needs a
 * connectivity answer must make a real call; this field only describes the
 * credential.
 *
 * THE THREE FACTS ARE KEPT APART
 * ------------------------------
 *   present        the credential row exists
 *   expired        a VALID expiry is known AND it has passed
 *   expiryUnknown  the credential exists but Meta stated no expiry
 *
 * The unknown case is PRESERVED, not hidden. A caller can always tell "we do
 * not know the expiry" apart from "the expiry passed", and neither is ever
 * silently rewritten into the other.
 *
 * @param {object}  args
 * @param {boolean} args.present      a credential row exists
 * @param {Date|string|null} args.expiresAt  the observed expiry, or null if unknown
 * @param {number|Date} [args.now]    reference time, injectable for tests
 */
export function assessLegacyCredentialState({ present = false, expiresAt = null, now = Date.now() } = {}) {
  if (!present) {
    return {
      // The credential does not exist. There is no expiry question to be
      // uncertain about, so this is NOT reported as "expiry unknown".
      present: false,
      expired: false,
      expiryUnknown: false,
      healthy: false
    };
  }
  if (expiresAt === null || expiresAt === undefined) {
    return {
      present: true,
      // Not known to be expired - and that is the whole point.
      expired: false,
      // Meta stated no expiry. PRESERVED, not hidden.
      expiryUnknown: true,
      // Present and not known expired. A compatibility state, NOT a
      // connectivity proof.
      healthy: true
    };
  }
  const at = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  const expired = Number.isFinite(at) && at <= new Date(now).getTime();
  return {
    present: true,
    expired,
    expiryUnknown: false,
    healthy: !expired
  };
}

export class ConnectionError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = null) {
  throw new ConnectionError(code, message, detail);
}

/**
 * Verify the brand belongs to the tenant AND is inside the caller's scope.
 *
 * `scope` comes from brandScopeFromSession() upstream and is fail-closed: a
 * caller with no brand grants resolves to zero brands, so this returns false for
 * them without any special case here.
 */
async function assertBrandUsable({ db, tenantId, brandId, scope }) {
  if (!brandId) fail(CONNECTION_ERRORS.BRAND_REQUIRED, 'brandId is required');
  const ok = await brandIsAccessible({ db, tenantId, brandId, scope });
  if (!ok) {
    // Same message whether the brand is missing or merely out of scope: an
    // existence oracle is itself a leak.
    fail(CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE, 'brand is not available to this user');
  }
}

/**
 * EVERY channel row that describes this Page, across all providers.
 *
 * WHY NOT `LIMIT 1`
 * -----------------
 * A single Page can have several channel rows: a `meta` routing channel plus
 * `meta_dm` and `meta_comment` channels. Returning only ONE of them cannot
 * establish that no other row belongs to a different tenant - the row returned
 * would be whichever the planner happened to yield. A cross-tenant conflict
 * could therefore be missed, or reported, by luck.
 *
 * So this returns ALL of them and the caller examines every one. The ordering
 * is deterministic so the result is stable, but the completeness is the point.
 */
/**
 * The channel's brand must be inside the caller's brand scope.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tenant ownership alone is not sufficient. A Supervisor can hold
 * `brand.integration.disconnect` while being restricted to specific brands -
 * so a tenant-scoped delete would let them disconnect a connection belonging to a
 * brand they cannot even SEE in the (brand-scoped) connections listing. The read
 * path and the write path must apply the same rule.
 *
 * A company-wide channel (brand_id IS NULL) is visible only to a tenant-wide
 * caller, exactly as the listing treats it.
 *
 * An ABSENT scope is refused. An absent scope must never mean "everything".
 */
async function assertChannelBrandVisible({ db, tenantId, brandId, scope }) {
  if (!scope) {
    fail(CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE, 'brand is not available to this user');
  }
  if (!brandId) {
    // Company-wide channel. Only a tenant-wide caller may act on it.
    if (scope.mode === BRAND_SCOPE_TENANT) return;
    fail(CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE, 'brand is not available to this user');
  }
  const ok = await brandIsAccessible({ db, tenantId, brandId, scope });
  if (!ok) {
    fail(CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE, 'brand is not available to this user');
  }
}

async function findAllPageOwners({ db, pageId }) {
  const { rows } = await db.query(
    `SELECT tenant_id, brand_id, id, provider
       FROM channels
      WHERE external_id = $1
        AND provider IN ('meta', 'meta_dm', 'meta_comment')
      ORDER BY provider ASC, created_at ASC, id ASC`,
    [pageId]
  );
  return rows;
}

/**
 * The `meta` ROUTING channel for this Page, selected independently.
 *
 * This is the row the OAuth connect path updates. It is chosen by an explicit
 * `provider = 'meta'` predicate - never by "whichever row came back first" -
 * so a Page that also has DM and comment channels cannot have one of THOSE
 * rewritten as the routing channel.
 *
 * `lock: true` takes a row-level lock (SELECT ... FOR UPDATE) held until the
 * transaction ends. That is what serialises concurrent RECONNECTS on the same
 * channel: the second one blocks here, and when it proceeds it sees - and
 * replaces - the credential the first one wrote, so at most one current OAuth
 * credential can exist per channel. Without it, the ordering depended on the
 * incidental lock taken by a later UPDATE, which is not a guarantee.
 */
async function findMetaRoutingChannel({ db, pageId, tenantId, lock = false }) {
  const { rows } = await db.query(
    `SELECT id, tenant_id, brand_id
       FROM channels
      WHERE external_id = $1
        AND provider = 'meta'
        AND tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [pageId, tenantId]
  );
  return rows[0] || null;
}

/**
 * Discover the caller's managed Pages WITHOUT persisting anything.
 *
 * This is the "show me what I can connect" step. It is deliberately read-only:
 * an abandoned selection must leave no channel, no credential and no audit row
 * suggesting a connection happened.
 *
 * SECURITY: the result carries the per-Page access token, so it is SERVER-INTERNAL.
 * Never serialise it. The HTTP layer re-projects each entry to
 * { pageId, name, category, tasks, connectable, missingTasks } and drops the
 * token before anything reaches the browser; tests/assertions cover that.
 */
export async function listAvailablePages({ db, userAccessToken }) {
  let pages;
  try {
    pages = await discoverPages({ userAccessToken });
  } catch (e) {
    fail(CONNECTION_ERRORS.UPSTREAM_ERROR, 'could not read Facebook pages', {
      upstream: e?.code ?? null
    });
  }

  if (!pages.length) {
    fail(CONNECTION_ERRORS.UPSTREAM_ERROR, 'no Facebook pages were returned for this account', {
      upstream: META_OAUTH_ERRORS.NO_MANAGED_PAGES
    });
  }

  return pages.map((p) => {
    const assessment = assessPagePermissions(p.tasks);
    return {
      pageId: p.pageId,
      name: p.name,
      category: p.category,
      pictureUrl: p.pictureUrl,
      tasks: p.tasks,
      // Surfaced so the UI can explain WHY a page is greyed out instead of
      // letting the user pick something that will fail later.
      connectable: assessment.connectable,
      missingTasks: assessment.missingTasks,
      // SERVER-INTERNAL. Carried so connectPage() can store the credential the
      // server has already validated. The HTTP layer re-projects each entry and
      // drops this before any response is built; a regression test asserts no
      // EAA- string reaches the browser.
      pageAccessToken: p.pageAccessToken
    };
  });
}

/**
 * Connect (or reconnect) one Facebook Page to one Brand.
 *
 * @param {object}  args
 * @param {string}  args.tenantId
 * @param {string}  args.actorUserId
 * @param {string}  args.brandId        must be inside the caller's brand scope
 * @param {Array}   args.availablePages output of listAvailablePages for this grant
 * @param {string}  args.pageId         chosen by the user
 * @param {string}  args.requestedScopes the scopes B1 ASKED for - never stored as granted
 * @param {string}  args.actorIp
 * @param {string}  args.mode           'connect' | 'reconnect'
 */
export async function connectPage({
  tenantId,
  actorUserId,
  brandId,
  brandScope,
  availablePages,
  pageId,
  requestedScopes = [],
  actorIp = null,
  mode = 'connect',
  db
} = {}) {
  if (!db) throw new ConnectionError(CONNECTION_ERRORS.UPSTREAM_ERROR, 'db handle is required');
  if (!tenantId) fail(CONNECTION_ERRORS.BRAND_REQUIRED, 'tenantId is required');
  if (!pageId) fail(CONNECTION_ERRORS.PAGE_NOT_IN_ACCOUNT, 'pageId is required');

  // The page must be one we actually discovered for THIS grant. Accepting an
  // arbitrary pageId here would let a caller attach a page they never
  // authorized, which is the core of the whole feature.
  const chosen = (availablePages || []).find((p) => String(p.pageId) === String(pageId));
  if (!chosen) {
    fail(CONNECTION_ERRORS.PAGE_NOT_IN_ACCOUNT, 'that page is not among the pages you authorized');
  }

  const assessment = assessPagePermissions(chosen.tasks);
  if (!assessment.connectable) {
    fail(
      CONNECTION_ERRORS.PAGE_NOT_CONNECTABLE,
      'this page does not grant the required management permissions',
      { missingTasks: assessment.missingTasks }
    );
  }

  // Inspect the token BEFORE anything is written.
  //
  // This REJECTS a token that cannot be used for this connection: invalid,
  // expired, issued for another app, of the wrong type, or bound to a different
  // Page. `GET /debug_token` is a READ - no message is ever sent.
  //
  // It deliberately does NOT require Messenger or Comments scopes. Basic Page
  // connection must not depend on services that are activated later; those
  // scopes are checked when each capability is enabled, not here.
  let inspection = null;
  try {
    inspection = await inspectToken({
      token: chosen.pageAccessToken,
      expectedPageId: chosen.pageId
    });
  } catch (e) {
    if (e instanceof MetaOAuthError) {
      // DIAGNOSTICS: the rejection reason is recorded as ONE of our own
      // PREDEFINED codes (META_TOKEN_EXPIRED, META_TOKEN_WRONG_APP, ...).
      // It is never Meta's free text, never a token, never a secret, and
      // never the raw upstream body. Without it an operator cannot tell an
      // expired token from a wrong-app one.
      await db
        .query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
           VALUES ($1,$2,'integrations.facebook.connect.token_rejected','channel',$3,$4,$5::jsonb)`,
          [
            tenantId,
            actorUserId,
            chosen.pageId,
            actorIp,
            // The code, the page id, and nothing else.
            JSON.stringify({ reason: e.code, pageId: chosen.pageId })
          ]
        )
        .catch(() => undefined);
      fail(CONNECTION_ERRORS.TOKEN_REJECTED, e.message, {
        upstream: e.code,
        // The Page id is not secret and is needed to diagnose. The token is
        // never included.
        pageId: chosen.pageId
      });
    }
    throw e;
  }

  // The scopes Meta CONFIRMED for this token, or UNKNOWN if it did not say.
  //
  // The REQUESTED scopes are what B1 asked for. They are not evidence that
  // anything was granted, so they are never what gets stored.
  const grantedScopes = assessGrantedScopes({ granted: inspection?.scopes ?? null });

  return await runConnectTransaction({
    tenantId,
    actorUserId,
    brandId,
    brandScope,
    chosen: {
      ...chosen,
      // The OBSERVED expiry, never an assumption about token lifetime. Meta's
      // own guidance is that lifetimes are not a fixed number.
      //
      // THREE STATES, PRESERVED:
      //   a positive value  -> the real expiry
      //   0                 -> Meta stated "never expires" -> the sentinel
      //   absent            -> Meta said nothing             -> NULL (unknown)
      //
      // NULL is read back as "expiry unknown", which is reported as NOT
      // provably valid. That is deliberately conservative: it can ask for a
      // reconnect unnecessarily, which is safe, rather than call a dead token
      // healthy, which is not.
      pageTokenExpiresAt: expiryFromInspection(inspection)
    },
    requestedScopes,
    grantedScopes,
    actorIp,
    mode,
    db
  });
}

/**
 * The transaction body, kept separate so connectPage stays readable.
 */
async function runConnectTransaction({
  tenantId,
  actorUserId,
  brandId,
  brandScope,
  chosen,
  requestedScopes,
  grantedScopes,
  actorIp,
  mode,
  db
}) {
  // The scopes to STORE.
  //
  // `channels.oauth_scopes` is `jsonb NOT NULL`, so "Meta did not state the
  // scopes" cannot be a SQL NULL. It is stored as the JSON value `null`
  // instead - a non-null SQL value holding a JSON null - which is a different
  // thing from an empty array and is read back as "unknown".
  //
  // The REQUESTED scopes are deliberately NOT stored here. Writing them would
  // present a request as a grant, and the UI would then display permissions
  // the user never actually gave.
  const scopesJson = JSON.stringify(grantedScopes?.scopes ?? null);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await assertBrandUsable({
      db: client,
      tenantId,
      brandId,
      scope: brandScope
    });

    // Re-check ownership inside the transaction. Checking before BEGIN leaves a
    // window in which another tenant could claim the same page first.
    //
    // EVERY matching row is examined. A Page can have several channel rows
    // (`meta`, `meta_dm`, `meta_comment`), and a cross-tenant conflict in ANY
    // of them must refuse the connect. Deciding that from a single row would
    // make the answer depend on which row the database happened to return.
    const owners = await findAllPageOwners({ db: client, pageId: chosen.pageId });
    const conflicting = owners.find((o) => String(o.tenant_id) !== String(tenantId));
    if (conflicting) {
      await client.query('ROLLBACK');
      // A refused connect is a security event, so it is recorded with the SAME
      // inline insert the success path uses. The shared fire-and-forget audit()
      // helper is deliberately not used here: this write must be inside a
      // transaction we control so it either lands or is visibly absent, rather
      // than racing an uncommitted COMMIT.
      await client
        .query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
           VALUES ($1,$2,'integrations.facebook.connect.conflict','channel',$3,$4,$5::jsonb)`,
          // Records THAT it collided, never WHO holds the page.
          [tenantId, actorUserId, chosen.pageId, actorIp, JSON.stringify({ reason: 'page_owned_by_another_tenant' })]
        )
        .catch(() => {});
      fail(
        CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT,
        'this Facebook page is already connected to another company'
      );
    }

    // The routing channel is selected INDEPENDENTLY of the ownership scan, by an
    // explicit provider='meta' predicate. It is never inferred from the row the
    // ownership scan happened to return.
    //
    // FOR UPDATE: the row lock is taken HERE and held to COMMIT, so concurrent
    // reconnects on the same channel are serialised explicitly rather than by
    // the incidental lock of a later UPDATE. The second reconnect blocks here
    // and then replaces the credential the first one wrote.
    const routing = await findMetaRoutingChannel({
      db: client,
      pageId: chosen.pageId,
      tenantId,
      lock: true
    });

    let channelId;
    if (routing) {
      // Same tenant, same routing channel: reconnect, or move to a different
      // brand of the same company.
      //
      // The pre-existing global unique index on external_id means we UPDATE the
      // row rather than inserting a second one. `channels` has no updated_at
      // column, so the connection timestamp is the only freshness marker.
      //
      // CRITICAL: the legacy credential is NOT deleted. The OAuth credential is
      // stored under its own kind, so the live Messenger/Comments resolver -
      // which reads only `page_access_token` - keeps using exactly the token it
      // uses today.
      const { rows } = await client.query(
        `UPDATE channels
            SET brand_id = $3,
                display_name = $4,
                status = 'active',
                oauth_provider = 'meta',
                oauth_connected_at = now(),
                oauth_scopes = $5::jsonb
          WHERE id = $1 AND tenant_id = $2
          RETURNING id`,
        [routing.id, tenantId, brandId, chosen.name, scopesJson]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        fail(CONNECTION_ERRORS.CHANNEL_NOT_FOUND, 'existing connection could not be updated');
      }
      channelId = rows[0].id;
    } else {
      // No routing channel for this tenant yet: a brand-new connection.
      const { rows } = await client.query(
        `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                               oauth_provider, oauth_connected_at, oauth_scopes)
         VALUES ($1,$2,'meta',$3,$4,'active','meta',now(),$5::jsonb)
         RETURNING id`,
        [tenantId, brandId, chosen.pageId, chosen.name, scopesJson]
      );
      channelId = rows[0].id;
    }

    if (!chosen.pageAccessToken) {
      await client.query('ROLLBACK');
      fail(
        CONNECTION_ERRORS.CREDENTIAL_MISSING,
        'Meta did not return a page access token for this page'
      );
    }

    // Replace ONLY a previous OAuth credential on this channel. The legacy
    // credential is never touched, so:
    //   - token accumulation is bounded (one OAuth credential per channel),
    //   - a stale OAuth token can never be selected ahead of the current one,
    //   - the working legacy credential survives every reconnect untouched.
    await client.query(
      `DELETE FROM provider_credentials
        WHERE channel_id = $1
          AND tenant_id = $2
          AND kind = $3`,
      [channelId, tenantId, CREDENTIAL_KIND_OAUTH]
    );

    const { value, iv } = encrypt(chosen.pageAccessToken);
    await client.query(
      `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, expires_at, last_rotated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [
        tenantId,
        channelId,
        CREDENTIAL_KIND_OAUTH,
        value,
        iv,
        // The OBSERVED expiry, or NULL when Meta stated none. Meta's own
        // guidance is that token lifetimes are not a fixed number, so this is
        // what Meta reported - never an assumption.
        chosen.pageTokenExpiresAt ? new Date(chosen.pageTokenExpiresAt) : null
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
       VALUES ($1,$2,$3,'channel',$4,$5,$6::jsonb)`,
      [
        tenantId,
        actorUserId,
        mode === 'reconnect' ? 'integrations.facebook.reconnect' : 'integrations.facebook.connect',
        chosen.pageId,
        actorIp,
        // Both facts, clearly separated: what was ASKED for, and what Meta
        // CONFIRMED. `grantedScopes` is null when Meta did not say.
        JSON.stringify({
          brandId,
          name: chosen.name,
          requestedScopes: requestedScopes ?? [],
          grantedScopes: grantedScopes?.verified ? grantedScopes.scopes : null
        })
      ]
    );

    await client.query('COMMIT');

    return { channelId, brandId, pageId: chosen.pageId, name: chosen.name, mode };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});

    // A concurrent connect of the SAME page can pass the ownership check and
    // still lose the insert to the unique index. That is the index doing its job,
    // not a server fault, so it is translated into the same conflict the caller
    // would have got from the pre-check instead of escaping as a raw 500.
    if (e?.code === '23505') {
      throw new ConnectionError(
        CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED,
        'this Facebook page is already connected',
        { pageId: chosen.pageId }
      );
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * List the caller's connections, scoped to their brands.
 *
 * Reports credential PRESENCE and expiry only. The encrypted value is never
 * selected, so there is no code path here that could leak it.
 */
export async function listConnections({ db, tenantId, brandId = null, scope }) {
  if (!db) throw new ConnectionError(CONNECTION_ERRORS.UPSTREAM_ERROR, 'db handle is required');
  if (!tenantId) fail(CONNECTION_ERRORS.BRAND_REQUIRED, 'tenantId is required');

  // The scope object is the one brandScopeFromSession() produces:
  //   { mode: 'tenant',      brandIds: null }  -> every brand in the company
  //   { mode: 'restricted',  brandIds: [...] } -> exactly those brands
  //
  // An ABSENT or unrecognised scope resolves to zero brands rather than to "all",
  // which mirrors brandAccess.js: a caller who cannot prove a grant gets nothing.
  const mode = scope?.mode;
  const granted = mode === 'tenant' ? null : (Array.isArray(scope?.brandIds) ? scope.brandIds : []);

  const params = [tenantId];
  let brandClause = '';
  if (brandId) {
    params.push(brandId);
    brandClause = `AND c.brand_id = $${params.length}`;
  }
  if (granted !== null) {
    // ANY('{}') matches nothing, so a zero-brand scope correctly returns zero rows.
    params.push(granted);
    brandClause += `AND c.brand_id = ANY($${params.length}::uuid[])`;
  }

  // The credential kinds are passed as parameters AFTER the brand-scope
  // parameters, so the brandClause placeholders (which count from $1) are not
  // disturbed by them.
  const LEGACY_KIND_PARAM = `$${params.length + 1}`;
  const OAUTH_KIND_PARAM = `$${params.length + 2}`;

  const { rows } = await db.query(
    `SELECT c.id, c.brand_id, c.external_id, c.display_name, c.status,
            c.oauth_provider, c.oauth_connected_at, c.oauth_scopes,
            b.name AS brand_name,
            -- The LEGACY credential: what the live Messenger/Comments path
            -- reads. Reported separately so the UI can tell an OAuth connection
            -- apart from a running legacy integration.
            EXISTS (SELECT 1 FROM provider_credentials pc
                     WHERE pc.channel_id = c.id AND pc.kind = ${LEGACY_KIND_PARAM}) AS legacy_credential_present,
            (SELECT MAX(pc.expires_at) FROM provider_credentials pc
              WHERE pc.channel_id = c.id AND pc.kind = ${LEGACY_KIND_PARAM}) AS legacy_credential_expires_at,
            -- The OAUTH credential this service wrote.
            EXISTS (SELECT 1 FROM provider_credentials pc
                     WHERE pc.channel_id = c.id AND pc.kind = ${OAUTH_KIND_PARAM}) AS oauth_credential_present,
            (SELECT MAX(pc.expires_at) FROM provider_credentials pc
              WHERE pc.channel_id = c.id AND pc.kind = ${OAUTH_KIND_PARAM}) AS oauth_credential_expires_at
       FROM channels c
       LEFT JOIN brands b ON b.id = c.brand_id
      WHERE c.tenant_id = $1
        AND (
          c.oauth_provider = 'meta'
          OR EXISTS (SELECT 1 FROM provider_credentials pc4
                      WHERE pc4.channel_id = c.id
                        AND pc4.kind = ${LEGACY_KIND_PARAM}
                        AND c.provider IN ('meta', 'meta_dm', 'meta_comment'))
        )
        ${brandClause}
      ORDER BY COALESCE(c.oauth_connected_at, c.created_at) DESC`,
    [...params, CREDENTIAL_KIND_LEGACY, CREDENTIAL_KIND_OAUTH]
  );

  return rows.map((r) => {
    const legacyPresent = Boolean(r.legacy_credential_present);
    const oauthPresent = Boolean(r.oauth_credential_present);

    // The two connection kinds are assessed SEPARATELY, with SEPARATE rules.
    //
    // The OAuth credential is judged strictly (an unknown expiry is not
    // validity), because B1 wrote it and knows its lifetime.
    //
    // The legacy credential is the live Messenger/Comments integration. It was
    // provisioned outside B1, Meta has normally stated no expiry for it, and
    // that has always been the working behaviour - judging it by the OAuth
    // rule would raise a false alarm about a running production integration.
    // Its state therefore comes from assessLegacyCredentialState(), which
    // keeps "present", "expired" and "expiry unknown" apart and never treats
    // an unknown expiry as a defect.
    const legacyState = assessLegacyCredentialState({
      present: legacyPresent,
      expiresAt: r.legacy_credential_expires_at ?? null
    });

    // ONE rule, computed ONCE, in the API, by a pure function. The UI
    // consumes these fields and never re-derives health.
    const status = assessConnectionStatus({
      oauthConnected: Boolean(r.oauth_connected_at),
      oauthPresent,
      expiresAt: r.oauth_credential_expires_at ?? null
    });

    // The scopes Meta CONFIRMED, or null when Meta did not say.
    //
    // An empty array is a FACT ("this token carries no scopes"). null is
    // UNKNOWN. They are reported separately and are never conflated, because a
    // request that was never confirmed must not be shown as a grant.
    const grantedScopes = Array.isArray(r.oauth_scopes) ? r.oauth_scopes.map(String) : null;

    // The "never expires" sentinel never leaves as a date. A credential Meta
    // confirmed as non-expiring reports NO expiry date and a POSITIVE flag
    // instead, so the UI can say "does not expire" rather than showing the
    // sentinel or pretending the expiry is unknown.
    const oauthExpiresAt = status.oauthCredentialNeverExpires
      ? null
      : (r.oauth_credential_expires_at ?? null);
    const legacyExpiresAt = r.legacy_credential_expires_at ?? null;

    return {
      id: r.id,
      brand: r.brand_id ? { id: r.brand_id, name: r.brand_name } : null,
      pageId: r.external_id,
      pageName: r.display_name,
      status: r.status,
      provider: r.oauth_provider,
      connectedAt: r.oauth_connected_at,
      // Back-compatible: the confirmed scopes, or an empty list when unknown.
      scopes: grantedScopes ?? [],
      // The confirmed scopes, or null when Meta did not state them.
      grantedScopes,
      // False means "Meta did not say", NOT "no scopes were granted".
      scopesVerified: grantedScopes !== null,
      // What B1 ASKED for. A request, never evidence of a grant.
      requestedScopes: [...B1_SCOPES],
      // TRUE when EITHER kind of credential is present. This is the
      // back-compatible meaning the existing UI already relies on: "this
      // connection has a token". It is the OR of the two below.
      credentialPresent: legacyPresent || oauthPresent,
      // The two states are reported SEPARATELY so the UI can distinguish
      // "connected via OAuth" from "a legacy integration is still live here".
      legacyCredentialPresent: legacyPresent,
      oauthCredentialPresent: oauthPresent,
      // Validity, kept apart from presence.
      //
      // The legacy fields describe the CREDENTIAL, not the connection's live
      // reachability:
      //   legacyCredentialPresent      the row exists
      //   legacyCredentialExpired      a VALID expiry is known and it passed
      //   legacyCredentialExpiryUnknown the row exists but Meta stated no expiry
      //   legacyCredentialHealthy      present and not KNOWN to be expired -
      //                                a compatibility state, NOT a proof that
      //                                the integration currently answers
      legacyCredentialHealthy: legacyState.healthy,
      legacyCredentialExpired: legacyState.expired,
      legacyCredentialExpiryUnknown: legacyState.expiryUnknown,
      oauthCredentialHealthy: status.oauthHealthy,
      oauthCredentialExpired: status.oauthCredentialExpired,
      oauthCredentialExpiryUnknown: status.oauthCredentialExpiryUnknown,
      // Meta confirmed the token never expires.
      oauthCredentialNeverExpires: status.oauthCredentialNeverExpires,
      // NOT OAuth-connected, but a live legacy Messenger/Comments credential
      // is still serving this Page. This is an ACTIVE integration: it must
      // never be presented as removed, and never as "needs reconnect".
      legacyOnly: !status.oauthConnected && legacyPresent,
      // THE status rule, applied once and consumed everywhere.
      //   oauthConnected        : the channel claims an OAuth connection
      //   oauthHealthy          : connected, and the credential is provably valid
      //   oauthRequiresReconnect: connected, but the credential is missing,
      //                          expired, or of unknown validity
      // A channel that was never OAuth-connected is neither healthy nor
      // "needs reconnect" - there is nothing to reconnect.
      oauthConnected: status.oauthConnected,
      oauthHealthy: status.oauthHealthy,
      oauthRequiresReconnect: status.oauthRequiresReconnect,
      // The single field the UI renders. A legacy credential NEVER makes an
      // expired OAuth token look healthy.
      connectionHealthy: status.connectionHealthy,
      // null means "Meta did not state an expiry", OR "Meta confirmed the
      // token never expires" - the `oauthCredentialNeverExpires` flag tells
      // the two apart. It is never rewritten to "never expires" silently.
      credentialExpiresAt: oauthExpiresAt ?? legacyExpiresAt ?? null,
      legacyCredentialExpiresAt: legacyExpiresAt,
      oauthCredentialExpiresAt: oauthExpiresAt
    };
  });
}

/**
 * Remove ONLY the OAuth connection from a channel.
 *
 * WHY THIS IS SEPARATE FROM THE FULL DISCONNECT
 * ---------------------------------------------
 * A channel can carry TWO independent things:
 *   - a LEGACY credential, which is what the live Messenger/Comments path
 *     reads, and
 *   - an OAUTH connection, which is what B1 manages.
 *
 * Removing the OAuth link must never take the legacy integration with it. The
 * full disconnect (disconnectPage) genuinely does remove the whole channel, so
 * on a legacy-dependent channel it is refused - correctly, because it would
 * stop a working integration.
 *
 * This function is the safe alternative: it removes the OAuth link, the OAuth
 * credential and the OAuth metadata, and leaves the legacy credential, the
 * Messenger/Comments channels and the channel's ACTIVE status completely alone.
 *
 * The channel is disabled ONLY when there is no legacy credential left to
 * serve it.
 */
export async function disconnectOAuthConnection({ tenantId, actorUserId, channelId, scope = null, actorIp = null, db = pool }) {
  if (!db) throw new ConnectionError(CONNECTION_ERRORS.UPSTREAM_ERROR, 'db handle is required');
  if (!tenantId) fail(CONNECTION_ERRORS.BRAND_REQUIRED, 'tenantId is required');
  if (!channelId) fail(CONNECTION_ERRORS.CHANNEL_NOT_FOUND, 'channelId is required');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // `provider = 'meta'` is REQUIRED here, not cosmetic.
    //
    // Without it, a caller who learned a `meta_dm` or `meta_comment` channel
    // id could point the OAuth disconnect at a Messenger or a Comments
    // channel - rows this feature does not own and must never touch. A row
    // that is not a `meta` routing channel is simply NOT FOUND, so the call
    // fails closed with 404 instead of reaching a live integration.
    //
    // The tenant predicate and the row lock are unchanged: the brand check
    // that follows reads the brand under the SAME lock.
    const { rows: found } = await client.query(
      `SELECT id, external_id, brand_id FROM channels
        WHERE id = $1 AND tenant_id = $2 AND provider = 'meta' FOR UPDATE`,
      [channelId, tenantId]
    );
    if (!found.length) {
      await client.query('ROLLBACK');
      fail(CONNECTION_ERRORS.CHANNEL_NOT_FOUND, 'connection not found');
    }
    const pageId = found[0].external_id;

    // The brand is read under the SAME lock, and checked BEFORE any mutation.
    // A restricted caller must not be able to disconnect another brand's
    // connection inside their own tenant.
    await assertChannelBrandVisible({
      db: client,
      tenantId,
      brandId: found[0].brand_id,
      scope
    });

    // Does a legacy credential still serve this channel? If so the channel
    // must stay ACTIVE - disabling it would stop a working integration.
    const { rows: legacyRows } = await client.query(
      `SELECT count(*)::int n
         FROM provider_credentials
        WHERE channel_id = $1
          AND tenant_id = $2
          AND kind = $3`,
      [channelId, tenantId, CREDENTIAL_KIND_LEGACY]
    );
    const hasLegacy = (legacyRows[0]?.n ?? 0) > 0;

    // Only the OAuth credential is removed. A legacy row is not touched.
    await client.query(
      `DELETE FROM provider_credentials
        WHERE channel_id = $1
          AND tenant_id = $2
          AND kind = $3`,
      [channelId, tenantId, CREDENTIAL_KIND_OAUTH]
    );

    // The OAuth connection metadata is cleared COMPLETELY, so no stale scope or
    // timestamp survives a disconnect. The channel status is left alone when a
    // legacy credential still serves it.
    await client.query(
      `UPDATE channels
          SET oauth_provider = NULL,
              oauth_connected_at = NULL,
              oauth_scopes = '[]'::jsonb,
              status = CASE WHEN $3::boolean THEN status ELSE 'disabled' END
        WHERE id = $1 AND tenant_id = $2`,
      [channelId, tenantId, hasLegacy]
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
       VALUES ($1,$2,'integrations.facebook.disconnect.oauth','channel',$3,$4,$5::jsonb)`,
      [tenantId, actorUserId, pageId, actorIp, JSON.stringify({
        channelId,
        scope: 'oauth',
        // Records WHAT was preserved, so the audit explains the decision.
        legacyCredentialPreserved: hasLegacy
      })]
    );

    await client.query('COMMIT');
    return { channelId, pageId, scope: 'oauth', legacyCredentialPreserved: hasLegacy };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Disconnect a Page.
 *
 * The channel row is kept (webhook routing, conversation history and audit all
 * reference it) but is deactivated and stripped of its credential. A hard delete
 * would cascade through conversations and destroy history that has no reason to
 * be destroyed because someone unlinked a page.
 */
export async function disconnectPage({ db, tenantId, actorUserId, channelId, scope = null, actorIp = null }) {
  if (!db) throw new ConnectionError(CONNECTION_ERRORS.UPSTREAM_ERROR, 'db handle is required');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // tenant_id in the WHERE clause is the isolation boundary.
    //
    // `provider = 'meta'` is REQUIRED here for the same reason as in the
    // OAuth-only path: a full disconnect must not be pointable at a
    // `meta_dm` or `meta_comment` channel. Such a row is NOT FOUND and the
    // call fails closed with 404.
    const { rows: found } = await client.query(
      `SELECT id, external_id, brand_id FROM channels
        WHERE id = $1 AND tenant_id = $2 AND provider = 'meta' FOR UPDATE`,
      [channelId, tenantId]
    );
    if (!found.length) {
      await client.query('ROLLBACK');
      fail(CONNECTION_ERRORS.CHANNEL_NOT_FOUND, 'connection not found');
    }
    const pageId = found[0].external_id;

    // Same brand gate as the OAuth-only path. A full disconnect removes more,
    // so it must be at least as strictly authorised.
    await assertChannelBrandVisible({
      db: client,
      tenantId,
      brandId: found[0].brand_id,
      scope
    });

    await client.query(
      `UPDATE channels
          SET status = 'disabled',
              oauth_connected_at = NULL,
              oauth_provider = NULL,
              oauth_scopes = '[]'::jsonb
        WHERE id = $1 AND tenant_id = $2`,
      [channelId, tenantId]
    );

    // A legacy credential is what the live Messenger/Comments path reads.
    // Deleting it - or disabling the channel it belongs to - would break an
    // integration that is working right now, so a FULL disconnect refuses to
    // touch it. To remove only the OAuth link from a legacy-connected Page,
    // use disconnectOAuthConnection() instead.
    const { rows: legacyRows } = await client.query(
      `SELECT count(*)::int n
         FROM provider_credentials
        WHERE channel_id = $1
          AND tenant_id = $2
          AND kind = $3`,
      [channelId, tenantId, CREDENTIAL_KIND_LEGACY]
    );
    if ((legacyRows[0]?.n ?? 0) > 0) {
      await client.query('ROLLBACK');
      fail(
        CONNECTION_ERRORS.LEGACY_CREDENTIAL_PRESENT,
        'this channel still uses a legacy Facebook credential; a full disconnect would stop a working integration'
      );
    }

    // Only OAuth-obtained credentials are removed. A legacy row, if one existed,
    // is not touched by this statement.
    await client.query(
      `DELETE FROM provider_credentials
        WHERE channel_id = $1
          AND tenant_id = $2
          AND kind = $3`,
      [channelId, tenantId, CREDENTIAL_KIND_OAUTH]
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id, ip, metadata)
       VALUES ($1,$2,'integrations.facebook.disconnect','channel',$3,$4,$5::jsonb)`,
      [tenantId, actorUserId, pageId, actorIp, JSON.stringify({ channelId })]
    );

    await client.query('COMMIT');
    return { channelId, pageId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}