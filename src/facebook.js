/**
 * Meta/Facebook outbound client (Stage 4.2).
 *
 * Supports page-specific credentials via `createMetaClient({ accessToken })`.
 * Backward compatible: the legacy named exports (replyToComment, sendMessengerReply,
 * sendTypingIndicator, getUserFirstName, privateReplyToComment) keep working with the
 * FB_PAGE_ACCESS_TOKEN environment fallback until Stage 4.3 wires channelResolver.
 *
 * TOKEN SAFETY:
 *  - Credentials are sent via the Authorization HEADER — never embedded in request URLs,
 *    so tokens cannot leak through logged URLs.
 *  - Errors are sanitized (status + message + code only) — never include tokens or raw payloads.
 *  - Missing both credentials fails safely with META_CREDENTIAL_MISSING (no request is sent).
 */

const VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${VERSION}`;

export const META_CREDENTIAL_MISSING = 'META_CREDENTIAL_MISSING';

export class MetaCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetaCredentialError';
    this.code = META_CREDENTIAL_MISSING;
  }
}

/** explicit token → preferred; otherwise legacy env fallback; otherwise fail safely. */
function resolveToken(explicitToken) {
  const token = explicitToken || process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new MetaCredentialError('no Meta page credential available (explicit token missing and FB_PAGE_ACCESS_TOKEN not set)');
  }
  return token;
}

/** Sanitized error — never includes tokens, request URLs, or raw response payloads. */
function toGraphError(res, data) {
  const message = data?.error?.message || res.statusText || 'Graph API error';
  const code = data?.error?.code ? ` (code ${data.error.code})` : '';
  return new Error(`Graph API ${res.status}${code}: ${message}`);
}

/**
 * Create a Meta client bound to a page credential.
 * If `accessToken` is omitted, falls back to the legacy FB_PAGE_ACCESS_TOKEN env
 * (temporary compatibility until Stage 4.3 wires channelResolver).
 */
export function createMetaClient({ accessToken } = {}) {
  const token = resolveToken(accessToken); // may throw META_CREDENTIAL_MISSING

  async function graphPost(path, body) {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}` // header auth — token never appears in URLs
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw toGraphError(res, data);
    return data;
  }

  return {
    /** Reply publicly to a comment, as the Page. Message may contain @[user_id] mention. */
    replyToComment(commentId, message) {
      return graphPost(`/${commentId}/comments`, { message });
    },

    /** Send a PRIVATE reply (Messenger DM) to a commenter instead. */
    privateReplyToComment(commentId, message) {
      return graphPost(`/${commentId}/private_replies`, { message });
    },

    /** Send a Messenger DM reply to a user (by their PSID). */
    sendMessengerReply(psid, text) {
      return graphPost('/me/messages', {
        recipient: { id: psid },
        message: { text },
        messaging_type: 'RESPONSE'
      });
    },

    /** Show "typing..." in the chat while the AI drafts. */
    sendTypingIndicator(psid) {
      return graphPost('/me/messages', {
        recipient: { id: psid },
        sender_action: 'typing_on'
      }).catch((e) => console.warn('typing indicator failed:', e.message));
    },

    /** Fetch the sender's first name for a warmer greeting (null if unavailable). */
    async getUserFirstName(psid) {
      try {
        const res = await fetch(`${GRAPH_BASE}/${psid}?fields=first_name`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        return data.first_name || null;
      } catch {
        return null;
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Backward-compatible named exports — existing callers keep working. */
/* Created lazily so the env fallback resolves at call time.          */
/* ------------------------------------------------------------------ */

export function replyToComment(commentId, message) {
  return createMetaClient().replyToComment(commentId, message);
}

export function privateReplyToComment(commentId, message) {
  return createMetaClient().privateReplyToComment(commentId, message);
}

export function sendMessengerReply(psid, text) {
  return createMetaClient().sendMessengerReply(psid, text);
}

export function sendTypingIndicator(psid) {
  return createMetaClient().sendTypingIndicator(psid);
}

export function getUserFirstName(psid) {
  return createMetaClient().getUserFirstName(psid);
}
