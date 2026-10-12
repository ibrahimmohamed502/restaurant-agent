/**
 * Stage 4.4 — Secure Meta Page token rotation (INSERT-only).
 *
 * Rotates the encrypted Page Access Token for an EXISTING routing channel by
 * inserting a NEW provider_credentials row (latest-wins selection makes it active).
 * Existing rows are never updated or deleted — instant rollback remains possible.
 *
 * SECURITY:
 *  - The new token is read from stdin with echo suppressed. Never via argv,
 *    never written to disk/logs, never printed, never included in errors.
 *  - Validation is GET-only — NO Facebook POST/DELETE/PUT/PATCH.
 *  - Only sanitized PASS/FAIL output. No tokens, no secrets, no plaintext values.
 *
 * Validation strategy (defense in depth):
 *   A) debug_token (app token) — type=PAGE, valid, app match, page-targeted scopes.
 *      NOTE: some Page tokens (e.g. freshly minted via /PAGE?fields=access_token)
 *      are rejected by /debug_token with "Invalid OAuth access token". For those we
 *      fall back to (B) rather than failing valid tokens.
 *   B) Live GET capability probes with the token itself:
 *        - page identity: GET /me?fields=id,name must equal ROTATE_PAGE_ID
 *        - pages_manage_engagement: GET /PAGE/blocked?limit=1
 *        - pages_read_engagement + pages_read_user_content: GET /PAGE/feed?limit=1
 *        - pages_messaging: GET /PAGE/conversations?platform=messenger&limit=1
 *      Any failed probe → FAIL CLOSED, no DB write.
 *
 * Usage (inside the app container, token typed at the hidden prompt):
 *   node scripts/rotate-meta-channel-token.mjs
 * Env overrides: ROTATE_CHANNEL_ID, ROTATE_PAGE_ID
 */
import 'dotenv/config';
import readline from 'node:readline';
import { pool, enabled } from '../src/db/pg.js';
import { encrypt } from '../src/db/crypto.js';
import { resolveMetaChannel } from '../src/services/channelResolver.js';

const CHANNEL_ID = process.env.ROTATE_CHANNEL_ID || '19002b89-9884-42fa-8388-41cebb48af86';
const PAGE_ID = process.env.ROTATE_PAGE_ID || '738688299520738';
const GRAPH_BASE = `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || 'v21.0'}`;

const REQUIRED_PAGE_SCOPES = [
  'pages_manage_engagement',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_messaging'
];

function fail(code, detail = '') {
  console.error(JSON.stringify({ result: 'FAIL', code, detail: detail ? String(detail).slice(0, 80) : '' }));
  process.exit(1);
}

if (!enabled) fail('DATABASE_URL not set (legacy mode)');
if (!process.env.ENCRYPTION_KEY) fail('ENCRYPTION_KEY not set');

const APP_ID = process.env.FB_APP_ID;
const APP_SECRET = process.env.FB_APP_SECRET;
const appToken = APP_ID && APP_SECRET ? `${APP_ID}|${APP_SECRET}` : null;

/* ---- read the new token from stdin with echo suppressed (never argv) ---- */
function readTokenFromStdin() {
  return new Promise((resolve) => {
    process.stdout.write('NEW_PAGE_TOKEN (hidden): ');
    let buf = '';
    const finish = () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause?.();
      process.stdout.write('\n');
      resolve(buf.trim());
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (ch) => {
        for (const c of String(ch)) {
          if (c === '\r' || c === '\n') return finish();
          if (c === '\u0003') process.exit(1);
          if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
          else buf += c;
        }
      });
      process.stdin.resume();
    } else {
      // piped/non-TTY stdin (docker exec without -t)
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        if (buf.includes('\n')) finish();
      });
      process.stdin.on('end', () => { if (buf.trim()) finish(); });
      process.stdin.resume();
    }
  });
}

const token = await readTokenFromStdin();
if (!token) fail('EMPTY_TOKEN');

