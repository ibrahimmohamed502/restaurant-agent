import { resolveMetaChannel, RESOLVE_ERRORS } from './channelResolver.js';
import { createMetaClient } from '../facebook.js';

/**
 * Stage 4.3B.1 — Route Context.
 *
 * Resolves a Meta webhook entry.id to a fully-ready routing context:
 *   { pageId, channelId, tenantId, brandId, displayName, metaClient }
 *
 * The DATABASE (channels + provider_credentials) is the ONLY credential source
 * for routed webhook events. There is NO environment credential fallback.
 *
 * Fail-closed on every error path. The credential is NEVER exposed in returned
 * errors or logs (known channelResolver codes pass through their safe messages;
 * generic/decryption failures get a safe generic message without the raw text).
 */

export class RouteContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouteContextError';
    this.code = code;
  }
}

export const ROUTE_ERRORS = {
  MISSING_PAGE_ID: 'MISSING_PAGE_ID',
  RESOLVE_FAILED: 'RESOLVE_FAILED',
  ...RESOLVE_ERRORS // UNKNOWN_META_PAGE · CHANNEL_INACTIVE · CREDENTIAL_MISSING
};

/**
 * Build a routing context for a webhook entry.
 *
 * @param {object|string} entry  webhook entry ({ id, time, changes/messaging }) or a page id string
 * @param {object} [opts]
 * @param {Function} [opts.resolveFn=resolveMetaChannel]  resolver to use (injectable for tests)
 * @param {Function} [opts.clientFactory=createMetaClient]  meta client factory (injectable for tests)
 * @returns {Promise<{pageId, channelId, tenantId, brandId, displayName, metaClient}>}
 */
export async function buildRouteContext(entry, { resolveFn = resolveMetaChannel, clientFactory = createMetaClient } = {}) {
  // 1) require a valid page id (entry.id) — fail closed if absent
  const pageId = typeof entry === 'string' ? entry : entry?.id;
  if (!pageId) {
    throw new RouteContextError(
      ROUTE_ERRORS.MISSING_PAGE_ID,
      'webhook entry has no id — cannot route (fail closed)'
    );
  }

  // 2) resolve channel/tenant/brand + decrypt the DB credential (fail-closed)
  let resolved;
  try {
    resolved = await resolveFn(pageId, { includeCredential: true });
  } catch (err) {
    if (err?.code) {
      // channelResolver codes carry safe messages (no credentials) — pass through
      throw new RouteContextError(err.code, err.message);
    }
    // generic failures (decryption/DB) — safe generic message, never the raw text
    throw new RouteContextError(ROUTE_ERRORS.RESOLVE_FAILED, `routing failed for page ${pageId}`);
  }

  // 3) build the meta client ONLY from the decrypted DB credential (defensive guard)
  if (!resolved.credential) {
    throw new RouteContextError(ROUTE_ERRORS.CREDENTIAL_MISSING, `no credential resolved for page ${pageId}`);
  }

  return {
    pageId: resolved.externalId,
    channelId: resolved.channelId,
    tenantId: resolved.tenantId,
    brandId: resolved.brandId,
    displayName: resolved.displayName,
    metaClient: clientFactory({ accessToken: resolved.credential })
  };
}
