#!/usr/bin/env node
/**
 * Group C targeted tests — Docker ignore patterns and repository integrity.
 * Run:  node scripts/test-group-c-dockerignore.mjs
 * Exits non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// --- .dockerignore semantics: glob match, last matching rule wins, ! negates ---
function globToRe(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function excludedBy(rules, p) {
  let excluded = false;
  for (const rule of rules) {
    const neg = rule.startsWith('!');
    const pat = neg ? rule.slice(1) : rule;
    let hit;
    if (pat.endsWith('/')) {
      hit = globToRe(pat.slice(0, -1) + '/**').test(p) || globToRe(pat.slice(0, -1)).test(p);
    } else {
      hit = globToRe(pat).test(p);
      if (!hit && !pat.includes('/')) hit = globToRe('**/' + pat).test(p);
    }
    if (hit) excluded = !neg;
  }
  return excluded;
}

const di = read('.dockerignore');
const rules = di.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const inc = (p) => !excludedBy(rules, p);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
};

console.log('\n=== 1. Docker ignore patterns exclude sensitive material ===');
const mustExclude = [
  ['.env', 'live environment secrets'],
  ['rollbacks/pre-batch1-2026-10-14_1226/portainer_stack.env', 'credentials inside a rollback snapshot'],
  ['rollbacks/pre-batch1-2026-10-14_1226/src/webhook.js', 'rollback source tree'],
  ['rollbacks/pre-batch2-20261015/MANIFEST.txt', 'rollback metadata'],
  ['rollbacks/pre-domain-20261015-141820/docker-compose.yml', 'rollback compose'],
  ['backup_.sql', 'host plain-SQL backup'],
  ['backup_2026-10-14_1215.sql', 'host plain-SQL backup'],
  ['backup_20261012_1647.sql', 'host plain-SQL backup'],
  ['backup_pre-batch2_20261015_110906.dump', 'host pg_dump'],
  ['backup_pre-kbfirstdraft_20261015.dump', 'host pg_dump'],
  ['apps/web/.env', 'nested env file'],
  ['apps/web/.env.local', 'nested env file']
];
for (const [p, why] of mustExclude) check(`excludes ${p}  (${why})`, excludedBy(rules, p));

console.log('\n=== 2. Required runtime files remain included ===');
const runtime = [
  'server.js', 'Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json',
  'knowledge.json', 'src/webhook.js', 'src/dashboard.js', 'src/facebook.js', 'src/notify.js',
  'src/db/migrate.js', 'src/db/pg.js', 'src/serverless.js',
  'src/queues/metaEvents.js', 'src/queues/redis.js',
  'src/services/conversations.js', 'src/services/webhookEvents.js',
  'src/services/deliveryOutcome.js', 'src/services/redact.js',
  'src/services/handoffDetector.js',
  'src/auth/abilities.js', 'src/auth/sessions.js',
  'src/workers/metaEventWorker.js', 'src/workers/metaEventPipeline.js',
  'apps/web/Dockerfile', 'apps/web/package.json', 'apps/web/lib/api.ts'
].filter((f) => fs.existsSync(path.join(ROOT, f)));
for (const f of runtime) check(`includes ${f}`, inc(f));

console.log('\n=== 3. All migration files remain included ===');
const migs = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
check('migrations directory is non-empty', migs.length > 0);
for (const m of migs) check(`includes migrations/${m}`, inc('migrations/' + m));
check('009_handoff.sql exists', migs.includes('009_handoff.sql'), migs.join(','));
check('no blank *.sql blanket pattern exists', !rules.includes('*.sql'));
check('no bare **/ pattern would nuke everything', !rules.includes('**') && !rules.includes('/'));

console.log('\n=== 4. Template and metadata handling ===');
// .env.example must survive (it is a template, no secrets). .gitignore is
// deliberately EXCLUDED by a pre-existing "infra noise" rule and must stay so.
check('includes .env.example (template, carries no secrets)', inc('.env.example'));
check('excludes .gitignore (pre-existing infra-noise rule)', !inc('.gitignore'));
check('includes README.md', inc('README.md'));

console.log('\n=== 5. 009_handoff.sql restored verbatim ===');
const p9 = path.join(ROOT, 'migrations/009_handoff.sql');
check('009_handoff.sql exists', fs.existsSync(p9));
if (fs.existsSync(p9)) {
  const { createHash } = await import('node:crypto');
  const b = fs.readFileSync(p9);
  const h = createHash('sha256').update(b).digest('hex');
  check('byte length = 5554 (production)', b.length === 5554, `got ${b.length}`);
  check('sha256 matches production', h === '2fbc13e70fa8290b6caf1b3d236923cb5e10e3c7bec2280b348128ba5a486ede', h);
  const s = b.toString('utf8');
  check('no CRLF (repo is LF-only)', !/\r\n/.test(s));
  check('no DROP TABLE / DROP COLUMN', !/DROP\s+TABLE|DROP\s+COLUMN/.test(s));
  check('no row rewrite (DELETE/UPDATE/TRUNCATE)', !/DELETE\s+FROM|UPDATE\s+\w+\s+SET|TRUNCATE/.test(s));
  check('every DROP is DROP CONSTRAINT IF EXISTS', (s.match(/DROP\s+(?!CONSTRAINT\s+IF\s+EXISTS)/) || []).length === 0);
  check('roles insert is ON CONFLICT DO NOTHING', /ON CONFLICT \(tenant_id, name\) DO NOTHING/.test(s));
}

console.log('\n=== 6. No unintended tracked files changed ===');
const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const expectedTracked = ['.dockerignore'];
const unexpectedTracked = changed.filter((f) => !expectedTracked.includes(f));
check('only .dockerignore is modified among tracked files', unexpectedTracked.length === 0, unexpectedTracked.join(', '));
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .trim().split('\n').filter((f) => f && !f.startsWith('node_modules') && !f.startsWith('GROUP-C-PATCH'));
const expectedUntracked = ['migrations/009_handoff.sql', 'scripts/test-group-c-dockerignore.mjs'];
const unexpectedUntracked = untracked.filter((f) => !expectedUntracked.includes(f));
check('only migrations/009_handoff.sql is newly added', unexpectedUntracked.length === 0, unexpectedUntracked.join(', '));

console.log('\n=== 7. Compose is untouched ===');
const composeChanged = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'docker-compose.yml'], { cwd: ROOT, encoding: 'utf8' }).trim();
check('docker-compose.yml is NOT modified', composeChanged === '', composeChanged);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);