/**
 * Admin dashboard — Stage 2: real auth (DB sessions + RBAC) with legacy fallback.
 *   GET  /dashboard/login     → login page (email+password; single password in legacy mode)
 *   POST /dashboard/login     → creates DB session (or legacy cookie)
 *   GET  /dashboard/logout
 *   GET  /dashboard           → main panel (RTL, auto-refresh, Team tab for admins)
 *   GET  /dashboard/api/me
 *   GET  /dashboard/api/stats · /events · /escalations · POST .../escalations/:id/resolve
 */
import express from 'express';
import { getStats, listEvents, listEscalations, resolveEscalation } from './db.js';
import { enabled, pool } from './db/pg.js';
import { requireAuth, makeLegacyToken } from './auth/middleware.js';
import { createSession, revokeSession, sessionCookie } from './auth/sessions.js';
import { verifyPassword } from './auth/passwords.js';
import { lockedSeconds, recordFailedLogin, resetLoginAttempts } from './auth/ratelimit.js';
import { audit } from './auth/audit.js';

export const dashboardRouter = express.Router();

/* --------------------------------- login --------------------------------- */

dashboardRouter.get('/dashboard/login', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول — LWC Dashboard</title>
<style>${BASE_CSS}</style></head><body class="center">
<form class="card login" method="POST" action="/dashboard/login">
  <div class="logo">🍫</div>
  <h1>Life with Cacao</h1><p class="muted">لوحة تحكم الـ AI Agent</p>
  ${enabled ? `
  <input type="email" name="email" placeholder="البريد الإلكتروني" autocomplete="username" required>
  <input type="password" name="password" placeholder="كلمة السر" autocomplete="current-password" required>` : `
  <input type="password" name="legacy_password" placeholder="كلمة السر" autofocus required>`}
  <button type="submit">دخول</button>
</form></body></html>`);
});

dashboardRouter.post('/dashboard/login', express.urlencoded({ extended: false }), async (req, res) => {
  // Legacy mode (no Postgres yet): single shared password
  if (!enabled) {
    const ok = req.body.legacy_password === (process.env.DASHBOARD_PASSWORD || '');
    if (!ok) return res.redirect('/dashboard/login?e=1');
    res.cookie('lwc_dash', makeLegacyToken(), { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    return res.redirect('/dashboard');
  }

  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  if (!email || !password) return res.redirect('/dashboard/login?e=1');

  const locked = await lockedSeconds(email, req.ip);
  if (locked > 0) {
    audit({ action: 'auth.login.locked', objectType: 'user', ip: req.ip, metadata: { email, locked } });
    return res.type('html').send(`<html lang="ar" dir="rtl"><body style="font-family:sans-serif;display:grid;place-items:center;min-height:100vh;background:#f4f1ec"><div style="background:#fff;padding:30px;border-radius:14px;text-align:center">⏳ محاولات كتير غلط — جرب تاني بعد <b>${Math.ceil(locked / 60)}</b> دقيقة<br><br><a href="/dashboard/login">رجوع</a></div></body></html>`);
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.password_hash, u.status,
            COALESCE(json_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '[]') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.email = $1 GROUP BY u.id`,
    [email]
  );
  const user = rows[0];

  if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
    await recordFailedLogin(email, req.ip);
    audit({ action: 'auth.login.fail', objectType: 'user', ip: req.ip, metadata: { email } });
    return res.redirect('/dashboard/login?e=1');
  }

  await resetLoginAttempts(email, req.ip);
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  const { token, expiresAt } = await createSession({
    tenantId: user.tenant_id,
    userId: user.id,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  audit({ tenantId: user.tenant_id, actorUserId: user.id, action: 'auth.login.success', objectType: 'user', objectId: user.id, ip: req.ip });
  res.cookie(sessionCookie, token, { httpOnly: true, sameSite: 'lax', maxAge: expiresAt.getTime() - Date.now() });
  res.redirect('/dashboard');
});

dashboardRouter.get('/dashboard/logout', async (req, res) => {
  const { sessionCookie: cookie } = await import('./auth/sessions.js');
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((p) => p.trim()).find((p) => p.startsWith(cookie + '='));
  if (match) await revokeSession(decodeURIComponent(match.slice(cookie.length + 1)));
  res.clearCookie(cookie);
  res.clearCookie('lwc_dash');
  res.redirect('/dashboard/login');
});

/* ---------------------------------- API ---------------------------------- */

dashboardRouter.get('/dashboard/api/me', requireAuth, (req, res) => {
  res.json({ user: req.auth.user, roles: req.auth.roles });
});

dashboardRouter.get('/dashboard/api/stats', requireAuth, (_req, res) => res.json(getStats()));
dashboardRouter.get('/dashboard/api/events', requireAuth, (req, res) => {
  res.json(listEvents(Math.min(Number(req.query.limit) || 50, 200)));
});
dashboardRouter.get('/dashboard/api/escalations', requireAuth, (_req, res) => res.json(listEscalations()));
dashboardRouter.post('/dashboard/api/escalations/:id/resolve', requireAuth, async (req, res) => {
  const ok = resolveEscalation(req.params.id);
  if (ok) audit({ tenantId: req.auth.tenantId, actorUserId: req.auth.user.id, action: 'escalations.resolve', objectType: 'escalation', objectId: req.params.id, ip: req.ip });
  res.json({ ok });
});

