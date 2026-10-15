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
  // created_at is NOT NULL in production; the resolver orders on it.
  { id: 'cr-a', channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: encA.value, iv: encA.iv, created_at: '2026-10-01T00:00:00.000Z' },
  { id: 'cr-other', channel_id: 'ch-other', tenant_id: 't-other', kind: 'page_access_token', value_encrypted: encOther.value, iv: encOther.iv, created_at: '2026-10-01T00:00:00.000Z' }
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
      const rows = CREDS.filter((c) => c.channel_id === channelId && c.tenant_id === tenantId);
      // Honour the resolver's ORDER BY so the selection is behavioural, not
      // accidental array order.
      if (/ORDER BY created_at DESC, id DESC/.test(sql)) {
        rows.sort((a, b) => (a.created_at === b.created_at ? String(b.id).localeCompare(String(a.id)) : String(b.created_at).localeCompare(String(a.created_at))));
      }
      return { rows: rows.slice(0, 1) };
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

/* 11: duplicate page_access_token rows (production really has them) */
{
  const before = CREDS.length;
  // Same channel, three historical rotations, encrypted like production.
  const SECRET_OLDEST = 'TEST_SECRET_OLDEST_NEVER_LOG';
  const SECRET_MIDDLE = 'TEST_SECRET_MIDDLE_NEVER_LOG';
  const SECRET_NEWEST = 'TEST_SECRET_NEWEST_NEVER_LOG';
  const e1 = encrypt(SECRET_OLDEST), e2 = encrypt(SECRET_MIDDLE), e3 = encrypt(SECRET_NEWEST);
  CREDS.push(
    { id: 'cr-dup-1', channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: e1.value, iv: e1.iv, created_at: '2026-10-08T11:35:42.120Z' },
    { id: 'cr-dup-2', channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: e2.value, iv: e2.iv, created_at: '2026-10-08T19:12:26.266Z' },
    { id: 'cr-dup-3', channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: e3.value, iv: e3.iv, created_at: '2026-10-11T09:34:57.573Z' }
  );
  let code = null, cred = null;
  try { cred = (await resolveMetaChannel('test_page_cv_001', { includeCredential: true, db: mockDb })).credential; } catch (e) { code = e.code; }
  check('11a. duplicates do not break resolution', code === null);
  check('11b. the NEWEST duplicate is the credential actually used', cred === SECRET_NEWEST, String(cred));
  check('11c. stale historical rotations are NOT used',
    cred !== SECRET_OLDEST && cred !== SECRET_MIDDLE);
  CREDS.length = before;
}

/* 12: ties on created_at are broken deterministically by id */
{
  const before = CREDS.length;
  const TIE_A = 'TEST_SECRET_TIE_A_NEVER_LOG';
  const TIE_B = 'TEST_SECRET_TIE_B_NEVER_LOG';
  const ta = encrypt(TIE_A), tb = encrypt(TIE_B);
  const tie = '2026-10-11T09:34:57.573Z';
  CREDS.push(
    { id: 'cr-tie-a', channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: ta.value, iv: ta.iv, created_at: tie },
    { id: 'cr-tie-b', channel_id: 'ch-cv-001', tenant_id: 't-ufc', kind: 'page_access_token', value_encrypted: tb.value, iv: tb.iv, created_at: tie }
  );
  const first = await resolveMetaChannel('test_page_cv_001', { includeCredential: true, db: mockDb });
  const second = await resolveMetaChannel('test_page_cv_001', { includeCredential: true, db: mockDb });
  check('12a. tied rows resolve to the same row on every call', first.credential === second.credential);
  // id DESC => cr-tie-b wins deterministically
  check('12b. the tie is broken by id DESC, not by chance', first.credential === TIE_B, String(first.credential));
  CREDS.length = before;
}

console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
