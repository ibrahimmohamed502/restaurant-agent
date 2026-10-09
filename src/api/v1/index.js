/**
 * Stage 5.0 — /api/v1 foundation.
 *
 * Versioned API surface that REUSES the existing authentication (DB sessions +
 * bcrypt), RBAC and rate-limiting. No second auth system, no schema changes.
 *
 * Contracts:
 *   success → { data: ... }
 *   error   → { error: { code, message, details? } }   (never internal stack traces)
 * Mutations require a CSRF token: header `x-csrf-token` must match cookie `csrf_token`.
 * Tenant context ALWAYS derives from the authenticated session — never from the client.
 */
import express from 'express';
import crypto from 'node:crypto';
import { validateSession, createSession, revokeSession, sessionCookie, parseCookie } from '../../auth/sessions.js';
import { verifyPassword } from '../../auth/passwords.js';
import { lockedSeconds, recordFailedLogin, resetLoginAttempts } from '../../auth/ratelimit.js';

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* ------------------------------- errors ------------------------------- */
export function apiError(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------- CORS ------------------------------- */
export function corsMiddleware({ origins = [] } = {}) {
  const allow = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-csrf-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

/* ------------------------------- security headers ------------------------------- */
export function securityHeaders() {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    next();
  };
}

/* ------------------------------- CSRF ------------------------------- */
export function csrfGuard(req, res, next) {
  // ensure a csrf cookie exists for the browser to read (double-submit)
  if (!parseCookie(req, CSRF_COOKIE)) {
    const token = crypto.randomBytes(24).toString('hex');
    res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  }
  if (!MUTATIONS.has(req.method)) return next();
  const cookie = parseCookie(req, CSRF_COOKIE);
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || cookie.length !== header.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    return apiError(res, 403, 'CSRF_INVALID', 'invalid or missing CSRF token');
  }
  next();
}

/* ------------------------------- validation ------------------------------- */
const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
export function validate(body, rules) {
  const out = {};
  const errors = {};
  for (const [field, rule] of Object.entries(rules)) {
    const value = body?.[field];
    if (rule.required && (value === undefined || value === null || value === '')) { errors[field] = 'required'; continue; }
    if (value === undefined || value === null || value === '') { if (rule.default !== undefined) out[field] = rule.default; continue; }
    if (rule.type === 'email' && !isEmail(value)) { errors[field] = 'invalid_email'; continue; }
    if (rule.type === 'string') {
      const s = String(value).trim();
      if (rule.min && s.length < rule.min) { errors[field] = 'too_short'; continue; }
      if (rule.max && s.length > rule.max) { errors[field] = 'too_long'; continue; }
      out[field] = s;
      continue;
    }
    out[field] = value;
  }
  if (Object.keys(errors).length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'invalid request payload', errors);
  }
  return out;
}

/* ------------------------------- tenant context ------------------------------- */
/** Attaches req.v1 = { tenantId, user, roles } from the session. 403 when absent. */
export async function requireV1Auth(req, res, next) {
  try {
    const validate = req.validateSession || validateSession;
    const token = parseCookie(req, sessionCookie);
    const auth = token ? await validate(token) : null;
    if (!auth) return apiError(res, 401, 'UNAUTHENTICATED', 'authentication required');
    if (!auth.tenantId) return apiError(res, 403, 'TENANT_REQUIRED', 'no tenant context on session');
    req.v1 = { tenantId: auth.tenantId, user: auth.user, roles: auth.roles || [] };
    next();
  } catch {
    return apiError(res, 401, 'UNAUTHENTICATED', 'authentication required');
  }
}

export function requireV1Role(...allowed) {
  return (req, res, next) => {
    const roles = req.v1?.roles || [];
    if (!allowed.some((r) => roles.includes(r))) return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    next();
  };
}

