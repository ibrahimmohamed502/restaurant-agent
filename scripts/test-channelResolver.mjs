/**
 * Unit tests for src/services/channelResolver.js (Stage 4.1).
 *
 * Uses a MOCKED db (canned responses matching the resolver's two SQL queries)
 * so the full 10-scenario suite runs locally WITHOUT deploying or touching the
 * production database. Real integration against Postgres runs in the container
 * console post-deploy (see STATUS.md).
 *
 * Run: node scripts/test-channelResolver.mjs
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMetaChannel, RESOLVE_ERRORS } from '../src/services/channelResolver.js';
import { encrypt } from '../src/db/crypto.js';

const SECRET_A = 'TEST_SECRET_A_NEVER_LOG';
const SECRET_OTHER = 'TEST_SECRET_OTHER_TENANT_NEVER_LOG';

/* --------------------------------- fixtures -------------------------------- */

const CHANNELS = [
  { id: 'ch-cv-001', tenant_id: 't-ufc', brand_id: 'b-lwc', provider: 'meta', external_id: 'test_page_cv_001', display_name: 'CV Test Page', status: 'active' },
  { id: 'ch-disabled', tenant_id: 't-ufc', brand_id: 'b-lwc', provider: 'meta', external_id: 'test_page_disabled', display_name: 'Disabled Page', status: 'disabled' },
  { id: 'ch-nocred', tenant_id: 't-ufc', brand_id: 'b-lwc', provider: 'meta', external_id: 'test_page_nocred', display_name: 'NoCred Page', status: 'active' },
  { id: 'ch-other', tenant_id: 't-other', brand_id: 'b-other', provider: 'meta', external_id: 'test_page_other', display_name: 'Other Tenant Page', status: 'active' }
];

const encA = encrypt(SECRET_A);
const encOther = encrypt(SECRET_OTHER);
const CREDS = [
  { channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: encA.value, iv: encA.iv },
  { channel_id: 'ch-other', tenant_id: 't-other', kind: 'page_access_token', value_encrypted: encOther.value, iv: encOther.iv }
];

/** Mock db matching the resolver's two queries (channels + provider_credentials). */
const mockDb = {
  async query(sql, params) {
    if (sql.includes('FROM channels')) {
      const [pageId] = params;
      return { rows: CHANNELS.filter((c) => c.external_id === pageId) };
    }
    if (sql.includes('FROM provider_credentials')) {
      const [channelId, tenantId] = params;
      return { rows: CREDS.filter((c) => c.channel_id === channelId && c.tenant_id === tenantId) };
    }
    throw new Error(`unexpected SQL in mock: ${sql.slice(0, 60)}`);
  }
};

/* ---------------------------------- harness --------------------------------- */

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.error('  ❌', name); }
}

console.log('\n🧪 Stage 4.1 — ChannelResolver unit tests\n');

/* 1-4: happy path + safe base result */
{
  const res = await resolveMetaChannel('test_page_cv_001', { db: mockDb });
  check('1. known pageId resolves to expected channelId', res.channelId === 'ch-cv-001');
  check('2. correct tenantId returned', res.tenantId === 't-ufc');
  check('3. correct brandId returned', res.brandId === 'b-lwc');
  check('4. base result exposes NO credential (safe for logs)', !('credential' in res));

  const resCred = await resolveMetaChannel('test_page_cv_001', { includeCredential: true, db: mockDb });
  check('4b. includeCredential returns the channel own decrypted secret', resCred.credential === SECRET_A);
}

/* 5: unknown page id */
{
  let code = null;
  try { await resolveMetaChannel('unknown_page_999', { db: mockDb }); } catch (e) { code = e.code; }
  check('5. unknown pageId fails with UNKNOWN_META_PAGE', code === RESOLVE_ERRORS.UNKNOWN_META_PAGE);
}

/* 6: inactive/disabled channel */
{
  let code = null;
  try { await resolveMetaChannel('test_page_disabled', { db: mockDb }); } catch (e) { code = e.code; }
  check('6. disabled channel fails with CHANNEL_INACTIVE', code === RESOLVE_ERRORS.CHANNEL_INACTIVE);
}

/* 7: channel without credential */
{
  let code = null;
  try { await resolveMetaChannel('test_page_nocred', { includeCredential: true, db: mockDb }); } catch (e) { code = e.code; }
  check('7. missing credential fails with CREDENTIAL_MISSING', code === RESOLVE_ERRORS.CREDENTIAL_MISSING);
}

/* 8: cross-tenant credential isolation */
{
  const res = await resolveMetaChannel('test_page_cv_001', { includeCredential: true, db: mockDb });
  check('8. credential selected is from the resolved channel+tenant only (no cross-tenant leak)',
    res.credential === SECRET_A && res.tenantId === 't-ufc' && res.brandId === 'b-lwc');
}

/* 9: no decrypted secret in errors */
{
  let leaked = false;
  try { await resolveMetaChannel('unknown_page_999', { includeCredential: true, db: mockDb }); } catch (e) {
    leaked = e.message.includes(SECRET_A) || String(e.stack || '').includes(SECRET_A);
  }
  check('9. no decrypted credential appears in errors', !leaked);
}

/* 10: existing CV bot NOT wired to the resolver yet */
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const webhookSrc = readFileSync(path.join(root, 'src', 'webhook.js'), 'utf8');
  check('10. webhook.js does NOT import channelResolver (not wired — CV bot unaffected)', !webhookSrc.includes('channelResolver'));
}

console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