const get = async (path, auth) => {
  try {
    const r = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${auth}` } });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch {
    return { ok: false, status: 0, j: {} };
  }
};

/* ---- 1) page identity — the token must BE the target page ---- */
const me = await get('/me?fields=id,name', token);
if (String(me.j?.id ?? '') !== String(PAGE_ID)) fail('TOKEN_NOT_FOR_TARGET_PAGE');

/* ---- 2) validation A: debug_token (if Meta accepts debug for this token) ---- */
let dbg = null;
if (appToken) {
  const r = await get(`/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`, appToken);
  const data = r.j?.data;
  if (r.ok && data) dbg = data;
}

let validationMode;
let scopeChecks;

if (dbg?.is_valid === true && dbg?.type === 'PAGE') {
  validationMode = 'debug_token';
  const scopes = Array.isArray(dbg.scopes) ? dbg.scopes : [];
  const granular = Array.isArray(dbg.granular_scopes) ? dbg.granular_scopes : [];
  const targeted = (scope) => {
    const g = granular.find((s) => s.scope === scope);
    if (g) return (g.target_ids ?? []).some((t) => String(t) === String(PAGE_ID));
    return scopes.includes(scope);
  };
  scopeChecks = Object.fromEntries(REQUIRED_PAGE_SCOPES.map((s) => [s, targeted(s)]));
} else {
  validationMode = 'capability_probes';
}

// debug_token sometimes reports incomplete/empty scope data for freshly minted
// Page tokens. Fall back to live GET capability probes before failing closed.
if (validationMode !== 'capability_probes' && REQUIRED_PAGE_SCOPES.some((s) => scopeChecks[s] !== true)) {
  validationMode = 'capability_probes(fallback_from_debug_token)';
}

if (validationMode === 'capability_probes' || validationMode.startsWith('capability_probes')) {
  const [manage, feed, conv] = await Promise.all([
    get(`/${PAGE_ID}/blocked?limit=1`, token),
    get(`/${PAGE_ID}/feed?limit=1`, token),
    get(`/${PAGE_ID}/conversations?platform=messenger&limit=1`, token)
  ]);
  scopeChecks = {
    pages_manage_engagement: manage.ok,
    pages_read_engagement: feed.ok,
    pages_read_user_content: feed.ok,
    pages_messaging: conv.ok
  };
}

const failedScopes = REQUIRED_PAGE_SCOPES.filter((s) => scopeChecks[s] !== true);
if (failedScopes.length) fail('SCOPE_MISSING', `${validationMode}:${failedScopes.join(',')}`);

/* ---- 3) verify the target channel exists, is meta routing + this page ---- */
const chRes = await pool.query(
  `SELECT id, tenant_id, provider, external_id, status FROM channels WHERE id = $1`,
  [CHANNEL_ID]
);
const channel = chRes.rows[0];
if (!channel) fail('CHANNEL_NOT_FOUND');
if (channel.provider !== 'meta') fail('CHANNEL_NOT_META_PROVIDER');
if (String(channel.external_id) !== String(PAGE_ID)) fail('CHANNEL_PAGE_MISMATCH');
if (channel.status !== 'active') fail('CHANNEL_NOT_ACTIVE');

// tenant isolation: the new credential row inherits the channel's tenant only
const tenantId = channel.tenant_id;

/* ---- 4) INSERT a new encrypted credential (never UPDATE/DELETE) ---- */
const enc = encrypt(token); // AES-256-GCM via existing src/db/crypto.js
const ins = await pool.query(
  `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv)
   VALUES ($1,$2,'page_access_token',$3,$4) RETURNING id`,
  [tenantId, CHANNEL_ID, enc.value, enc.iv]
);
const newId = ins.rows[0].id;

/* ---- 5) verify channelResolver selects the new credential ---- */
const resolved = await resolveMetaChannel(PAGE_ID, { includeCredential: true }).catch((e) => {
  fail('RESOLVER_VERIFY_FAILED', e.code ?? '');
});

const checks = {
  channelResolved: resolved?.channelId === CHANNEL_ID,
  tenantScoped: resolved?.tenantId === tenantId,
  credentialAvailable: Boolean(resolved?.credential),
  selectedIsNew: resolved?.credential === token, // in-memory compare only, never printed
  validationMode,
  prerequisiteRows: (await pool.query(
    `SELECT count(*)::int AS n FROM provider_credentials WHERE channel_id = $1 AND kind = 'page_access_token'`,
    [CHANNEL_ID]
  )).rows[0].n - 1 // rows that existed before this rotation
};

const pass = checks.channelResolved && checks.tenantScoped && checks.credentialAvailable && checks.selectedIsNew;
console.log(JSON.stringify({ result: pass ? 'PASS' : 'FAIL', channelId: CHANNEL_ID, pageId: PAGE_ID, newCredentialId: newId, checks }, null, 2));
if (!pass) process.exit(1);
await pool.end();
