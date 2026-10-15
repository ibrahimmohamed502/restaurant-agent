/**
 * Outbound delivery outcome classification.
 *
 * WHY THIS EXISTS
 * The previous model collapsed every failed send into one bucket
 * (`delivery_status = 'failed'`, category from a message regex) and the
 * dashboard then offered that row for retry. Two very different situations were
 * being treated as identical:
 *
 *   1. Meta answered with an error payload  -> the message was NOT created.
 *   2. We never learned the outcome at all   -> a timeout, a reset socket, or
 *                                               a 5xx. The message may well have
 *                                               been delivered.
 *
 * Retrying (1) is safe and useful. Retrying (2) is how a customer receives the
 * same reply twice. There is NO provider-level idempotency key on the Graph API
 * send endpoints, so nothing below can prove what happened in case (2) — the
 * only safe answer is to refuse to retry it.
 *
 * TWO ORTHOGONAL AXES (do not collapse them)
 *   outcome   : what we know about delivery   (DELIVERED / NOT_DELIVERED_* / UNKNOWN)
 *   retryable : whether re-sending is safe    (derived, and deliberately narrow)
 *
 * MAPPING TO THE EXISTING SCHEMA — no migration is required.
 *   messages.delivery_status has CHECK (delivery_status IN ('pending','sent','failed'))
 *   (migrations/004_message_delivery_status.sql), so every outcome maps onto an
 *   existing value:
 *
 *     DELIVERED                 -> 'sent'
 *     NOT_DELIVERED_RETRYABLE   -> 'failed'  + a retryable category
 *     NOT_DELIVERED_PERMANENT   -> 'failed'  + a non-retryable category
 *     UNKNOWN                   -> 'pending' + DELIVERY_UNKNOWN
 *
 *   'pending' + category `delivery_unknown` is the "outcome not established"
 *   marker. `claimFailedOutboundForRetry` only claims `delivery_status='failed'`
 *   AND a category in RETRYABLE_DELIVERY_CATEGORIES, so an UNKNOWN row is
 *   refused both automatically and by an operator clicking Retry. The category
 *   column (free text, unconstrained) is what lets the UI explain WHY.
 *
 * FAIL-CLOSED RULE
 * Anything unrecognised becomes UNKNOWN, never "retryable". Retrying is the only
 * action in this system capable of duplicating a reply, so ambiguity must always
 * resolve toward not retrying.
 */

/** What we know about whether the message reached the customer. */
export const DELIVERY_OUTCOME = {
  /** Meta returned success (and normally a message id). */
  DELIVERED: 'delivered',
  /** Meta answered with an error payload; the message was NOT created. */
  NOT_DELIVERED_RETRYABLE: 'not_delivered_retryable',
  /** Meta answered with an error payload; the message was NOT created, and
   *  the cause will not resolve on its own (bad token, missing permission). */
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
 * The ONLY categories an operator or an automatic job may re-send.
 *
 * Deliberately a single entry. Every addition is a promise that Meta definitively
 * refused the message, and that promise must be backed by a documented Graph API
 * error — not by a guess. Auth and permission failures are excluded on purpose:
 * re-sending them cannot succeed until a human fixes the credential, and each
 * attempt risks a duplicate if the previous one actually landed.
 */
export const RETRYABLE_DELIVERY_CATEGORIES = Object.freeze([
  DELIVERY_CATEGORY.RATE_LIMIT
]);

/* Graph API error codes (documented, stable, not inferred):
 *   4/17/32/613  -> throttling: transient, and the message was not created
 *   190/102/458  -> token invalid/expired/session: needs re-auth
 *   10/200/294   -> permission denied / business verification: needs a fix
 */
const RATE_LIMIT_GRAPH_CODES = new Set([4, 17, 32, 613]);
const AUTH_GRAPH_CODES = new Set([190, 102, 458, 459]);
const PERMISSION_GRAPH_CODES = new Set([10, 200, 294]);

const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'
]);

const isTransportFailure = (err) =>
  err?.isTransportError === true ||
  err?.name === 'AbortError' ||
  TRANSPORT_CODES.has(err?.cause?.code) ||
  TRANSPORT_CODES.has(err?.code);

const build = (outcome, category, retryable) =>
  Object.freeze({
    outcome,
    category,
    retryable,
    /** Value written to messages.delivery_status (always schema-legal). */
    deliveryStatus: outcome === DELIVERY_OUTCOME.DELIVERED
      ? 'sent'
      : outcome === DELIVERY_OUTCOME.UNKNOWN
        ? 'pending'
        : 'failed'
  });

const delivered = () => build(DELIVERY_OUTCOME.DELIVERED, null, false);
const unknown = () => build(DELIVERY_OUTCOME.UNKNOWN, DELIVERY_CATEGORY.UNKNOWN, false);
const rateLimited = () => build(DELIVERY_OUTCOME.NOT_DELIVERED_RETRYABLE, DELIVERY_CATEGORY.RATE_LIMIT, true);
const authExpired = () => build(DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT, DELIVERY_CATEGORY.AUTH_EXPIRED, false);
const permission = () => build(DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT, DELIVERY_CATEGORY.PERMISSION, false);

/**
 * Classify the result of ONE Meta send attempt.
 *
 * @param {Error|null} err  null when the provider reported success.
 * @returns {{outcome: string, category: string|null, retryable: boolean, deliveryStatus: string}}
 */
export function classifyDeliveryError(err) {
  if (!err) return delivered();

  // No HTTP response reached us. The request may have been fully processed.
  if (isTransportFailure(err)) return unknown();

  const status = Number.isFinite(Number(err.status)) ? Number(err.status) : null;
  const graphCode = err.graphCode != null && Number.isFinite(Number(err.graphCode))
    ? Number(err.graphCode)
    : null;

  if (status != null) {
    // A 5xx means Meta's own edge failed. The message may already exist.
    if (status >= 500) return unknown();
    if (status === 429 || RATE_LIMIT_GRAPH_CODES.has(graphCode)) return rateLimited();
    if (status === 401 || AUTH_GRAPH_CODES.has(graphCode)) return authExpired();
    if (status === 403 || PERMISSION_GRAPH_CODES.has(graphCode)) return permission();
    // Any other 4xx: Meta parsed the request and refused it, so non-delivery is
    // confirmed — but an unrecognised rejection is NOT assumed to be transient.
    return build(DELIVERY_OUTCOME.NOT_DELIVERED_PERMANENT, DELIVERY_CATEGORY.API_ERROR, false);
  }

  // No structured status. Fall back to the message ONLY for shapes we can still
  // reason about, keeping the historical ordering (401/403 before the 4xx
  // pattern, which would otherwise swallow 401 and 403 as "rate limit").
  const msg = String(err?.message ?? '');
  if (/Graph API 5\d\d/.test(msg)) return unknown();
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network/i.test(msg)) return unknown();
  if (/Graph API 401|validating access token|session has expired/i.test(msg)) return authExpired();
  if (/Graph API 403|permission|OAuthException/i.test(msg)) return permission();
  if (/Graph API 4\d\d|rate limit|too many requests/i.test(msg)) return rateLimited();

  return unknown();
}

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

/** True only when the provider refused the message and re-sending may succeed. */
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