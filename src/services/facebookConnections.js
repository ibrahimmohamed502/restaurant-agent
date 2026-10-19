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
import { brandIsAccessible } from '../api/v1/brandAccess.js';
import {
  discoverPages,
  assessPagePermissions,
  META_OAUTH_ERRORS
} from '../providers/meta/oauth.js';

export const CONNECTION_ERRORS = {
  BRAND_NOT_ACCESSIBLE: 'BRAND_NOT_ACCESSIBLE',
  BRAND_REQUIRED: 'BRAND_REQUIRED',
  PAGE_NOT_IN_ACCOUNT: 'PAGE_NOT_IN_ACCOUNT',
  PAGE_NOT_CONNECTABLE: 'PAGE_NOT_CONNECTABLE',
  PAGE_OWNED_BY_ANOTHER_TENANT: 'PAGE_OWNED_BY_ANOTHER_TENANT',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  UPSTREAM_ERROR: 'CONNECTION_UPSTREAM_ERROR'
};

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
 * Which tenant, if any, already owns this Page.
 *
 * Returning the tenant id lets the caller distinguish "nobody has it" from
 * "somebody else has it" and refuse the second without naming them.
 */
async function findExistingOwner({ db, pageId }) {
  const { rows } = await db.query(
    `SELECT tenant_id, brand_id, id
       FROM channels
      WHERE external_id = $1
        AND provider IN ('meta', 'meta_dm', 'meta_comment')
      LIMIT 1`,
    [pageId]
  );
  return rows[0] || null;
}

/**
 * Discover the caller's managed Pages WITHOUT persisting anything.
 *
 * This is the "show me what I can connect" step. It is deliberately read-only:
 * an abandoned selection must leave no channel, no credential and no audit row
 * suggesting a connection happened.
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
      missingTasks: assessment.missingTasks
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
 * @param {string}  args.scopes
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
  scopes = [],
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

  return await runConnectTransaction({
    tenantId,
    actorUserId,
    brandId,
    brandScope,
    chosen,
    scopes,
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
  scopes,
  actorIp,
  mode,
  db
}) {
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
    const owner = await findExistingOwner({ db: client, pageId: chosen.pageId });
    if (owner && String(owner.tenant_id) !== String(tenantId)) {
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

    let channelId;
    if (owner && String(owner.tenant_id) === String(tenantId)) {
      // Same tenant: reconnect, or move to a different brand of the same company.
      // The pre-existing global unique index on external_id means we UPDATE the
      // row rather than inserting a second one. `channels` has no updated_at
      // column, so the connection timestamp is the only freshness marker.
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
        [owner.id, tenantId, brandId, chosen.name, JSON.stringify(scopes)]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        fail(CONNECTION_ERRORS.CHANNEL_NOT_FOUND, 'existing connection could not be updated');
      }
      channelId = rows[0].id;

      // Replace the credential rather than accumulating rows.
      await client.query(
        `DELETE FROM provider_credentials WHERE channel_id = $1 AND kind = 'page_access_token'`,
        [channelId]
      );
    } else {
      const { rows } = await client.query(
        `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                               oauth_provider, oauth_connected_at, oauth_scopes)
         VALUES ($1,$2,'meta',$3,$4,'active','meta',now(),$5::jsonb)
         RETURNING id`,
        [tenantId, brandId, chosen.pageId, chosen.name, JSON.stringify(scopes)]
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

    const { value, iv } = encrypt(chosen.pageAccessToken);
    await client.query(
      `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, expires_at, last_rotated_at)
       VALUES ($1,$2,'page_access_token',$3,$4,NULL,now())`,
      [tenantId, channelId, value, iv]
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
        JSON.stringify({ brandId, name: chosen.name, scopes })
      ]
    );

    await client.query('COMMIT');

    return { channelId, brandId, pageId: chosen.pageId, name: chosen.name, mode };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
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

  const { rows } = await db.query(
    `SELECT c.id, c.brand_id, c.external_id, c.display_name, c.status,
            c.oauth_provider, c.oauth_connected_at, c.oauth_scopes,
            b.name AS brand_name,
            EXISTS (SELECT 1 FROM provider_credentials pc
                     WHERE pc.channel_id = c.id AND pc.kind = 'page_access_token') AS credential_present,
            (SELECT MAX(pc.expires_at) FROM provider_credentials pc
              WHERE pc.channel_id = c.id AND pc.kind = 'page_access_token') AS credential_expires_at
       FROM channels c
       LEFT JOIN brands b ON b.id = c.brand_id
      WHERE c.tenant_id = $1
        AND c.oauth_provider = 'meta'
        ${brandClause}
      ORDER BY COALESCE(c.oauth_connected_at, c.created_at) DESC`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    brand: r.brand_id ? { id: r.brand_id, name: r.brand_name } : null,
    pageId: r.external_id,
    pageName: r.display_name,
    status: r.status,
    provider: r.oauth_provider,
    connectedAt: r.oauth_connected_at,
    scopes: Array.isArray(r.oauth_scopes) ? r.oauth_scopes : [],
    credentialPresent: Boolean(r.credential_present),
    // null means "Meta did not state an expiry". It is surfaced as-is rather
    // than being rewritten to "never expires", because that claim is not ours to
    // make. Token lifecycle and refresh are a later batch.
    credentialExpiresAt: r.credential_expires_at
  }));
}

/**
 * Disconnect a Page.
 *
 * The channel row is kept (webhook routing, conversation history and audit all
 * reference it) but is deactivated and stripped of its credential. A hard delete
 * would cascade through conversations and destroy history that has no reason to
 * be destroyed because someone unlinked a page.
 */
export async function disconnectPage({ db, tenantId, actorUserId, channelId, actorIp = null }) {
  if (!db) throw new ConnectionError(CONNECTION_ERRORS.UPSTREAM_ERROR, 'db handle is required');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // tenant_id in the WHERE clause is the isolation boundary.
    const { rows: found } = await client.query(
      `SELECT id, external_id FROM channels WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [channelId, tenantId]
    );
    if (!found.length) {
      await client.query('ROLLBACK');
      fail(CONNECTION_ERRORS.CHANNEL_NOT_FOUND, 'connection not found');
    }
    const pageId = found[0].external_id;

    await client.query(
      `UPDATE channels
          SET status = 'disabled',
              oauth_connected_at = NULL
        WHERE id = $1 AND tenant_id = $2`,
      [channelId, tenantId]
    );

    await client.query(
      `DELETE FROM provider_credentials WHERE channel_id = $1 AND tenant_id = $2`,
      [channelId, tenantId]
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