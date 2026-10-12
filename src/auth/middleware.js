import { validateSession, parseCookie, sessionCookie } from './sessions.js';
import { enabled } from '../db/pg.js';

/** Require a valid DB session. Attaches req.auth = { tenantId, user, roles, sessionId }. */
export async function requireAuth(req, res, next) {
  // Legacy JSON mode (no Postgres yet): keep the old single-password flow working.
  if (!enabled) return legacyAuth(req, res, next);

  const auth = await validateSession(parseCookie(req, sessionCookie));
  if (!auth) return res.redirect('/dashboard/login');
  req.auth = auth;
  next();
}

/** Require one of the given roles (e.g. requireRole('Company Admin')). */
export function requireRole(...allowed) {
  return (req, res, next) => {
    const roles = req.auth?.roles || [];
    if (allowed.some((r) => roles.includes(r))) return next();
    return res.status(403).json({ error: 'forbidden', required: allowed });
  };
}

/* ---- Legacy fallback (pre-Postgres): single shared DASHBOARD_PASSWORD cookie ---- */
import crypto from 'node:crypto';
function legacyAuth(req, res, next) {
  const pwd = process.env.DASHBOARD_PASSWORD || '';
  if (!pwd) return res.status(503).send('Dashboard disabled: set DASHBOARD_PASSWORD in env.');
  const token = parseCookie(req, 'lwc_dash');
  if (!token) return res.redirect('/dashboard/login');
  const [ts, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', pwd).update(ts || '').digest('hex').slice(0, 24);
  if (sig === expected && Date.now() - parseInt(ts, 36) < 7 * 24 * 3600 * 1000) {
    req.auth = { tenantId: null, user: { id: null, email: 'admin', name: 'Admin (legacy)' }, roles: ['Company Admin'], sessionId: null };
    return next();
  }
  return res.redirect('/dashboard/login');
}

export function makeLegacyToken() {
  const pwd = process.env.DASHBOARD_PASSWORD;
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', pwd).update(ts).digest('hex').slice(0, 24);
  return `${ts}.${sig}`;
}
