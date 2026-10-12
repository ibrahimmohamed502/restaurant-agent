/**
 * Stage 5 routing fix — serve the Next.js SaaS frontend through the Express app.
 *
 * The public Cloudflare tunnel keeps pointing at this service (unchanged
 * hostname, so the Meta webhook callback keeps working), while browser UI
 * routes are proxied to the Next.js web container. Backend paths
 * (/webhook, /api/*, /health, /privacy, /legacy/*) stay on Express.
 *
 * If WEB_UPSTREAM is not configured the middleware is a no-op, so the previous
 * legacy behavior remains the safe fallback.
 */
import http from 'node:http';
import { URL } from 'node:url';

/** Browser routes owned by the Next.js SaaS frontend. */
const UI_ROUTES = [
  '/',
  '/login',
  '/dashboard',
  '/knowledge',
  '/inbox',
  '/customers',
  '/companies',
  '/brands',
  '/channels',
  '/ai',
  '/team',
  '/integrations',
  '/audit',
  '/settings',
  '/_next',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/robots.txt'
];

function isUiRoute(pathname) {
  if (pathname === '/') return true;
  return UI_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

export function uiProxyMiddleware({ upstream, skip } = {}) {
  if (!upstream || skip?.()) return (req, res, next) => next();

  const target = new URL(upstream);

  return (req, res, next) => {
    if (!isUiRoute(req.path)) return next();

    const headers = { ...req.headers, host: target.host };
    const upstreamReq = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: req.originalUrl,
        method: req.method,
        headers
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on('error', (err) => {
      console.error('⚠️ UI proxy error:', err.message);
      if (!res.headersSent) res.status(502).send('SaaS UI temporarily unavailable');
      else res.end();
    });
    req.pipe(upstreamReq);
  };
}
