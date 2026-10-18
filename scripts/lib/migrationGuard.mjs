/**
 * Fail-closed migration guard.
 *
 * WHY A SHARED MODULE
 * Two separate batches each grew a private "did someone add a migration that
 * was not approved?" assertion. Both were weaker than they looked: one only
 * looked at a filename RANGE (so 020 and later were invisible) and the other
 * used a regex that required the filename and a destructive keyword to sit on
 * the SAME LINE, which is never true in a real migration file. An unauthorised
 * additive 020 therefore passed both.
 *
 * One guard, explicit allowlist, whole directory, content hashes. It fails
 * CLOSED: anything not named here is a violation, including a future number.
 *
 * THE ALLOWLIST IS THE POINT
 * There is no pattern and no range. A migration becomes acceptable only by
 * being added to APPROVED_SHA256 deliberately, in a reviewed commit.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every migration this repository is allowed to contain, with the SHA-256 of
 * its content at the point it was approved.
 *
 * A change to an existing file is a violation too: these have already run on
 * production, so editing one silently changes what "already applied" means on
 * the next machine.
 */
export const APPROVED_SHA256 = Object.freeze({
  '001_init.sql': '5c6dd3226d077ebb0ca7848b5c558d7d2c8e82008bc83dd996000e056e3e303d',
  '002_auth.sql': '5a817074f1b9b336108531f3b05a6446d6cc745f4134b23149d70da0fc2fc73a',
  '003_meta_channel_unique.sql': '68a6259d805f297689bfbd293430055dc6c6a915b1c2d336e70a9d09e90e128e',
  '004_message_delivery_status.sql': 'abe54b9071a150a4d111d552de05d1cf9fc26a161feac1aff09b6e844527574b',
  '005_message_retry_metadata.sql': '55b5997525ab7f398c3db9c11df36f7d7d129632e24d21d45bb8b85ce1dc3783',
  '006_knowledge_drafts_versions.sql': '2d80010271cc48a4dbec07b1b1c4ce53b5354cd3686404b4d915e64c95f6289b',
  '007_knowledge_vector_index.sql': 'ce8d434ddd31abdd978706ea65ea1045a32f1164d94232d7cc53dfdb2bdf7359',
  '008_reply_sources.sql': '03bc531ef0509ef59ef0fc2306d720d5eecd674d25882f3782fd85ee6b471f8a',
  '009_handoff.sql': '2fbc13e70fa8290b6caf1b3d236923cb5e10e3c7bec2280b348128ba5a486ede',
  '010_platform_super_admin.sql': '050e0ad7ce18c044643487165b86d7616219f4c21efe767d46559d5f26814aad',
  '011_fix_company_admin_wildcard.sql': '800111dd3aabf68a413051541a09a892bef119be4b65b96731ade41ca5c72d0b',
  '012_add_brand_default_language.sql': '952527d3fb344ac9859f7d2c180a0a20c7c7a3543caf7b842955e805fbdcc238',
  '013_backfill_knowledge_sources.sql': '722dc8d3939e8b4cd7ff6ada94a90fb0655053e5467eba08f47b7b9e81b8ffb1',
  '015_brand_access_grants.sql': '07bb8942643894f01aecf4562dadb49c1d304ea8532b5704c91958b08a5e113b',
  '016_manual_reply_idempotency.sql': 'ca280ffb799ab0a555670fffbedcd5272035abbe65da7854a3c2b9cc95ef1c5b',
  '017_escalation_resolve_ability.sql': '093f4df44821ef1a221c543275722581629235328f1117bab4169eb27acb2732',
  '018_handoff_acknowledgment.sql': '5fd7f915a3f8f1ce5b37c6dcfceb96e2ffa5e003353a8b5035ef5420eef0912f',
  '019_ai_routing_rules.sql': '2aa946d57d9cadde2b8d2fc5b5fdf017e5796062796a40e3f39719cbcbfcc356',
  '020_team_lifecycle.sql': '851ac18263dc04752367b490315176ca3552d49e0aa01e8fbfe9506eea3f0db6'
});

export function sha256(text) {
  // Line endings are normalised before hashing, and this is load-bearing rather
  // than cosmetic.
  //
  // A checksum that covers CRLF-vs-LF will report tampering when nothing was
  // tampered with: with `core.autocrlf=true` and no .gitattributes pinning
  // `eol`, a checkout on Windows holds CRLF while the hash recorded from a
  // Linux checkout holds LF. That is not hypothetical - it happened here, on
  // 020_team_lifecycle.sql, whose content was byte-identical after
  // normalisation and which the guard still called "modified".
  //
  // A guard that cries wolf on one developer's platform gets disabled, and a
  // disabled guard is worse than none. Normalising keeps the property that
  // matters: any real change to the SQL still fails the hash.
  return createHash('sha256')
    .update(String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
    .digest('hex');
}

/**
 * Audit a migrations directory against the allowlist.
 *
 * @param {string} dir
 * @param {{files?: Record<string,string>, approved?: Record<string,string>}} [opts]
 *        `files` lets a test supply an in-memory view instead of touching disk.
 * @returns {{ok: boolean, problems: string[], files: string[]}}
 */
export function auditMigrations(dir, opts = {}) {
  const approved = opts.approved ?? APPROVED_SHA256;

  const view = opts.files ?? (() => {
    const out = {};
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.sql')) out[f] = readFileSync(join(dir, f), 'utf8');
    }
    return out;
  })();

  const problems = [];
  const present = Object.keys(view).sort();
  const expected = Object.keys(approved).sort();

  // 1. Anything present that is not on the allowlist. This is the rule that
  //    makes the guard fail closed: no range, no pattern, no exemption.
  for (const f of present) {
    if (!Object.prototype.hasOwnProperty.call(approved, f)) {
      problems.push(`unapproved migration present: ${f}`);
    }
  }

  // 2. Anything on the allowlist that has gone missing (a rename or a delete).
  for (const f of expected) {
    if (!Object.prototype.hasOwnProperty.call(view, f)) {
      problems.push(`approved migration missing: ${f}`);
    }
  }

  // 3. Content drift on a file that has already been applied somewhere.
  for (const f of expected) {
    if (!Object.prototype.hasOwnProperty.call(view, f)) continue;
    const actual = sha256(view[f]);
    if (actual !== approved[f]) {
      problems.push(`approved migration modified: ${f} (expected ${approved[f].slice(0, 12)}, got ${actual.slice(0, 12)})`);
    }
  }

  return { ok: problems.length === 0, problems, files: present };
}

/** Convenience for a real repository directory. */
export function auditRepoMigrations(repoRoot) {
  const dir = join(repoRoot, 'migrations');
  if (!existsSync(dir)) return { ok: false, problems: ['migrations directory not found'], files: [] };
  return auditMigrations(dir);
}