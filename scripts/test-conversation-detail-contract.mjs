/**
 * P0 REGRESSION — the Inbox detail panel must never be a silent spinner.
 *
 *   node scripts/test-conversation-detail-contract.mjs
 *
 * THE DEFECT THIS PINNED
 * ----------------------
 * P0.2 added a conversation-detail query that read \`users.display_name\`.
 * \`users\` has \`name\`; \`display_name\` belongs to \`customers\` and \`channels\`.
 * PostgreSQL raised \`column u.display_name does not exist\` on EVERY detail
 * request, the route swallowed it into a bare 500, and the UI — whose render
 * branch was \`detailLoading || !detail ? <skeleton/> : <thread/>\` — rendered an
 * animated skeleton for ever. The list kept working, because it only ever
 * touches customers/channels.
 *
 * Two independent failures, so two independent tests:
 *
 *   A  SCHEMA CONTRACT — every column the v1 API SQL references must exist in
 *      the table it is read from, derived from migrations/*.sql. This is the
 *      test that was missing: nothing asserted that the SQL matched the schema.
 *
 *   B  ROUTE BEHAVIOUR — the detail route is driven against a fake pool that
 *      REJECTS unknown columns the way PostgreSQL does, so the exact 500 that
 *      shipped cannot come back.
 */
process.env.DATABASE_URL ||= 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ==========================================================================
   A — SCHEMA CONTRACT, derived from the migrations
   ========================================================================== */

/** table -> Set(column), built from CREATE TABLE blocks and ALTER TABLE ADD COLUMN. */
function schemaFromMigrations() {
  const dir = join(REPO, 'migrations');
  const tables = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // CREATE TABLE [IF NOT EXISTS] name ( ... )
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi)) {
      const [, name, body] = m;
      const cols = new Set();
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)/i.test(t)) continue;
        const c = t.match(/^([a-z_][a-z0-9_]*)\s+/i);
        if (c) cols.add(c[1].toLowerCase());
      }
      tables.set(name.toLowerCase(), cols);
    }
    // ALTER TABLE ... ADD [COLUMN] [IF NOT EXISTS] col ...
    //
    // One ALTER TABLE can carry SEVERAL ADD COLUMN clauses:
    //   ALTER TABLE messages
    //     ADD COLUMN IF NOT EXISTS delivery_status text ...,
    //     ADD COLUMN IF NOT EXISTS delivery_error text;
    // so every ADD inside a statement's span is collected, not just the first.
    const alters = [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)/gi)];
    for (let i = 0; i < alters.length; i++) {
      const table = alters[i][1].toLowerCase();
      const start = alters[i].index + alters[i][0].length;
      const end = i + 1 < alters.length ? alters[i + 1].index : sql.length;
      const span = sql.slice(start, end);
      if (!tables.has(table)) tables.set(table, new Set());
      const cols = tables.get(table);
      for (const a of span.matchAll(/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        // `ADD CONSTRAINT ...`, `ADD PRIMARY KEY ...` are not columns.
        if (/^(constraint|primary|foreign|unique|check|exclude|like)$/i.test(a[1])) continue;
        cols.add(a[1].toLowerCase());
      }
      // ALTER TABLE ... RENAME COLUMN old TO new
      for (const a of span.matchAll(/\bRENAME\s+COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*)/gi)) {
        cols.delete(a[1].toLowerCase());
        cols.add(a[2].toLowerCase());
      }
    }
  }
  return tables;
}

const SCHEMA = schemaFromMigrations();
console.log(`  schema parsed from migrations: ${SCHEMA.size} tables`);
console.log(`  users columns the migrations define: ${[...(SCHEMA.get('users') ?? [])].sort().join(',')}`);
check('A0 the parser found the users table', SCHEMA.has('users'));
check('A0 and knows users has NO display_name',
  !(SCHEMA.get('users') ?? new Set()).has('display_name'),
  [...(SCHEMA.get('users') ?? [])].join(','));
check('A0 and users DOES have name', (SCHEMA.get('users') ?? new Set()).has('name'));
check('A0 customers does have display_name', (SCHEMA.get('customers') ?? new Set()).has('display_name'));

