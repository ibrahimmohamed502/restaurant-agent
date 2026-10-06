/**
 * Admin dashboard — password-protected, zero-dependency, server-rendered.
 *   GET  /dashboard/login     → login page
 *   POST /dashboard/login     → sets signed cookie
 *   GET  /dashboard           → main panel (Arabic RTL, auto-refresh)
 *   GET  /dashboard/api/stats
 *   GET  /dashboard/api/events
 *   GET  /dashboard/api/escalations
 *   POST /dashboard/api/escalations/:id/resolve
 *   GET  /dashboard/logout
 */
import crypto from 'node:crypto';
import express from 'express';
import { getStats, listEvents, listEscalations, resolveEscalation } from './db.js';

export const dashboardRouter = express.Router();

const COOKIE = 'lwc_dash';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function secret() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function makeToken() {
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', secret()).update(ts).digest('hex').slice(0, 24);
  return `${ts}.${sig}`;
}

function tokenValid(token) {
  if (!token || !secret()) return false;
  const [ts, sig] = token.split('.');
  if (!ts || !sig) return false;
  const expected = crypto.createHmac('sha256', secret()).update(ts).digest('hex').slice(0, 24);
  if (sig !== expected) return false;
  return Date.now() - parseInt(ts, 36) < TOKEN_TTL_MS;
}

/** Minimal cookie reader — avoids the cookie-parser dependency. */
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function auth(req, res, next) {
  if (!secret()) {
    return res.status(503).send('Dashboard disabled: set DASHBOARD_PASSWORD in env.');
  }
  if (tokenValid(getCookie(req, COOKIE))) return next();
  return res.redirect('/dashboard/login');
}

/* ------------------------------- auth pages ------------------------------- */

