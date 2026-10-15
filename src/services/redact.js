/**
 * Privacy-safe helpers for operational logging.
 *
 * Production logging previously wrote raw customer message text, Facebook PSIDs
 * and full webhook payloads into the container log. These helpers keep the
 * operational signal (volume, flow, correlation) without the customer content:
 *
 *   - redactId()      → short, stable, non-reversible digest, so the same person
 *                       can still be followed across log lines.
 *   - textSummary()   → shape only (length), never the words.
 *   - safeErrorCode() → a stable code, never a raw provider message which may
 *                       echo the payload it failed on.
 *
 * The digest is not a credential and is not reversible by design; it exists so
 * operators can correlate a session without reading what the customer wrote.
 */
import { createHash } from 'node:crypto';

/** Non-secret, fixed namespace so digests are stable across restarts. */
const NAMESPACE = 'redact.v1';

/** Short stable digest for a person/message identifier. */
export function redactId(value) {
  if (value === null || value === undefined || value === '') return 'none';
  const digest = createHash('sha256').update(`${NAMESPACE}:${String(value)}`).digest('hex');
  return digest.slice(0, 10);
}

/** Shape of a piece of customer text, never the text itself. */
export function textSummary(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const trimmed = text.trim();
  return {
    chars: text.length,
    hasContent: trimmed.length > 0,
    mediaOnly: trimmed.length === 0
  };
}

/** Stable, non-sensitive error identity for logs. */
export function safeErrorCode(err) {
  if (!err) return 'error';
  const code = err.code ?? err.name ?? 'error';
  return String(code).slice(0, 60);
}