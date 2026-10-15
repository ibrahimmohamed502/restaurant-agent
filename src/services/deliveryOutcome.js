/**
 * Outbound delivery outcome classification.
 *
 * WHY THIS EXISTS
 * A confirmed Meta send whose bookkeeping write then failed was recorded as
 * `failed`, which the dashboard offered for re-send — to a customer who had
 * already received the reply. The Graph API send endpoints carry NO idempotency
 * key, so nothing can prove what happened once an outcome is ambiguous. The only
 * safe answer is to refuse to re-send it.
 *
 * TWO ORTHOGONAL AXES (never collapse them)
 *   outcome   : what we know about delivery
 *   retryable : whether re-sending is safe
 *
 * ---------------------------------------------------------------------------
 * THE ONLY PATH TO `retryable: true`
 * ---------------------------------------------------------------------------
 * Re-sending is permitted only when ALL of the following hold:
 *
 *   1. The error came from a verified Graph error response — `isGraphError`,
 *      set exclusively by toGraphError() in src/facebook.js, the single place
 *      that turns a real Meta HTTP response into an Error.
 *   2. It carries a numeric HTTP status in the 4xx range.
 *   3. It carries a Graph error code from the explicit throttling allow-list
 *      (THROTTLE_GRAPH_CODES: 4, 17, 32, 613 — Meta's documented
 *      application / user / page throttling and custom-level throttling codes).
 *
 * Nothing else is retryable. In particular:
 *
 *   - The HTTP status ALONE is never enough. 429 with no recognised throttling
 *     code is a refusal whose cause we cannot vouch for, so it is NOT retried.
 *     (Documented trade-off: if Meta is throttling us, this leaves a reply
 *     unsent. The alternative — retrying on a bare 429 — is exactly the
 *     duplicate-reply risk this module exists to prevent.)
 *   - Free text is NEVER evidence. A message containing "rate limit",
 *     "too many requests", or matching /Graph API 4\d\d/ cannot make an error
 *     retryable. Provider message text is attacker-influenceable and is not a
 *     contract; only structured fields are.
 *   - A recognised permanent code always wins over the HTTP status, so a
 *     contradictory pair such as (429, 190) can never be re-read as throttling.
 *   - Transport failures, malformed errors and contradictory combinations
 *     (e.g. a 2xx on an error path) are UNKNOWN — never retryable.
 *
 * FAIL-CLOSED RULE
 * Anything unrecognised becomes UNKNOWN or PERMANENT, never retryable. Retrying
 * is the only action in this system capable of duplicating a reply, so ambiguity
 * must always resolve toward not retrying.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA MAPPING — no migration required
 * ---------------------------------------------------------------------------
 * messages.delivery_status has CHECK (delivery_status IN ('pending','sent','failed'))
 * (migrations/004_message_delivery_status.sql). Every outcome maps onto one of
 * those three values:
 *
 *     DELIVERED               -> 'sent'
 *     NOT_DELIVERED_RETRYABLE -> 'failed'  + a retryable category
 *     NOT_DELIVERED_PERMANENT -> 'failed'  + a non-retryable category
 *     UNKNOWN                 -> 'pending' + DELIVERY_UNKNOWN
 *
 * claimFailedOutboundForRetry only claims rows that are 'failed' AND whose
 * category is in RETRYABLE_DELIVERY_CATEGORIES, so an UNKNOWN row is refused
 * automatically and to an operator. delivery_error (free text, unconstrained)
 * carries the reason the UI needs to explain itself.
 */

/** What we know about whether the message reached the customer. */
export const DELIVERY_OUTCOME = {
  /** Meta returned success (and normally a message id). */
  DELIVERED: 'delivered',
  /** Meta refused the message AND the cause is a documented, transient one. */
  NOT_DELIVERED_RETRYABLE: 'not_delivered_retryable',
  /** Meta refused the message; the cause will not resolve on its own. */
  NOT_DELIVERED_PERMANENT: 'not_delivered_permanent',
  /** We never established the outcome. Delivery is unknown. */
  UNKNOWN: 'unknown'
};

/** Sanitized, fixed-vocabulary categories written to messages.delivery_error. */
export const DELIVERY_CATEGORY = {
  RATE_LIMIT: 'meta_rate_limit',
  AUTH_EXPIRED: 'meta_auth_expired',
  PERMISSION: 'meta_permission',
  API_ERROR: 'meta_api_error',
  UNKNOWN: 'delivery_unknown'
};