dashboardRouter.get('/dashboard/login', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول — LWC Dashboard</title>
<style>${BASE_CSS}</style></head><body class="center">
<form class="card login" method="POST" action="/dashboard/login">
  <div class="logo">🍫</div>
  <h1>Life with Cacao</h1><p class="muted">لوحة تحكم الـ AI Agent</p>
  <input type="password" name="password" placeholder="كلمة السر" autofocus required>
  <button type="submit">دخول</button>
</form></body></html>`);
});

dashboardRouter.post('/dashboard/login', express.urlencoded({ extended: false }), (req, res) => {
  const ok = secret() && req.body.password === secret();
  if (!ok) return res.redirect('/dashboard/login?e=1');
  res.cookie(COOKIE, makeToken(), { httpOnly: true, sameSite: 'lax', maxAge: TOKEN_TTL_MS });
  res.redirect('/dashboard');
});

dashboardRouter.get('/dashboard/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.redirect('/dashboard/login');
});

/* --------------------------------------------------------------------- */

/* --------------------------------- API ---------------------------------- */

dashboardRouter.get('/dashboard/api/stats', auth, (_req, res) => res.json(getStats()));
dashboardRouter.get('/dashboard/api/events', auth, (req, res) => {
  res.json(listEvents(Math.min(Number(req.query.limit) || 50, 200)));
});
dashboardRouter.get('/dashboard/api/escalations', auth, (_req, res) => res.json(listEscalations()));
dashboardRouter.post('/dashboard/api/escalations/:id/resolve', auth, (req, res) => {
  res.json({ ok: resolveEscalation(req.params.id) });
});

/* ------------------------------ main page ------------------------------- */

dashboardRouter.get('/dashboard', auth, (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LWC — AI Agent Dashboard</title>
<style>${BASE_CSS}</style></head><body>
<header>
  <div class="brand">🍫 Life with Cacao <span class="muted">· AI Agent Dashboard</span></div>
  <div><span id="live" class="dot"></span><a class="muted" href="/dashboard/logout">خروج</a></div>
</header>

<main>
  <section class="cards" id="cards"></section>

  <nav class="tabs">
    <button class="tab active" data-tab="events">📜 سجل النشاط</button>
    <button class="tab" data-tab="esc">🚨 التصعيدات <span id="escBadge" class="badge hidden"></span></button>
  </nav>

  <section id="events" class="panel"></section>
  <section id="esc" class="panel hidden"></section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const fmtTime = (ts) => new Date(ts).toLocaleString('en-GB', { hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const chan = (c) => c === 'messenger' ? '💬 DM' : '💭 تعليق';

async function load() {
  const [stats, events, escs] = await Promise.all([
    fetch('/dashboard/api/stats').then(r => r.json()),
    fetch('/dashboard/api/events?limit=50').then(r => r.json()),
    fetch('/dashboard/api/escalations').then(r => r.json())
  ]);

  $('#cards').innerHTML = \`
    <div class="card"><div class="num">\${stats.today.total}</div><div class="lbl">تفاعلات اليوم</div></div>
    <div class="card"><div class="num">\${stats.today.comments}</div><div class="lbl">تعليقات</div></div>
    <div class="card"><div class="num">\${stats.today.dms}</div><div class="lbl">رسايل DM</div></div>
    <div class="card \${stats.newEscalations ? 'alert' : ''}"><div class="num">\${stats.newEscalations}</div><div class="lbl">تصعيدات جديدة</div></div>
    <div class="card"><div class="num">\${stats.byIntent.slice(0,2).map(([i,n]) => n + '× ' + i).join('<br>') || '—'}</div><div class="lbl">أكثر النوايا</div></div>\`;

  const newCount = escs.filter(x => x.status === 'new').length;
  const badge = $('#escBadge');
  badge.textContent = newCount;
  badge.classList.toggle('hidden', !newCount);

  $('#events').innerHTML = events.map(e => \`
    <div class="row \${e.escalate ? 'esc' : ''}">
      <div class="meta"><b>\${chan(e.channel)}</b> · \${esc(e.customerName)} · \${fmtTime(e.ts)}
        <span class="tag">\${esc(e.intent)}</span> <span class="tag">\${e.lang}</span>
        \${e.escalate ? '<span class="tag red">🚨 تصعيد</span>' : ''}</div>
      <div class="msg">👤 \${esc(e.message) || '<i>(بدون نص)</i>'}</div>
      <div class="reply">🤖 \${esc(e.reply)}</div>
    </div>\`).join('') || '<p class="muted pad">لا يوجد نشاط بعد.</p>';

  $('#esc').innerHTML = escs.map(x => \`
    <div class="row \${x.status === 'done' ? 'done' : 'esc'}">
      <div class="meta"><b>\${chan(x.channel)}</b> · \${esc(x.customerName)} · \${fmtTime(x.ts)}
        <span class="tag red">\${esc(x.reason)}</span> \${x.status === 'done' ? '<span class="tag green">✅ تم</span>' : ''}</div>
      <div class="msg">👤 \${esc(x.message) || '<i>(بدون نص)</i>'}</div>
      <div class="reply">🤖 \${esc(x.reply)}</div>
      \${x.status === 'new' ? \`<button class="resolve" onclick="resolveEsc('\${x.id}', this)">تم التواصل ✅</button>\` : ''}
    </div>\`).join('') || '<p class="muted pad">لا تصعيدات — كل شيء تمام 🎉</p>';
}

async function resolveEsc(id, btn) {
  btn.disabled = true;
  await fetch('/dashboard/api/escalations/' + id + '/resolve', { method: 'POST' });
  load();
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  $('#' + t.dataset.tab).classList.remove('hidden');
}));

load();
setInterval(load, 15000);
</script>
</body></html>`);
});

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; font-family: 'Segoe UI', Tahoma, sans-serif; }
body { background: #f4f1ec; color: #2b2118; min-height: 100vh; }
body.center { display: grid; place-items: center; }
header { background: #4a2c17; color: #fff; padding: 14px 22px; display: flex; justify-content: space-between; align-items: center; }
header a { color: #d9c3a5; text-decoration: none; font-size: 14px; }
.brand { font-weight: 700; } .muted { color: #a08b74; font-weight: 400; font-size: 13px; }
main { max-width: 980px; margin: 22px auto; padding: 0 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.card { background: #fff; border-radius: 14px; padding: 16px; text-align: center; box-shadow: 0 1px 4px #0001; }
.card.alert { background: #fdecea; border: 1px solid #e8b4ac; }
.num { font-size: 24px; font-weight: 800; color: #4a2c17; }
.lbl { font-size: 12px; color: #a08b74; margin-top: 4px; }
.tabs { display: flex; gap: 8px; margin: 18px 0 12px; }
.tab { border: none; background: #e8dfd2; padding: 9px 16px; border-radius: 999px; cursor: pointer; font-weight: 600; }
.tab.active { background: #4a2c17; color: #fff; }
.badge { background: #d93025; color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.row { background: #fff; border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; box-shadow: 0 1px 3px #0001; border-right: 4px solid #c9b8a3; }
.row.esc { border-right-color: #d93025; }
.row.done { opacity: .55; border-right-color: #2e9e5b; }
.meta { font-size: 12px; color: #8d7a64; margin-bottom: 6px; }
.tag { background: #efe6da; border-radius: 6px; padding: 1px 7px; margin-right: 4px; }
.tag.red { background: #fbd9d4; color: #b02a20; } .tag.green { background: #d7f0e0; color: #1e7a44; }
.msg { font-size: 14px; margin: 4px 0; white-space: pre-wrap; }
.reply { font-size: 14px; color: #5c4632; background: #faf6ef; border-radius: 8px; padding: 8px 10px; margin-top: 6px; white-space: pre-wrap; }
.resolve { margin-top: 8px; border: none; background: #2e9e5b; color: #fff; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.hidden { display: none !important; }
.pad { padding: 20px; text-align: center; }
.dot::before { content: '●'; color: #37d67a; margin-left: 6px; font-size: 12px; }
.login { width: 320px; display: grid; gap: 12px; }
.login .logo { font-size: 44px; } .login h1 { font-size: 20px; color: #4a2c17; }
.login input { padding: 12px; border: 1px solid #d8c9b5; border-radius: 10px; font-size: 15px; }
.login button { padding: 12px; border: none; background: #4a2c17; color: #fff; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; }
`;
