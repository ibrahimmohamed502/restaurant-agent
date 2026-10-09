/* Targeted Stage 5 API checks (mocked pool; no network, no DB). */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
import express from 'express';

const rows = {
  sources: [{ id: 'src1', tenant_id: 't1', brand_id: 'b1', kind: 'menu', title: 'LWC KB' }],
  documents: [{ id: 'doc1', source_id: 'src1', version: 3, status: 'published', structured: { restaurantName: 'LWC', menus: { A: { B: [{ name: 'X', price: '1.000' }] } } } }],
  drafts: [],
  history: []
};

const pool = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/FROM knowledge_sources/.test(s)) return { rows: params[1] ? rows.sources.filter((r) => r.brand_id === params[1]) : rows.sources };
    if (/FROM knowledge_documents d/.test(s)) return { rows: rows.documents.filter((d) => d.status === 'published') };
    if (/FROM knowledge_drafts/.test(s)) return { rows: rows.drafts };
    if (/FROM knowledge_publications/.test(s)) return { rows: rows.history };
    if (/INSERT INTO knowledge_drafts/.test(s)) {
      const row = { id: 'draft1', source_id: params[1], base_version: params[2], content: JSON.parse(params[3]), status: 'editing', updated_at: new Date().toISOString() };
      rows.drafts.push(row);
      return { rows: [row] };
    }
    if (/UPDATE knowledge_drafts SET content/.test(s)) {
      const row = rows.drafts[0];
      if (row) { row.content = JSON.parse(params[0]); row.base_version = params[1]; row.status = 'editing'; }
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE knowledge_drafts SET status = 'discarded'/.test(s)) {
      const row = rows.drafts.find((d) => d.status === 'editing');
      if (row) row.status = 'discarded';
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE knowledge_drafts SET status = 'published'/.test(s)) {
      const row = rows.drafts[0]; if (row) { row.status = 'published'; row.base_version = params[0]; }
      return { rows: [] };
    }
    if (/COALESCE\(MAX\(version\)/.test(s)) return { rows: [{ max_version: rows.documents[0].version }] };
    if (/UPDATE knowledge_documents SET status = 'archived'/.test(s)) { rows.documents.forEach((d) => { if (d.status === 'published') d.status = 'archived'; }); return { rows: [] }; }
    if (/INSERT INTO knowledge_documents/.test(s)) {
      const row = { id: 'doc2', source_id: params[1], version: params[4], status: 'published', structured: JSON.parse(params[3]) };
      rows.documents.push(row);
      return { rows: [{ id: row.id, version: row.version }] };
    }
    if (/INSERT INTO knowledge_publications/.test(s)) { rows.history.unshift({ version: params[3], created_at: new Date().toISOString(), published_by_name: 'Admin' }); return { rows: [] }; }
    if (/UPDATE knowledge_drafts SET status = 'published'/.test(s)) return { rows: [] };
    return { rows: [] };
  },
  connect: async () => ({
    query: async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/BEGIN|COMMIT|ROLLBACK/.test(s)) return { rows: [] };
      return pool.query(sql, params);
    },
    release: () => undefined
  })
};

const { createApiV1Router } = await import('../src/api/v1/index.js');
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router({ pool, validateSessionFn: async () => ({ tenantId: 't1', user: { id: 'u1', email: 'a@b.co', name: 'Admin' }, roles: ['Company Admin'] }) }));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
const CSRF = 'test-csrf-token';
const get = async (p, o) => { const r = await fetch(base + p, { ...(o ?? {}), headers: { Cookie: 'lwc_session=test; csrf_token=' + CSRF, 'x-csrf-token': CSRF, ...(o?.body ? { 'Content-Type': 'application/json' } : {}), ...((o?.headers) ?? {}) } }); return { status: r.status, body: await r.json() }; };

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

console.log('\n🧪 Stage 5 knowledge API checks (mocked)\n');

const list = await get('/knowledge');
check('GET /knowledge returns published knowledge + permissions', list.status === 200 && list.body.data.published.version === 3 && list.body.data.permissions.canPublish === true);

const created = await get('/knowledge/draft', { method: 'POST' });
check('POST /knowledge/draft creates a draft from the published version', created.status === 200 && created.body.data.created === true && created.body.data.draft.baseVersion === 3);

const saved = await get('/knowledge/draft', { method: 'PUT', body: JSON.stringify({ content: { restaurantName: 'LWC2', menus: { A: { B: [{ name: 'X', price: '2.000' }] } } }, baseVersion: 3 }) });
check('PUT /knowledge/draft saves and returns validation', saved.status === 200 && saved.body.data.validation.ok === true);

