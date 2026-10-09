/**
 * Stage 5 routing fix — UI proxy tests (no network; upstream is stubbed).
 * Run: node scripts/test-ui-proxy.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
import express from 'express';
import http from 'node:http';
import { uiProxyMiddleware } from '../src/uiProxy.js';

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

/* fake upstream that records the request and returns a marker body */
let upstreamHits = [];
const upstream = http.createServer((req, res) => {
  upstreamHits.push({ method: req.method, url: req.url, host: req.headers.host });
  res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'lwc_session=abc; Path=/; HttpOnly' });
  res.end('NEXTJS_UI');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const app = express();
app.use(uiProxyMiddleware({ upstream: upstreamUrl }));
app.get('/webhook', (_req, res) => res.status(403).send('EXPRESS_WEBHOOK'));
app.get('/api/v1/_health', (_req, res) => res.json({ data: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/legacy/dashboard', (_req, res) => res.send('LEGACY_DASHBOARD'));
app.get('/privacy', (_req, res) => res.send('PRIVACY'));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
const get = async (p) => { const r = await fetch(base + p, { redirect: 'manual' }); return { s: r.status, t: await r.text(), cookie: r.headers.get('set-cookie') }; };

console.log('\n🧪 Stage 5 UI routing tests\n');

for (const p of ['/', '/login', '/dashboard', '/knowledge', '/inbox', '/companies', '/_next/static/x.js']) {
  const r = await get(p);
  check(`UI route proxied to Next.js: ${p}`, r.s === 200 && r.t === 'NEXTJS_UI');
}
for (const p of ['/webhook', '/api/v1/_health', '/health', '/privacy']) {
  const r = await get(p);
  check(`backend path stays on Express: ${p}`, r.t !== 'NEXTJS_UI');
}
const legacy = await get('/legacy/dashboard');
check('legacy dashboard still reachable at /legacy/*', legacy.t === 'LEGACY_DASHBOARD');
const cookie = await get('/login');
check('Set-Cookie forwarded through the proxy (session/CSRF intact)', /lwc_session=abc/.test(cookie.cookie ?? ''));
check('proxy preserves the upstream Host header', upstreamHits.every((h) => h.host.startsWith('127.0.0.1:')));

// POST body path (login POST goes to /api, but verify generic proxying works)
const post = await fetch(base + '/login', { method: 'POST', body: 'a=1' }).then(async (r) => ({ s: r.status, t: await r.text() }));
check('proxied POST works', post.s === 200 && post.t === 'NEXTJS_UI');

// no upstream configured → pure legacy fallback (no crash, next() called)
const app2 = express();
app2.use(uiProxyMiddleware({ upstream: undefined }));
app2.get('/knowledge', (_req, res) => res.send('LEGACY_FALLBACK'));
const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
const fb = await fetch(`http://127.0.0.1:${srv2.address().port}/knowledge`).then((r) => r.text());
check('no WEB_UPSTREAM → legacy fallback unchanged', fb === 'LEGACY_FALLBACK');

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
upstream.close(); srv.close(); srv2.close();
process.exit(failed === 0 ? 0 : 1);