/* ------------------------------- router factory ------------------------------- */
export function createApiV1Router(deps = {}) {
  const {
    pool,
    createSessionFn = createSession,
    revokeSessionFn = revokeSession,
    validateSessionFn = validateSession,
    verifyPasswordFn = verifyPassword,
    lockedSecondsFn = lockedSeconds,
    recordFailedLoginFn = recordFailedLogin,
    resetLoginAttemptsFn = resetLoginAttempts,
    corsOrigins = (process.env.API_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  } = deps;

  const router = express.Router();
  router.use(securityHeaders());
  router.use(corsMiddleware({ origins: corsOrigins }));
  router.use(express.json({ limit: '32kb' }));
  router.use(csrfGuard);
  router.use((req, _res, next) => { req.db = pool; req.validateSession = validateSessionFn; next(); });

  /* ------------------------------ auth ------------------------------ */
  router.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = validate(req.body, {
        email: { required: true, type: 'email' },
        password: { required: true, type: 'string', min: 1, max: 200 }
      });
      const ip = req.ip || 'unknown';
      const locked = await lockedSecondsFn(email, ip);
      if (locked > 0) {
        res.setHeader('Retry-After', String(locked));
        return apiError(res, 429, 'RATE_LIMITED', 'too many attempts, try again later');
      }
      const { rows } = await pool.query(
        `SELECT u.id, u.tenant_id, u.email, u.name, u.password_hash, u.is_active,
                COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           LEFT JOIN roles r ON r.id = ur.role_id
          WHERE u.email = $1
          GROUP BY u.id`,
        [email]
      );
      const user = rows[0];
      // identical response for unknown email / wrong password / inactive account
      const invalid = () => apiError(res, 401, 'INVALID_CREDENTIALS', 'invalid email or password');
      if (!user || !user.is_active || !(await verifyPasswordFn(password, user.password_hash))) {
        await recordFailedLoginFn(email, ip);
        return invalid();
      }
      await resetLoginAttemptsFn(email, ip);
      const token = await createSessionFn({ tenantId: user.tenant_id, userId: user.id, ip, userAgent: req.get('user-agent') || '' });
      res.cookie(sessionCookie, token, {
        httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
        path: '/', maxAge: 1000 * 60 * 60 * 12
      });
      return res.json({ data: { user: sanitizeUser(user), tenantId: user.tenant_id } });
    } catch (err) {
      if (err instanceof ApiError) return apiError(res, err.status, err.code, err.message, err.details);
      console.error('api/v1 login failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  router.post('/auth/logout', async (req, res) => {
    const token = parseCookie(req, sessionCookie);
    if (token) await revokeSessionFn(token).catch(() => {});
    res.clearCookie(sessionCookie, { path: '/' });
    return res.json({ data: { ok: true } });
  });

  router.get('/auth/me', async (req, res) => {
    const token = parseCookie(req, sessionCookie);
    const auth = token ? await validateSessionFn(token) : null;
    if (!auth) return apiError(res, 401, 'UNAUTHENTICATED', 'authentication required');
    return res.json({ data: { user: sanitizeUser({ ...auth.user, roles: auth.roles }), tenantId: auth.tenantId, roles: auth.roles || [] } });
  });

  /* ------------------------------ protected sample (tenant-scoped) ------------------------------ */
  router.get('/tenants/current', requireV1Auth, async (req, res) => {
    const { rows } = await pool.query(`SELECT id, name, slug FROM tenants WHERE id = $1`, [req.v1.tenantId]);
    if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'tenant not found');
    return res.json({ data: { id: rows[0].id, name: rows[0].name, slug: rows[0].slug } });
  });

  router.get('/_health', (_req, res) => res.json({ data: { status: 'ok' } }));

  // error envelope for anything unexpected
  router.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return apiError(res, err.status, err.code, err.message, err.details);
    if (err?.type === 'entity.parse.failed') return apiError(res, 400, 'BAD_JSON', 'malformed JSON body');
    console.error('api/v1 error:', err?.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  });

  return router;
}

function sanitizeUser(user) {
  return { id: user.id, email: user.email, name: user.name ?? null, roles: user.roles ?? [] };
}
