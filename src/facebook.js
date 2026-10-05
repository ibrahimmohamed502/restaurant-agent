const VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${VERSION}`;

async function graphPost(path, body) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      access_token: process.env.FB_PAGE_ACCESS_TOKEN
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Graph API ${res.status}: ${JSON.stringify(data.error || data)}`);
  }
  return data;
}

/**
 * Reply publicly to a comment, as the Page.
 * Requires: pages_manage_engagement permission + Page Access Token.
 * The message may contain @[user_id] to tag the commenter.
 */
export function replyToComment(commentId, message) {
  return graphPost(`/${commentId}/comments`, { message });
}

/** Optional: send a PRIVATE reply (Messenger DM) to a commenter instead. */
export function privateReplyToComment(commentId, message) {
  return graphPost(`/${commentId}/private_replies`, { message });
}

/* --------------------------- Messenger (DMs) --------------------------- */

/** Send a Messenger DM reply to a user (by their PSID). Needs pages_messaging. */
export function sendMessengerReply(psid, text) {
  return graphPost('/me/messages', {
    recipient: { id: psid },
    message: { text },
    messaging_type: 'RESPONSE'
  });
}

/** Show "typing..." in the chat while the AI drafts — makes the bot feel alive. */
export function sendTypingIndicator(psid) {
  return graphPost('/me/messages', {
    recipient: { id: psid },
    sender_action: 'typing_on'
  }).catch((e) => console.warn('typing indicator failed:', e.message));
}

/** Fetch the sender's first name for a warmer greeting (null if unavailable). */
export async function getUserFirstName(psid) {
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${psid}?fields=first_name&access_token=${process.env.FB_PAGE_ACCESS_TOKEN}`
    );
    const data = await res.json();
    return data.first_name || null;
  } catch {
    return null;
  }
}
