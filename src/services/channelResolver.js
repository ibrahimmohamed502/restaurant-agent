import { pool, enabled } from '../db/pg.js';
import { decrypt } from '../db/crypto.js';

/**
 * Stage 4.1 — Channel Resolver.
 *
 * Securely resolves an incoming Meta Page ID (webhook entry.id) to its
 * channel / tenant / brand / provider credential.
 *
 * The DATABASE is the source of truth. Resolution is STRICT:
 *  - unknown / unconfigured page id  → UNKNOWN_META_PAGE (never auto-routes)
 *  - inactive / disabled channel     → CHANNEL_INACTIVE
 *  - channel without a credential    → CREDENTIAL_MISSING (only when credential requested)
 *
 * SECURITY:
 *  - Never logs or exposes the decrypted credential. It is returned ONLY when
 *    `includeCredential: true` (internal outbound use), and must never be
 *    serialized to frontend APIs, logs, errors, audit logs, or debug output.
 *  - Reuses the Stage 1 AES-256-GCM implementation (src/db/crypto.js).
 */

export const RESOLVE_ERRORS = {
  UNKNOWN_META_PAGE: 'UNKNOWN_META_PAGE',
  CHANNEL_INACTIVE: 'CHANNEL_INACTIVE',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING'
};

export class ChannelResolveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChannelResolveError';
    this.code = code;
  }
}

/**
 * Resolve a Meta page id to its channel context.
 *
 * @param {string} pageId          incoming Meta page id (webhook entry.id)
 * @param {object} [opts]
 * @param {boolean} [opts.includeCredential=false]  also load+decrypt the page credential (internal only)
 * @param {object} [opts.db=pool]                   query executor (pool or a transaction client) — for tests
 * @returns {Promise<{channelId, tenantId, brandId, provider, externalId, displayName, status, credential?}>}
 */
export async function resolveMetaChannel(pageId, { includeCredential = false, db } = {}) {
  const executor = db ?? pool;
  // The enabled gate applies only when using the real pool — a custom db (tests) bypasses it.
  if (!db && !enabled) {
    throw new ChannelResolveError(RESOLVE_ERRORS.UNKNOWN_META_PAGE, 'database not enabled (legacy mode)');
  }
  if (!pageId) {
    throw new ChannelResolveError(RESOLVE_ERRORS.UNKNOWN_META_PAGE, 'missing page id');
  }

  // 1) Resolve the routing channel by the incoming page id (external_id).
  //    Tenant/brand come FROM the channel row — never from a default.
  //    Prefer 'meta' provider (legacy, has credentials) over 'meta_dm'/'meta_comment'.
  //    Within same provider, prefer the one with credentials, then oldest.
  const { rows } = await executor.query(
    `SELECT c.id, c.tenant_id, c.brand_id, c.provider, c.external_id, c.display_name, c.status,
            CASE WHEN pc.channel_id IS NOT NULL THEN 0 ELSE 1 END AS has_cred,
            CASE c.provider WHEN 'meta' THEN 0 WHEN 'meta_dm' THEN 1 WHEN 'meta_comment' THEN 2 ELSE 3 END AS provider_priority
     FROM channels c
     LEFT JOIN (
       SELECT DISTINCT channel_id FROM provider_credentials
       WHERE kind = 'page_access_token'
     ) pc ON pc.channel_id = c.id
     WHERE c.external_id = $1 AND c.provider IN ('meta', 'meta_dm', 'meta_comment')
     ORDER BY has_cred ASC, provider_priority ASC, c.created_at ASC
     LIMIT 1`,
    [String(pageId)]
  );
  const channel = rows[0];
  if (!channel) {
    throw new ChannelResolveError(RESOLVE_ERRORS.UNKNOWN_META_PAGE, `no meta channel configured for page ${pageId}`);
  }

  // 2) Channel status gate — disabled/inactive channels must not process.
  if (channel.status !== 'active') {
    throw new ChannelResolveError(RESOLVE_ERRORS.CHANNEL_INACTIVE, `meta channel ${channel.id} is ${channel.status}`);
  }

  // 3) Base result — safe for logs/debug (contains NO credential).
  const result = {
    channelId: channel.id,
    tenantId: channel.tenant_id,
    brandId: channel.brand_id,
    provider: channel.provider,
    externalId: channel.external_id,
    displayName: channel.display_name,
    status: channel.status
  };

  // 4) Credential — loaded ONLY when requested, ownership-scoped to (channel_id, tenant_id).
  //    A credential for another channel/tenant cannot be selected by id-guessing.
  if (includeCredential) {
    const { rows: creds } = await executor.query(
      `SELECT value_encrypted, iv
       FROM provider_credentials
       WHERE channel_id = $1 AND tenant_id = $2 AND kind = 'page_access_token'
       ORDER BY created_at DESC
       LIMIT 1`,
      [channel.id, channel.tenant_id]
    );
    const cred = creds[0];
    if (!cred) {
      throw new ChannelResolveError(RESOLVE_ERRORS.CREDENTIAL_MISSING, `no page_access_token credential for channel ${channel.id}`);
    }
    // Decrypted in memory only — NEVER log or serialize this value.
    result.credential = decrypt(cred.value_encrypted, cred.iv);
  }

  return result;
}

/**
 * P0.2 — resolve the page credential for a channel we already hold an id for.
 *
 * WHY A SEPARATE FUNCTION
 * ----------------------
 * resolveMetaChannel() takes a PAGE ID and re-runs the whole routing query,
 * which deliberately prefers a `provider='meta'` channel carrying credentials
 * over `meta_dm` / `meta_comment`. That preference is correct for an INBOUND
 * webhook (several channel rows can describe the same page) and wrong for an
 * OUTBOUND reply: the conversation hangs off one specific channel, and sending
 * with a different channel's credential would deliver a company's reply through
 * the wrong page.
 *
 * So this resolves strictly by (channel_id, tenant_id) — the pair the caller has
 * already proved it owns — and returns the newest page_access_token for that
 * exact channel. No id-guessing, no cross-tenant selection, and NO
 * FB_PAGE_ACCESS_TOKEN env fallback: a channel with no stored credential is a
 * hard failure, never a silent use of some global token.
 *
 * The decrypted value is returned ONLY to the outbound caller and must never be
 * logged, serialized, audited or placed in an error.
 *
 * @param {{channelId: string, tenantId: string, db?: object}} args
 * @returns {Promise<string|null>} the credential, or null when none is stored
 */
export async function resolveCredentialForChannel({ channelId, tenantId, db } = {}) {
  const executor = db ?? pool;
  if (!channelId || !tenantId) return null;
  const { rows } = await executor.query(
    `SELECT value_encrypted, iv
       FROM provider_credentials
      WHERE channel_id = $1 AND tenant_id = $2 AND kind = 'page_access_token'
      ORDER BY created_at DESC
      LIMIT 1`,
    [channelId, tenantId]
  );
  const cred = rows[0];
  if (!cred) return null;
  return decrypt(cred.value_encrypted, cred.iv);
}