/** Resolve <alias> -> <table> from FROM/JOIN clauses in one statement. */
function aliasMap(sql) {
  const map = new Map();
  for (const m of sql.matchAll(/(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
    let [, table, alias] = m;
    if (!alias || /^(ON|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ORDER|GROUP|LIMIT|FOR|SET|VALUES|AND|OR)$/i.test(alias)) alias = table;
    map.set(alias.toLowerCase(), table.toLowerCase());
  }
  return map;
}

/** Every <alias>.<column> in a statement, resolved to a real table where possible. */
function columnRefs(sql) {
  const aliases = aliasMap(sql);
  const out = [];
  for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
    const [, alias, column] = m;
    const table = aliases.get(alias.toLowerCase());
    if (!table) continue;                 // not a table alias (e.g. a CTE or a column alias)
    if (!SCHEMA.has(table)) continue;     // table not created by the migrations we parse
    out.push({ alias, column: column.toLowerCase(), table });
  }
  return out;
}

/** Pull every backtick-quoted SQL string out of a source file. */
function sqlIn(file) {
  const src = readFileSync(join(REPO, file), 'utf8');
  return [...src.matchAll(/`([^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*?)`/gi)].map((m) => m[1]);
}

section('A. Schema contract — every referenced column must exist');
const V1_SQL_FILES = [
  'src/api/v1/conversations.js',
  'src/api/v1/dashboard.js',
  'src/api/v1/users.js',
  'src/api/v1/brandGrants.js',
  'src/api/v1/companies.js',
  'src/api/v1/knowledge.js',
  'src/api/v1/ai.js',
  'src/api/v1/platform.js',
  'src/api/v1/integrations.js',
  'src/services/conversations.js',
  'src/services/handoff.js',
  'src/services/brandGrants.js'
];

let totalRefs = 0;
const bad = [];
for (const file of V1_SQL_FILES) {
  let fileRefs = 0;
  for (const sql of sqlIn(file)) {
    for (const ref of columnRefs(sql)) {
      fileRefs++; totalRefs++;
      const cols = SCHEMA.get(ref.table) ?? new Set();
      if (!cols.has(ref.column)) {
        bad.push(`${file}: ${ref.alias}.${ref.column}  (table "${ref.table}" has no such column)`);
      }
    }
  }
  console.log(`  ${file.padEnd(42)} ${fileRefs} column refs checked`);
}
console.log(`  total column references verified against the schema: ${totalRefs}`);
check('A1 NO SQL statement references a column the schema does not define',
  bad.length === 0, bad.slice(0, 8).join(' | '));
if (bad.length) { console.log('\n  OFFENDING REFERENCES:'); for (const b of bad) console.log(`    ${b}`); }

/* The exact regression, asserted directly so it can never be reintroduced. */
section('A2. The exact defect');
{
  const sql = sqlIn('src/api/v1/conversations.js').join('\n');
  check('A2 conversations.js contains NO users.display_name',
    !/(?<![a-z])u\.display_name/.test(sql));
  check('A2 the assignee query reads users.name',
    /SELECT u\.id, u\.name, u\.email/.test(sql));
  check('A2 the assigned_user_name subquery reads users.name',
    /SELECT u\.name FROM users u WHERE u\.id = c\.assigned_user_id/.test(sql));
  check('A2 the assignee ordering uses users.name',
    /ORDER BY u\.name NULLS LAST/.test(sql));
  check('A2 customers.display_name is still used where it is correct',
    /cu\.display_name AS customer_name/.test(sql));
  check('A2 channels.display_name is still used where it is correct',
    /ch\.display_name AS channel_name/.test(sql));
  check('A2 assigneeOptions maps the renamed column',
    /name: a\.name, email: a\.email/.test(readFileSync(join(REPO, 'src/api/v1/conversations.js'), 'utf8')));
}

/* ==========================================================================
   B — ROUTE BEHAVIOUR against a pool that rejects unknown columns
   ========================================================================== */
section('B. Route behaviour — the 500 cannot come back');
{
  const { pool } = await import('../src/db/pg.js');
  const conv = await import('../src/api/v1/conversations.js');

  const T = 'tenant-t';
  const CONV = '00000000-0000-4000-8000-0000000000c1';
  const USER = '00000000-0000-4000-8000-0000000000a1';
  const BRAND = '00000000-0000-4000-8000-0000000000b1';
  const CH = '00000000-0000-4000-8000-0000000000d1';

  /** Mirrors PostgreSQL: an unknown column is an error, not an empty result. */
  function makeDb() {
    const rows = {
      conversation: {
        id: CONV, state: 'QUEUED', language: 'ar', created_at: new Date().toISOString(),
        assigned_user_id: null, priority: 'normal', resolved_at: null,
        customer_name: 'Customer', provider: 'meta_dm', channel_name: 'Messenger',
        channel_status: 'active', brand_id: BRAND, assigned_user_name: null,
        last_inbound_at: new Date().toISOString()
      },
      assignees: [{ id: USER, name: 'Agent One', email: 'a@x.com' }]
    };
    const assertColumns = (sql) => {
      for (const ref of columnRefs(sql)) {
        const cols = SCHEMA.get(ref.table);
        if (cols && !cols.has(ref.column)) {
          const e = new Error(`column ${ref.alias}.${ref.column} does not exist`);
          e.code = '42703';
          throw e;
        }
      }
    };
    return {
      async query(sql) {
        const s = sql.replace(/\s+/g, ' ').trim();
        assertColumns(s);
        if (s.includes('FROM conversations c')) return { rows: [rows.conversation] };
        if (s.includes('FROM messages')) return { rows: [{ id: 'm1', direction: 'inbound', sender_type: 'customer', text: 'hi', created_at: new Date().toISOString(), provider_ts: null, delivery_status: null, delivery_error: null }] };
        if (s.includes('FROM users u')) return { rows: rows.assignees };
        return { rows: [] };
      }
    };
  }

  const v1 = {
    tenantId: T, user: { id: USER }, roles: ['Company Admin'],
    brandIds: null, allBrandsInCompany: true, isPlatformSuperAdmin: false, customAbilities: []
  };
  const fakeRes = () => { const r = { _s: 200, _b: null }; r.status = (c) => (r._s = c, r); r.json = (b) => (r._b = b, r); r.setHeader = () => r; return r; };
  const call = async (path, id) => {
    const router = conv.createConversationsRouter({ pool: makeDb() });
    const layer = router.stack.find((l) => l.route && l.route.path === path);
    const res = fakeRes();
    const req = { v1, params: { id }, query: {}, body: {}, headers: {}, cookies: {} };
    await new Promise((r2) => {
      let i = 0;
      const next = () => { if (i >= layer.route.stack.length) return r2(); try { layer.route.stack[i++].handle(req, res, next); } catch { r2(); } };
      next(); setTimeout(r2, 5000);
    });
    return { status: res._s, body: res._b };
  };

  const d = await call('/:id', CONV);
  eq('B1 the detail route returns 200, not 500', d.status, 200);
  check('B2 it returns the conversation', d.body?.data?.conversation?.id === CONV, JSON.stringify(d.body?.error ?? {}));
  check('B3 it returns the messages array', Array.isArray(d.body?.data?.messages));
  check('B4 it returns the server-authoritative reply policy', typeof d.body?.data?.reply?.canReply === 'boolean',
    JSON.stringify(d.body?.data?.reply ?? null));
  check('B5 it returns assigneeOptions for the P0.3 assignee list',
    Array.isArray(d.body?.data?.assigneeOptions) && d.body.data.assigneeOptions.length === 1,
    JSON.stringify(d.body?.data?.assigneeOptions ?? null));
  check('B6 assigneeOptions carries the name from users.name',
    d.body?.data?.assigneeOptions?.[0]?.name === 'Agent One');
  check('B7 it leaks no tenant identifier',
    !/tenant_?[Ii]d\s*:/.test(JSON.stringify(d.body?.data ?? {})));

  const l = await call('/', null);
  eq('B8 the list route still returns 200', l.status, 200);
  check('B9 the list returns an array', Array.isArray(l.body?.data));
}

/* ==========================================================================
   C — the UI half: a failed fetch must never be an infinite spinner
   ========================================================================== */
section('C. UI — a failure is a failure, not a spinner');
{
  const src = readFileSync(join(REPO, 'apps/web/components/inbox/view.tsx'), 'utf8');
  check('C0 the panel has an error state', /detailError/.test(src));
  check('C0 and the fetch records WHY it failed', /setDetailError\(/.test(src));
  check('C0 a non-ok response no longer collapses to null silently',
    !/setDetail\(r\.ok \? body\.data : null\)/.test(src),
    'the old form is what produced the infinite skeleton');
  check('C0 the error branch is rendered BEFORE the skeleton branch',
    src.indexOf(': detailError ? (') > -1 && src.indexOf(': detailError ? (') < src.indexOf('detailLoading || !detail ? ('));
  check('C0 the error panel offers a retry that refetches',
    /onAction=\{\(\) => setRefreshToken\(\(n\) => n \+ 1\)\}/.test(src));
  check('C0 a network failure is handled too', /catch \{[\s\S]{0,200}setDetailError\('network'\)/.test(src));
  check('C0 a 401 sends the employee to login instead of spinning',
    /r\.status === 401[\s\S]{0,120}router\.replace\('\/login'\)/.test(src));
  check('C0 the error text is translated, not hard-coded',
    /detailErrorDescription\(t, detailError\)/.test(src) && !/detailErrorDescription[\s\S]{0,400}>\s*Error\b/.test(src));

  const en = JSON.parse(readFileSync(join(REPO, 'apps/web/messages/en.json'), 'utf8'));
  const ar = JSON.parse(readFileSync(join(REPO, 'apps/web/messages/ar.json'), 'utf8'));
  const keys = ['detailErrorTitle', 'detailErrorNotFound', 'detailErrorForbidden', 'detailErrorNetwork', 'detailErrorServer', 'detailErrorUnknown'];
  for (const k of keys) {
    check(`C1 en.inbox.${k} exists`, typeof en.inbox[k] === 'string' && en.inbox[k].length > 0);
    check(`C1 ar.inbox.${k} exists and is Arabic`, typeof ar.inbox[k] === 'string' && /[؀-ۿ]/.test(ar.inbox[k]), ar.inbox[k]);
  }
  eq('C2 inbox namespaces stay in parity', Object.keys(en.inbox).sort().join(','), Object.keys(ar.inbox).sort().join(','));
}

/* ========================================================================== */
console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);