/**
 * The ONLY category that may be re-sent. One entry, backed by one documented
 * Graph API behaviour.
 *
 * Adding a second entry is a promise that Meta definitively refused the message
 * for a transient reason. That promise must be backed by a documented Graph error
 * code — never by an HTTP status alone and never by message text.
 */
export const RETRYABLE_DELIVERY_CATEGORIES = Object.freeze([
  DELIVERY_CATEGORY.RATE_LIMIT
]);

/**
 * Meta Graph API error codes, as documented and stable.
 *
 *   throttling (the retry allow-list) — Meta rejects the request and does not
 *   create the message:
 *     4   Application request limit reached
 *     17  User request limit reached
 *     32  Page request limit reached
 *     613 Custom-level throttling
 *
 *   permanent — re-sending cannot succeed until a human fixes the credential,
 *   and each attempt risks duplicating a reply that may already have landed:
 *     190 / 102 / 458 / 459  invalid or expired token, session expired
 *     10  / 200  / 294      permission denied / permissions error / verification
 */
const THROTTLE_GRAPH_CODES = new Set([4, 17, 32, 613]);
const AUTH_GRAPH_CODES = new Set([190, 102, 458, 459]);
const PERMISSION_GRAPH_CODES = new Set([10, 200, 294]);
const KNOWN_GRAPH_CODES = new Set([
  ...THROTTLE_GRAPH_CODES, ...AUTH_GRAPH_CODES, ...PERMISSION_GRAPH_CODES
]);

/** Codes whose semantics we know well enough to name precisely. */
const GRAPH_CODE_CATEGORY = new Map([
  ...[...AUTH_GRAPH_CODES].map((c) => [c, DELIVERY_CATEGORY.AUTH_EXPIRED]),
  ...[...PERMISSION_GRAPH_CODES].map((c) => [c, DELIVERY_CATEGORY.PERMISSION]),
  ...[...THROTTLE_GRAPH_CODES].map((c) => [c, DELIVERY_CATEGORY.RATE_LIMIT])
]);

const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'
]);

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const isTransportFailure = (err) =>
  err?.isTransportError === true ||
  err?.name === 'AbortError' ||
  TRANSPORT_CODES.has(err?.cause?.code) ||
  TRANSPORT_CODES.has(err?.code);

const build = (outcome, category, retryable, reason) =>
  Object.freeze({
    outcome,
    category,
    retryable,
    /** Value written to messages.delivery_status (always schema-legal). */
    deliveryStatus: outcome === DELIVERY_OUTCOME.DELIVERED
      ? 'sent'
      : outcome === DELIVERY_OUTCOME.UNKNOWN
        ? 'pending'
        : 'failed',
    /** Internal diagnostic only — never persisted, never logged verbatim. */
    reason
  });

const delivered = () => build(DELIVERY_OUTCOME.DELIVERED, null, false, 'provider_success');
const unknown = (reason) => build(DELIVERY_OUTCOME.UNKNOWN, DELIVERY_CATEGORY.UNKNOWN, false, reason);
const permanent = (category, reason) => build(DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT, category, false, reason);
const retryable = () => build(DELIVERY_OUTCOME.NOT_DELIVERED_RETRYABLE, DELIVERY_CATEGORY.RATE_LIMIT, true, 'documented_throttle_code');

/**
 * Classify ONE Meta send attempt.
 *
 * @param {Error|null} err  null when the provider reported success.
 * @returns {{outcome: string, category: string|null, retryable: boolean,
 *            deliveryStatus: string, reason: string}}
 */