const stale = await get('/knowledge/draft', { method: 'PUT', body: JSON.stringify({ content: { restaurantName: 'LWC3' }, baseVersion: 1 }) });
check('PUT with stale baseVersion → 409 STALE_DRAFT (concurrency)', stale.status === 409 && stale.body.error.code === 'STALE_DRAFT');

const invalid = await get('/knowledge/draft', { method: 'PUT', body: JSON.stringify({ content: { restaurantName: '', menus: { A: { B: [{ name: 'X', price: 'bad' }] } } }, baseVersion: 3 }) });
check('invalid draft → validation errors returned (not published)', invalid.status === 200 && invalid.body.data.validation.ok === false && invalid.body.data.validation.errors.length >= 2);

const validated = await get('/knowledge/validate', { method: 'POST' });
check('POST /knowledge/validate returns structured errors + review', validated.status === 200 && Array.isArray(validated.body.data.errors) && validated.body.data.review.counts.modified >= 1);

const preview = await get('/knowledge/preview', { method: 'POST' });
check('POST /knowledge/preview returns human-readable review', preview.status === 200 && preview.body.data.review.bySection.menu.modified >= 1);

// restore a valid draft, then publish
await get('/knowledge/draft', { method: 'PUT', body: JSON.stringify({ content: { restaurantName: 'LWC2', menus: { A: { B: [{ name: 'X', price: '2.000' }] } } }, baseVersion: 3 }) });
const published = await get('/knowledge/publish', { method: 'POST' });
check('POST /knowledge/publish creates the next published version (atomic)', published.status === 200 && published.body.data.version === 4 && published.body.data.history[0].version === 4);
check('publish archives the previous version (history + published-only reads)', rows.documents.filter((d) => d.status === 'published').length === 1 && rows.documents.find((d) => d.status === 'published').version === 4);

const history = await get('/knowledge/history');
check('GET /knowledge/history returns publication history', history.status === 200 && history.body.data[0].version === 4);

rows.drafts.length = 0;
await get('/knowledge/draft', { method: 'POST' });
const discarded = await get('/knowledge/discard', { method: 'POST' });
check('POST /knowledge/discard resets the draft', discarded.status === 200 && discarded.body.data.discarded === true);

// RBAC: a read-only role can read but not edit/publish
const app2 = express();
app2.use(express.json());
app2.use('/api/v1', createApiV1Router({ pool, validateSessionFn: async () => ({ tenantId: 't1', user: { id: 'u2', email: 'a@b.co', name: 'Agent' }, roles: ['Agent'] }) }));
const srv2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
const base2 = `http://127.0.0.1:${srv2.address().port}/api/v1`;
const roRead = await fetch(base2 + '/knowledge', { headers: { Cookie: 'lwc_session=test; csrf_token=test-csrf-token', 'x-csrf-token': 'test-csrf-token' } }).then((r) => r.status);
const roPublish = await fetch(base2 + '/knowledge/publish', { method: 'POST', headers: { Cookie: 'lwc_session=test; csrf_token=test-csrf-token', 'x-csrf-token': 'test-csrf-token' } }).then(async (r) => ({ s: r.status, b: await r.json() }));
check('RBAC: Agent can read but cannot publish (403)', roRead === 200 && roPublish.s === 403 && roPublish.b.error.code === 'FORBIDDEN');

const noSource = { query: async () => ({ rows: [] }) };
const app3 = express();
app3.use(express.json());
app3.use((req, _res, next) => { next(); });
app3.use('/api/v1', createApiV1Router({ pool: noSource, validateSessionFn: async () => ({ tenantId: 'tX', user: { id: 'u' }, roles: ['Company Admin'] }) }));
const srv3 = await new Promise((r) => { const s = app3.listen(0, '127.0.0.1', () => r(s)); });
const nf = await fetch(`http://127.0.0.1:${srv3.address().port}/api/v1/knowledge`, { headers: { Cookie: 'lwc_session=test; csrf_token=test-csrf-token', 'x-csrf-token': 'test-csrf-token' } }).then(async (r) => ({ s: r.status, b: await r.json() }));
check('tenant without a knowledge source → 404 (no cross-tenant fallback)', nf.s === 404 && nf.b.error.code === 'KNOWLEDGE_SOURCE_NOT_FOUND');

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
srv.close(); srv2.close(); srv3.close();
process.exit(failed === 0 ? 0 : 1);
