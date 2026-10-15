/**
 * Stage 8 Batch 2 — safe health diagnostics.
 *
 * `integration_health.last_error` is operator/provider-written text. Returning it
 * verbatim would leak raw provider errors (which can embed customer identifiers,
 * tokens in URLs, or PII). Truncation is NOT sanitization, so the API only ever
 * returns values from a fixed allow-list of diagnostic CODES.
 *
 * Anything unrecognized becomes the constant UNRECOGNIZED_ERROR — the original
 * text is never inspected for meaning and never leaves the server.
 */

/** Health states the UI understands (integration_health.status). */
const SAFE_STATUSES = new Set(['ok', 'degraded', 'down']);

/**
 * Approved diagnostic codes. Sources:
 *  - services/channelResolver.js  (RESOLVE_ERRORS)
 *  - services/routeContext.js    (ROUTE_ERRORS)
 *  - services/conversations.js   (deliveryErrorCategory)
 *  - workers/metaEventPipeline.js (terminal pipeline codes)
 */
const SAFE_ERROR_CODES = new Set([
  // channelResolver
  'UNKNOWN_META_PAGE',
  'CHANNEL_INACTIVE',
  'CREDENTIAL_MISSING',
  // routeContext
  'MISSING_PAGE_ID',
  'RESOLVE_FAILED',
  'TENANT_DISABLED',
  // delivery categories
  'META_AUTH_EXPIRED',
  'META_PERMISSION',
  'META_RATE_LIMIT',
  'META_API_ERROR',
  'NETWORK_ERROR',
  // pipeline
  'ROUTING_FAILED',
  'PROCESSING_ERROR'
]);

/** Returned instead of any unrecognized value. Carries no information. */
export const UNRECOGNIZED_ERROR = 'UNRECOGNIZED_ERROR';

/** Normalized health status, or 'unknown' for anything not explicitly safe. */
export function safeHealthStatus(raw) {
  if (raw === null || raw === undefined || raw === '') return 'unknown';
  const s = String(raw).trim().toLowerCase();
  return SAFE_STATUSES.has(s) ? s : 'unknown';
}

/**
 * Approved diagnostic code, or null when nothing was recorded.
 * Unrecognized content collapses to UNRECOGNIZED_ERROR — raw text is dropped.
 */
export function safeHealthErrorCode(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim().toUpperCase();
  if (SAFE_ERROR_CODES.has(s)) return s;
  return UNRECOGNIZED_ERROR;
}

export { SAFE_ERROR_CODES, SAFE_STATUSES };