export function classifyDeliveryError(err) {
  if (!err) return delivered();

  // --- 1. No HTTP response reached us: the request may have been delivered. ---
  if (isTransportFailure(err)) return unknown('transport_failure');

  // --- 2. A structured response is required. Anything without a numeric HTTP
  //        status is malformed from our point of view. Free text is NOT a
  //        substitute: message content is not a contract. ---
  const status = toInt(err.status);
  if (status === null) return unknown('malformed_no_status');

  const graphCode = toInt(err.graphCode);

  // --- 3. Meta's own edge failed. The message may already exist. ---
  if (status >= 500) return unknown('provider_server_error');

  // --- 4. A recognised permanent code wins over the HTTP status, so a
  //        contradictory pair like (429, 190) can never be read as throttling. ---
  if (graphCode !== null && AUTH_GRAPH_CODES.has(graphCode)) {
    return permanent(DELIVERY_CATEGORY.AUTH_EXPIRED, 'graph_code_auth');
  }
  if (graphCode !== null && PERMISSION_GRAPH_CODES.has(graphCode)) {
    return permanent(DELIVERY_CATEGORY.PERMISSION, 'graph_code_permission');
  }

  // --- 5. THE ONLY RETRYABLE PATH.
  //        Verified Graph response + 4xx + explicitly allow-listed code. ---
  if (
    err.isGraphError === true &&
    graphCode !== null &&
    THROTTLE_GRAPH_CODES.has(graphCode) &&
    status >= 400 &&
    status < 500
  ) {
    return retryable();
  }

  // --- 6. A Graph code we do not recognise, or no code at all: the refusal is
  //        confirmed (we received an error payload) but the cause is not one we
  //        can vouch for. Never retried. ---
  if (graphCode !== null) {
    return permanent(DELIVERY_CATEGORY.API_ERROR, 'graph_code_unrecognised');
  }

  // --- 7. A bare HTTP 429. Meta refused the request, but with no throttling
  //        code we cannot prove this is the documented throttling path rather
  //        than an edge/proxy limit. Not retried. ---
  if (status === 429) return permanent(DELIVERY_CATEGORY.API_ERROR, 'http_429_without_throttle_code');

  // --- 8. Any other 4xx: confirmed refusal, never assumed transient. ---
  if (status >= 400) return permanent(DELIVERY_CATEGORY.API_ERROR, 'http_4xx_unrecognised');

  // --- 9. 1xx/2xx/3xx arriving on an error path is contradictory. ---
  return unknown('contradictory_status');
}

/**
 * Legacy categorization for errors that never went through toGraphError().
 *
 * PERMITTED ONLY to label a refusal as permanent or as unknown. This function
 * is structurally incapable of returning retryable — that is the whole point.
 * Anything it cannot recognise becomes UNKNOWN.
 */
export function classifyUnstructuredError(err) {
  if (!err) return delivered();
  if (isTransportFailure(err)) return unknown('transport_failure');
  const msg = String(err?.message ?? '');
  if (/Graph API 5\d\d/.test(msg)) return unknown('unstructured_server_error');
  if (/Graph API 401|validating access token|session has expired/i.test(msg)) {
    return permanent(DELIVERY_CATEGORY.AUTH_EXPIRED, 'unstructured_auth_text');
  }
  if (/Graph API 403|permission|OAuthException/i.test(msg)) {
    return permanent(DELIVERY_CATEGORY.PERMISSION, 'unstructured_permission_text');
  }
  // Deliberately NO branch for /rate limit|too many requests|Graph API 4\d\d/:
  // provider message text can never authorise a retry.
  return unknown('unstructured_unrecognised');
}

/** True only for a category proven to mean "refused, and safe to re-send". */
export function isRetryableDeliveryCategory(category) {
  return RETRYABLE_DELIVERY_CATEGORIES.includes(category);
}

/**
 * Can this recorded row be re-sent?
 * Single source of truth for the dashboard retry endpoint — the same rule the
 * database enforces in claimFailedOutboundForRetry.
 */
export function isRetryableDeliveryRow({ deliveryStatus, deliveryError } = {}) {
  if (deliveryStatus !== 'failed') return false;
  return isRetryableDeliveryCategory(deliveryError);
}

/** Exposed for tests and documentation; the allow-list is the contract. */
export const GRAPH_CODE_POLICY = Object.freeze({
  throttling: Object.freeze([...THROTTLE_GRAPH_CODES]),
  auth: Object.freeze([...AUTH_GRAPH_CODES]),
  permission: Object.freeze([...PERMISSION_GRAPH_CODES]),
  byCode: Object.freeze(Object.fromEntries(GRAPH_CODE_CATEGORY))
});

/**
 * Ledger for the outbound side of ONE inbound event.
 *
 * The processor fills this in and the worker pipeline reads it afterwards. Its
 * single purpose is to record that an irreversible Meta send was started, so the
 * pipeline can decide whether the event may ever be retried. That decision is
 * made by the database claim, not by any try/catch inside the processor — which
 * is what makes the guarantee structural rather than incidental.
 */
export function createOutboundLedger() {
  return { started: false, outcome: null, category: null };
}