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
  '001_init.sql': '4cee08edd3e1390bb95663d3947af8e222b3c9d228d655034e85c2b4f0782788',
  '002_auth.sql': '86b00a33e9590fe9d4573e80bef02f90d17cd458815dbf0247c4c6e535f582df',
  '003_meta_channel_unique.sql': '698f9c0e0aaeaadf80606c2e06e61b8f6fed82c9f7c6e296df9c95e8a9e641e3',
  '004_message_delivery_status.sql': '87b057114ca04d217c96e7fbf538e99ea3e7666384164e3f2e0ffc7b79ab5ad7',
  '005_message_retry_metadata.sql': 'b72af8373f92b25eedc0a8e0d58a2201b06618a5413067b6964ca997efe94c3e',
  '006_knowledge_drafts_versions.sql': '4f016fa8f6869721cc49d3f33a9252fe90e86eb2cc30b07335dab1151d574778',
  '007_knowledge_vector_index.sql': 'e7d3014d87dd02a598c11904c0c48fda3b82a128ee692eea974a9b2c5861f1e2',
  '008_reply_sources.sql': '0929812d5c8e5e87c3c42806b281778a08178f78d599829bc49860e57c6e081c',
  '009_handoff.sql': '2fbc13e70fa8290b6caf1b3d236923cb5e10e3c7bec2280b348128ba5a486ede',
  '010_platform_super_admin.sql': 'fdcb8a1da520d4d7cdc90e9c6a453d4efeba82e536a33f6c2866f40f096af5de',
  '011_fix_company_admin_wildcard.sql': '66e6a5a6daeb1a42fa471e61d32ac56e6091de9c3d2d1301ad402ce52dfd610a',
  '012_add_brand_default_language.sql': '952527d3fb344ac9859f7d2c180a0a20c7c7a3543caf7b842955e805fbdcc238',
  '013_backfill_knowledge_sources.sql': '722dc8d3939e8b4cd7ff6ada94a90fb0655053e5467eba08f47b7b9e81b8ffb1',
  '015_brand_access_grants.sql': '508159c37a2b0754c6aecf0af2c1f880f7e720ab466a01b55259c6ec77746815',
  '016_manual_reply_idempotency.sql': 'ca280ffb799ab0a555670fffbedcd5272035abbe65da7854a3c2b9cc95ef1c5b',
  '017_escalation_resolve_ability.sql': '093f4df44821ef1a221c543275722581629235328f1117bab4169eb27acb2732',
  '018_handoff_acknowledgment.sql': '5fd7f915a3f8f1ce5b37c6dcfceb96e2ffa5e003353a8b5035ef5420eef0912f',
  '019_ai_routing_rules.sql': '2aa946d57d9cadde2b8d2fc5b5fdf017e5796062796a40e3f39719cbcbfcc356',
  '020_team_lifecycle.sql': '851ac18263dc04752367b490315176ca3552d49e0aa01e8fbfe9506eea3f0db6'
});

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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