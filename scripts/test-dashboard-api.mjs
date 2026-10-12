/**
 * Stage 5 dashboard API focused tests (mocked pool + queue; no network).
 * Run: node scripts/test-dashboard-api.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
import express from 'express';

let lastQuery = { sql: '', params: [] };
const rowsByPattern = [
  [/SELECT[\s\S]*FROM conversations[\s\S]*LIMIT/, { rows: [{ id: 'c1', customer_name: 'Ibrahim', provider: 'meta_comment', state: 'AI_ACTIVE', language: 'ar', last_text: 'hello', last_message_at: null, last_message_at_ts: '2026-10-09T10:00:00Z' }] }],
  [/FROM knowledge_documents/, { rows: [{ brand_id: 'b1', version: 1, updated_at: '2026-10-09T09:00:00Z' }] }],
  [/FROM ai_agents/, { rows: [{ id: 'a1', name: 'LWC AI Agent', is_active: true }] }],
  [/FROM conversations WHERE tenant_id/, { rows: [{ conversations: 6 }] }],
  [/FROM messages WHERE tenant_id/, { rows: [{ messages: 12 }] }],
  [/FROM channels WHERE tenant_id/, { rows: [{ active_channels: 3 }] }],
  [/FROM escalations WHERE tenant_id/, { rows: [{ escalations: 0 }] }]
];
const pool = {
  query: async (sql, params = []) => {
    lastQuery = { sql: sql.replace(/\s+/g, ' '), params };
    for (const [re, res] of rowsByPattern) if (re.test(sql)) return res;
    return { rows: [] };
  }
};
const queue = { getJobCounts: async () => ({ wait: 0, active: 0, completed: 3, failed: 0, delayed: 0 }) };

const { createApiV1Router } = await import('../src/api/v1/index.js');
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router({
  pool,
  getQueue: () => queue,
  validateSessionFn: async () => ({ tenantId: 'tenant-1', user: { id: 'u1', email: 'a@b.co', name: 'Admin' }, roles: ['Company Admin'] })
}));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
const H = { Cookie: 'lwc_session=t; csrf_token=c', 'x-csrf-token': 'c' };

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

console.log('\n🧪 Stage 5 dashboard API tests\n');

const res = await fetch(base + '/dashboard', { headers: H }).then(async (r) => ({ s: r.status, b: await r.json() }));
check('GET /dashboard returns the summary envelope', res.s === 200 && res.b.data.kpis.conversations === 6);
check('dashboard returns real conversations + knowledge + queue-state object',
  res.b.data.conversations[0].customerName === 'Ibrahim' &&
  res.b.data.knowledge.version === 1 &&
  typeof res.b.data.queue === 'object' &&
  'available' in res.b.data.queue);

const anon = await fetch(base + '/dashboard');
check('unauthenticated → 401', anon.status === 401);

// agent role: read allowed? dashboard is read-only summary for any authenticated user
const app2 = express();
app2.use(express.json());
app2.use('/api/v1', createApiV1Router({
  pool,
  queue,
  validateSessionFn: async () => ({ tenantId: 'tenant-2', user: { id: 'u2', email: 'a@b.co', name: 'Agent' }, roles: ['Agent'] })
}));
const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
const res2 = await fetch(`http://127.0.0.1:${srv2.address().port}/api/v1/dashboard`, { headers: H }).then(async (r) => ({ s: r.status, b: await r.json() }));
check('agent role can read the (tenant-scoped) dashboard', res2.s === 200 && res2.b.data.kpis);
check('no fabricated trend/sparkline fields in the payload', !/trend|sparkline|percent|growth/i.test(JSON.stringify(res2.b.data)));

// queue unavailable → state reported as unavailable (no fake green)
const app3 = express();
app3.use(express.json());
app3.use('/api/v1', createApiV1Router({
  pool,
  getQueue: () => null,
  validateSessionFn: async () => ({ tenantId: 'tenant-1', user: { id: 'u1' }, roles: ['Company Admin'] })
}));
const srv3 = await new Promise((r) => { const s = app3.listen(0, '127.0.0.1', () => r(s)); });
const res3 = await fetch(`http://127.0.0.1:${srv3.address().port}/api/v1/dashboard`, { headers: H }).then(async (r) => ({ s: r.status, b: await r.json() }));
check('no Redis → queue reported unavailable (not healthy)', res3.b.data.queue.available === false);

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
srv.close(); srv2.close(); srv3.close();
process.exit(failed === 0 ? 0 : 1);