/* ------------------------------ main page ------------------------------ */

dashboardRouter.get('/dashboard', requireAuth, (req, res) => {
  const isAdmin = req.auth.roles.includes('Company Admin');
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LWC — AI Agent Dashboard</title>
<style>${BASE_CSS}</style></head><body>
<header>
  <div class="brand">🍫 Life with Cacao <span class="muted">· AI Agent Dashboard</span></div>
  <div class="hdr-right">
    <span class="who">${req.auth.user.name} · ${req.auth.roles.join(', ')}</span>
    <span id="live" class="dot"></span>
    <a class="muted" href="/dashboard/logout">خروج</a>
  </div>
</header>

<main>
  <section class="cards" id="cards"></section>

  <nav class="tabs">
    <button class="tab active" data-tab="events">📜 سجل النشاط</button>
    <button class="tab" data-tab="esc">🚨 التصعيدات <span id="escBadge" class="badge hidden"></span></button>
    ${isAdmin ? '<button class="tab" data-tab="team">👥 الفريق</button>' : ''}
  </nav>

  <section id="events" class="panel"></section>
  <section id="esc" class="panel hidden"></section>
  ${isAdmin ? `
  <section id="team" class="panel hidden">
    <div class="card" style="text-align:right;margin-bottom:14px">
      <h3 style="margin-bottom:10px">➕ إضافة موظف</h3>
      <form id="addUserForm" class="addform">
        <input name="email" type="email" placeholder="البريد الإلكتروني" required>
        <input name="name" placeholder="الاسم" required>
        <input name="password" type="password" placeholder="كلمة سر (8+ أحرف)" minlength="8" required>
        <label><input type="checkbox" name="role" value="Company Admin"> Admin</label>
        <label><input type="checkbox" name="role" value="Supervisor" checked> Supervisor</label>
        <label><input type="checkbox" name="role" value="Agent"> Agent</label>
        <button type="submit">إضافة</button>
      </form>
      <div id="addUserMsg" class="muted"></div>
    </div>
    <div id="usersList"></div>
  </section>` : ''}
</main>

<script>
const IS_ADMIN = ${isAdmin};
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

/* ------------------------------ team tab ------------------------------ */
async function loadUsers() {
  if (!IS_ADMIN) return;
  const users = await fetch('/dashboard/api/users').then(r => r.json());
  $('#usersList').innerHTML = users.map(u => \`
    <div class="row \${u.status === 'disabled' ? 'done' : ''}">
      <div class="meta">
        <b>\${esc(u.name)}</b> · \${esc(u.email)} ·
        \${u.roles.map(r => \`<span class="tag">\${esc(r)}</span>\`).join('')}
        \${u.status === 'disabled' ? '<span class="tag red">معطّل</span>' : '<span class="tag green">نشط</span>'}
      </div>
      <button class="resolve" style="background:\${u.status === 'disabled' ? '#2e9e5b' : '#b02a20'}"
        onclick="toggleUser('\${u.id}', '\${u.status === 'disabled' ? 'active' : 'disabled'}', this)">
        \${u.status === 'disabled' ? 'تفعيل' : 'تعطيل'}
      </button>
    </div>\`).join('') || '<p class="muted pad">لا يوجد موظفين.</p>';
}

async function toggleUser(id, status, btn) {
  btn.disabled = true;
  await fetch('/dashboard/api/users/' + id + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
  });
  loadUsers();
}

if (IS_ADMIN) {
  $('#addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const roles = [...f.querySelectorAll('input[name="role"]:checked')].map(c => c.value);
    const r = await fetch('/dashboard/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.email.value, name: f.name.value, password: f.password.value, roles })
    });
    const d = await r.json();
    $('#addUserMsg').textContent = r.ok ? '✅ اتضاف بنجاح' : ('❌ ' + (d.error || 'فشل'));
    if (r.ok) { f.reset(); loadUsers(); }
  });
  loadUsers();
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
header { background: #4a2c17; color: #fff; padding: 14px 22px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
header a { color: #d9c3a5; text-decoration: none; font-size: 14px; }
.brand { font-weight: 700; } .muted { color: #a08b74; font-weight: 400; font-size: 13px; }
.hdr-right { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.who { color: #e8d9c5; }
main { max-width: 980px; margin: 22px auto; padding: 0 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.card { background: #fff; border-radius: 14px; padding: 16px; text-align: center; box-shadow: 0 1px 4px #0001; }
.card.alert { background: #fdecea; border: 1px solid #e8b4ac; }
.num { font-size: 24px; font-weight: 800; color: #4a2c17; }
.lbl { font-size: 12px; color: #a08b74; margin-top: 4px; }
.tabs { display: flex; gap: 8px; margin: 18px 0 12px; flex-wrap: wrap; }
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
.addform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.addform input[type="email"], .addform input[type="text"], .addform input[type="password"], .addform input:not([type]) {
  padding: 9px; border: 1px solid #d8c9b5; border-radius: 8px; font-size: 14px; min-width: 150px;
}
.addform label { font-size: 13px; display: flex; gap: 4px; align-items: center; }
.addform button { padding: 9px 16px; border: none; background: #4a2c17; color: #fff; border-radius: 8px; font-weight: 700; cursor: pointer; }
`;
