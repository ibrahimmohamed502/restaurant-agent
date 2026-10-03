/* ------------------------------------------------------------------ */
/* In-memory state: dedupe (never reply twice to the same comment)     */
/* + a generous anti-abuse cap. Swap for Redis if you run multiple     */
/* server instances.                                                   */
/* ------------------------------------------------------------------ */

const REPLY_TTL_MS = 24 * 60 * 60 * 1000; // remember handled comments for 24h
const WINDOW_MS = 60 * 60 * 1000; // sliding 1-hour window for the per-user cap

const repliedComments = new Map(); // commentId -> timestamp
const userActivity = new Map(); // userId -> reply timestamps[]

export function alreadyReplied(commentId) {
  cleanup();
  return repliedComments.has(commentId);
}

export function markReplied(commentId, userId) {
  repliedComments.set(commentId, Date.now());
  if (!userId) return;
  const arr = windowFor(userId);
  arr.push(Date.now());
  userActivity.set(userId, arr);
}

export function userOverLimit(userId, limit) {
  const arr = windowFor(userId);
  userActivity.set(userId, arr);
  return arr.length >= limit;
}

function windowFor(userId) {
  const now = Date.now();
  return (userActivity.get(userId) || []).filter((ts) => now - ts < WINDOW_MS);
}

function cleanup() {
  const now = Date.now();
  for (const [id, ts] of repliedComments) {
    if (now - ts > REPLY_TTL_MS) repliedComments.delete(id);
  }
}
