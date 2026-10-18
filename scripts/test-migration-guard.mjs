/**
 * NEGATIVE TESTS for the migration guard.
 *
 * A guard that has never been shown to fail is not a guard. This suite feeds
 * the shared guard synthetic repository states - an unauthorised 020, a renamed
 * 018, an edited 019, a deleted file - and asserts every one is REJECTED.
 *
 * It runs entirely against in-memory views. Nothing is written to disk and the
 * real migrations directory is never touched.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}

const { APPROVED_SHA256, auditMigrations, auditRepoMigrations, sha256 } =
  await import('./lib/migrationGuard.mjs');

// A faithful in-memory copy of the real directory, used as the "clean" baseline.
const realFiles = {};
for (const f of readdirSync(join(REPO, 'migrations'))) {
  if (f.endsWith('.sql')) realFiles[f] = readFileSync(join(REPO, 'migrations', f), 'utf8');
}
const clone = () => ({ ...realFiles });

section('1 the real repository passes its own guard');
{
  const audit = auditRepoMigrations(REPO);
  check('the committed migrations/ directory is clean', audit.ok, audit.problems.join(' | '));
  check('the allowlist covers every file on disk',
    audit.files.every((f) => Object.prototype.hasOwnProperty.call(APPROVED_SHA256, f)),
    audit.files.filter((f) => !APPROVED_SHA256[f]).join(','));
}

section('2 the guard is fail-closed on an UNAUTHORISED new migration');
{
  // The exact hole in the previous guards: 020+ was invisible to them.
  for (const name of ['020_sneaky.sql', '020_additive_only.sql', '099_far_future.sql', 'zz_trailing.sql']) {
    const files = clone();
    files[name] = '-- a perfectly additive, harmless looking migration\nCREATE TABLE nothing_bad (id int);\n';
    const audit = auditMigrations(REPO, { files });
    check(`${name} is REJECTED even though it is purely additive`,
      audit.ok === false, `problems=${audit.problems.length}`);
    check(`  and it is reported by name`, audit.problems.some((p) => p.includes(name)), audit.problems.join('|'));
  }
}

section('3 the guard is fail-closed on a DESTRUCTIVE new migration');
{
  for (const [name, body] of [
    ['020_drop.sql', 'DROP TABLE conversations;'],
    ['020_truncate.sql', 'TRUNCATE messages;'],
    ['020_alter.sql', 'ALTER TABLE users ADD COLUMN backdoor int;']
  ]) {
    const files = clone();
    files[name] = `-- header comment on its own line\n${body}\n`;
    const audit = auditMigrations(REPO, { files });
    check(`${name} is REJECTED`, audit.ok === false);
  }
}

section('4 the guard catches a RENAME of an approved migration');
{
  const files = clone();
  delete files['018_handoff_acknowledgment.sql'];
  files['018_renamed_handoff.sql'] = realFiles['018_handoff_acknowledgment.sql'];
  const audit = auditMigrations(REPO, { files });
  check('a renamed approved migration is REJECTED', audit.ok === false);
  check('  reported as unapproved', audit.problems.some((p) => p.includes('018_renamed_handoff.sql')));
  check('  and the original is reported as missing',
    audit.problems.some((p) => p.includes('approved migration missing: 018_handoff_acknowledgment.sql')));
}

section('5 the guard catches a DELETION of an approved migration');
{
  const files = clone();
  delete files['019_ai_routing_rules.sql'];
  const audit = auditMigrations(REPO, { files });
  check('deleting an approved migration is REJECTED', audit.ok === false);
  check('  reported as missing', audit.problems.some((p) => p.includes('019_ai_routing_rules.sql')));
}

section('6 the guard catches CONTENT DRIFT in an applied migration');
{
  const files = clone();
  files['019_ai_routing_rules.sql'] += '\n-- an innocent looking comment appended later\n';
  const audit = auditMigrations(REPO, { files });
  check('a one-line edit to an applied migration is REJECTED', audit.ok === false);
  check('  reported as modified', audit.problems.some((p) => p.includes('approved migration modified: 019_ai_routing_rules.sql')));
}

section('7 a semantic change inside an approved file is still caught');
{
  // Not a whitespace tweak - an actual removed constraint.
  const files = clone();
  files['019_ai_routing_rules.sql'] = files['019_ai_routing_rules.sql']
    .replace('CHECK (target_team_id IS NOT NULL)', 'CHECK (target_team_id IS NULL)');
  const audit = auditMigrations(REPO, { files });
  check('inverting a CHECK constraint inside an approved file is REJECTED', audit.ok === false);
}

section('6b CRLF vs LF is NOT tampering');
{
  // The failure this exists to prevent: with core.autocrlf=true and no
  // .gitattributes, a Windows checkout holds CRLF while the allowlist hash was
  // recorded from LF. The guard called a byte-identical migration "modified".
  // That trains people to ignore the guard, which is worse than not having one.
  const lf = realFiles['019_ai_routing_rules.sql'];
  const crlf = lf.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  check('the fixture actually is CRLF (or has no newline at all)', crlf.includes('\r\n') || !lf.includes('\n'));
  check('sha256 of the LF form equals sha256 of the CRLF form',
    sha256(lf) === sha256(crlf));

  const files = clone();
  files['019_ai_routing_rules.sql'] = crlf;
  const audit = auditMigrations(REPO, { files });
  check('a CRLF checkout of an approved migration PASSES the guard', audit.ok === true,
    audit.problems.join(' '));

  // The point of normalising: it must not become a blind spot. Changing real
  // content while ALSO changing line endings is still a change.
  const sneaky = crlf.replace('NOT NULL', 'NULL');
  const files2 = clone();
  files2['019_ai_routing_rules.sql'] = sneaky;
  const audit2 = auditMigrations(REPO, { files: files2 });
  check('but a real edit disguised with CRLF is still REJECTED', audit2.ok === false);
  check('  and reported as modified',
    audit2.problems.some((p) => p.includes('approved migration modified: 019_ai_routing_rules.sql')),
    JSON.stringify(audit2.problems));
}

section('8 the guard is not fooled by casing or look-alike names');
{
  for (const name of ['019_ai_routing_rules.SQL', '019_ai_routing_rules.sql.bak', '019_ai_routing_rules.sqlx']) {
    const files = clone();
    delete files['019_ai_routing_rules.sql'];
    files[name] = realFiles['019_ai_routing_rules.sql'];
    const audit = auditMigrations(REPO, { files });
    check(`"${name}" cannot masquerade as the approved file`, audit.ok === false);
  }
}

section('9 an EMPTY directory is not silently accepted');
{
  const audit = auditMigrations(REPO, { files: {} });
  check('an empty migrations directory is REJECTED', audit.ok === false);
  check('  and every approved file is reported missing', audit.problems.length === Object.keys(APPROVED_SHA256).length);
}

section('10 the allowlist itself is well formed');
{
  check('every approved entry is a real sha256 (64 hex chars)',
    Object.values(APPROVED_SHA256).every((h) => /^[0-9a-f]{64}$/.test(h)));
  check('every approved entry is named NNN_*.sql',
    Object.keys(APPROVED_SHA256).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)), );
  check('no duplicate names', new Set(Object.keys(APPROVED_SHA256)).size === Object.keys(APPROVED_SHA256).length);
}

section('11 both production suites really call this guard');
{
  // A guard nobody runs protects nothing.
  // Comments are stripped first: the two suites explain in prose that the OLD
  // range check was blind, and that prose must not be mistaken for live code.
  const stripComments = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const f of ['test-escalation-ability.mjs', 'test-ack-correction.mjs']) {
    const src = readFileSync(join(REPO, 'scripts', f), 'utf8');
    const code = stripComments(src);
    check(`${f} imports the shared migration guard`,
      /import\(['"]\.\/lib\/migrationGuard\.mjs['"]\)|from ['"]\.\/lib\/migrationGuard\.mjs['"]/.test(code));
    check(`${f} calls the shared guard`,
      /auditRepoMigrations\s*\(/.test(code));
    check(`${f} no longer EXECUTES the old blind filename range`,
      !/\^01\[4-9\]_/.test(code));
    check(`${f} no longer executes the dead same-line regex`,
      !/0\(19\|2\\d\)_.*DROP/.test(code));
  }
}

console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(64));
process.exit(failures.length ? 1 : 0);