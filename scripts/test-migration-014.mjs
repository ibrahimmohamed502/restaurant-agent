/**
 * Stage 8 Batch 3 — migration 014 safety review.
 *
 * Migration 014 must be ADDITIVE: new columns + new tables only. It must not
 * modify, delete or re-own any existing connection data, and code-only rollback
 * must keep working (routing depends on untouched columns).
 *
 * Run: node scripts/test-migration-014.mjs
 */
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

const sql = readFileSync(new URL('../migrations/014_meta_page_selfservice.sql', import.meta.url), 'utf8');
/** Executable SQL only: strip `--` comments so documentation prose (which may
 * legitimately mention DROP/DELETE for rollback guidance) is not asserted on. */
const executable = sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const norm = executable.replace(/\s+/g, ' ').trim();

console.log('\nStage 8 Batch 3 -- Migration 014 safety\n');

console.log('--- Additive columns only ---');
{
  check('subscription_state added with IF NOT EXISTS + default',
    /ADD COLUMN IF NOT EXISTS subscription_state text NOT NULL DEFAULT 'unknown'/.test(norm));
  check('subscription_error added', norm.includes('ADD COLUMN IF NOT EXISTS subscription_error'));
  check('verified_at added', norm.includes('ADD COLUMN IF NOT EXISTS verified_at'));
  check('meta_scopes added', norm.includes('ADD COLUMN IF NOT EXISTS meta_scopes'));
  check('all ALTER TABLE statements are ADD COLUMN (no destructive ALTER)',
    (executable.match(/ALTER TABLE/g) || []).length === (executable.match(/ADD COLUMN IF NOT EXISTS/g) || []).length);
  check('no DROP anywhere (executable SQL)', !/\bDROP\b/i.test(executable));
  check('no column type change / rename', !/ALTER COLUMN|RENAME|ALTER COLUMN TYPE/i.test(sql));
}

console.log('\n--- No existing data is modified ---');
{
  check('no UPDATE against channels', !/UPDATE\s+channels/i.test(sql));
  check('no UPDATE against provider_credentials', !/UPDATE\s+provider_credentials/i.test(sql));
  check('no DELETE statement (ON DELETE CASCADE is fine)', !/DELETE\s+FROM/i.test(executable));
  check('no TRUNCATE', !/\bTRUNCATE\b/i.test(executable));
  check('no ownership change on existing channels', !/SET\s+tenant_id|SET\s+brand_id/i.test(sql));
  check('legacy rows keep subscription_state = unknown (default, not backfilled)', norm.includes("DEFAULT 'unknown'"));
}

console.log('\n--- New OAuth tables ---');
{
  check('oauth_connect_states created', /CREATE TABLE IF NOT EXISTS oauth_connect_states/.test(sql));
  check('state stores a nonce HASH (raw nonce never persisted)', /nonce_hash\s+text NOT NULL UNIQUE/.test(sql));
  check('state bound to tenant + user', /tenant_id\s+uuid NOT NULL/.test(sql) && /user_id\s+uuid NOT NULL/.test(sql));
  check('state supports atomic single-use consumption', /consumed_at\s+timestamptz/.test(sql));
  check('state has an expiry', /expires_at\s+timestamptz NOT NULL/.test(sql));
  check('expiry index for lazy cleanup', /idx_oauth_states_expiry/.test(sql));
  check('session index', /idx_oauth_states_session/.test(sql));

  check('oauth_connect_flows created (separate picker/connect authorization)', /CREATE TABLE IF NOT EXISTS oauth_connect_flows/.test(sql));
  check('flow stores a token HASH', /token_hash\s+text NOT NULL/.test(sql));
  check('flow is session-bound', /user_id\s+uuid NOT NULL/.test(sql));
  check('flow is single-use', /consumed_at\s+timestamptz/.test(sql));

  check('oauth_connect_pages created (server-held page tokens)', /CREATE TABLE IF NOT EXISTS oauth_connect_pages/.test(sql));
  check('page tokens stored encrypted with an IV', /token_encrypted\s+bytea NOT NULL/.test(sql) && /iv\s+bytea NOT NULL/.test(sql));
  check('page set is unique per flow', /UNIQUE \(flow_id, page_id\)/.test(sql));
  check('pages cascade when the flow is deleted', /REFERENCES oauth_connect_flows\(id\) ON DELETE CASCADE/.test(sql));
  check('flows cascade when the state is deleted', /REFERENCES oauth_connect_states\(id\) ON DELETE CASCADE/.test(sql));
}

console.log('\n--- Page-token expiry policy ---');
{
  check('migration does NOT touch provider_credentials.expires_at', !/provider_credentials/i.test(executable));
  check('documented that page tokens have no expiry', /Page access token has no documented expiry|no documented expiry/i.test(sql));
  check('documented that user-token expiry stays on the flow', /User-token expiry lives on the short-lived OAuth flow/i.test(sql));
}

console.log('\n--- Rollback documentation ---');
{
  check('rollback documented in the header', /ROLLBACK/i.test(sql));
  check('rollback states code-only rollback needs no schema change', /code-only rollback needs no schema change/i.test(sql));
  check('destructive rollback flagged as requiring approval', /separate owner approval/i.test(sql));
}

console.log('\n--- Runtime compatibility (new columns are descriptive) ---');
{
  const resolver = readFileSync(new URL('../src/services/channelResolver.js', import.meta.url), 'utf8');
  check('channelResolver still keys on provider/external_id (unaffected)',
    /c\.external_id = \$1/.test(resolver) && /c\.provider IN/.test(resolver));
  check('no routing dependency on the new columns', !/subscription_state|verified_at|meta_scopes/.test(resolver));
  const creds = readFileSync(new URL('../src/services/channelResolver.js', import.meta.url), 'utf8');
  check('credential lookup unchanged (channel_id + tenant_id + kind)', /WHERE channel_id = \$1 AND tenant_id = \$2 AND kind = 'page_access_token'/.test(creds));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);