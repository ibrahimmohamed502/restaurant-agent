/**
 * Stage 4.3A — Provision & verify a Meta routing channel (+ encrypted credential).
 *
 * Idempotent: safe to run multiple times. Reusable for Life With Cacao and future
 * Meta pages via env overrides (PROVISION_*).
 *
 * SECURITY: reads the page token from the runtime environment — never prints it,
 * never stores it plaintext, never includes it in output/logs.
 *
 * Usage: node scripts/provision-meta-channel.mjs
 * Optional env: PROVISION_TENANT_SLUG, PROVISION_BRAND_SLUG, PROVISION_PAGE_ID,
 *               PROVISION_PAGE_TOKEN, PROVISION_DISPLAY_NAME
 */
import 'dotenv/config';
import { pool, enabled } from '../src/db/pg.js';
import { encrypt, decrypt } from '../src/db/crypto.js';
import { resolveMetaChannel, RESOLVE_ERRORS } from '../src/services/channelResolver.js';

const TENANT_SLUG = process.env.PROVISION_TENANT_SLUG || 'ufc';
const BRAND_SLUG = process.env.PROVISION_BRAND_SLUG || 'lwc';
const PAGE_ID = process.env.PROVISION_PAGE_ID || process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.PROVISION_PAGE_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;
const DISPLAY_NAME = process.env.PROVISION_DISPLAY_NAME || `Meta Page ${PAGE_ID}`;

if (!enabled) { console.error('❌ DATABASE_URL not set (legacy mode)'); process.exit(1); }
if (!PAGE_ID) { console.error('❌ no page id (PROVISION_PAGE_ID / FB_PAGE_ID)'); process.exit(1); }
if (!PAGE_TOKEN) { console.error('❌ no page token in env (PROVISION_PAGE_TOKEN / FB_PAGE_ACCESS_TOKEN)'); process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error('❌ ENCRYPTION_KEY not set'); process.exit(1); }

console.log(`\n🔧 Provisioning Meta routing channel for page ${PAGE_ID} (tenant slug '${TENANT_SLUG}', brand slug '${BRAND_SLUG}')\n`);

/* ------------------------- 1) resolve tenant + brand (actual records) ------------------------- */
const { rows: [tenant] } = await pool.query(`SELECT id, slug FROM tenants WHERE slug = $1`, [TENANT_SLUG]);
if (!tenant) { console.error(`❌ tenant '${TENANT_SLUG}' not found`); process.exit(1); }

const { rows: [brand] } = await pool.query(`SELECT id, slug FROM brands WHERE tenant_id = $1 AND slug = $2`, [tenant.id, BRAND_SLUG]);
if (!brand) { console.error(`❌ brand '${BRAND_SLUG}' not found under tenant '${TENANT_SLUG}'`); process.exit(1); }

console.log(`✅ tenant resolved (slug '${tenant.slug}') | brand resolved (slug '${brand.slug}')`);

/* ------------------------- 2) provision routing channel (idempotent) ------------------------- */
const { rows: existingChannels } = await pool.query(
  `SELECT id, status FROM channels WHERE provider = 'meta' AND external_id = $1`,
  [PAGE_ID]
);

let channelId;
let channelExisted = Boolean(existingChannels[0]);
if (channelExisted) {
  channelId = existingChannels[0].id;
  console.log(`ℹ️  routing channel already exists (status '${existingChannels[0].status}')`);
} else {
  const { rows: [created] } = await pool.query(
    `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
     VALUES ($1,$2,'meta',$3,$4,'active') RETURNING id`,
    [tenant.id, brand.id, PAGE_ID, DISPLAY_NAME]
  );
  channelId = created.id;
  console.log(`✅ routing channel created (status 'active')`);
}

/* ------------------------- 3) provision encrypted credential (idempotent) ------------------------- */
const { rows: [cred] } = await pool.query(
  `SELECT id, value_encrypted, iv FROM provider_credentials
   WHERE channel_id = $1 AND tenant_id = $2 AND kind = 'page_access_token'
   ORDER BY created_at DESC LIMIT 1`,
  [channelId, tenant.id]
);

let credentialMatchesLegacyEnv = null;
if (cred) {
  const decrypted = decrypt(cred.value_encrypted, cred.iv);
  credentialMatchesLegacyEnv = decrypted === PAGE_TOKEN; // internal compare only
  console.log(`ℹ️  credential already provisioned | credentialMatchesLegacyEnv: ${credentialMatchesLegacyEnv}`);
} else {
  const enc = encrypt(PAGE_TOKEN);
  await pool.query(
    `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv)
     VALUES ($1,$2,'page_access_token',$3,$4)`,
    [tenant.id, channelId, enc.value, enc.iv]
  );
  credentialMatchesLegacyEnv = true;
  console.log(`✅ credential provisioned (encrypted with Stage 1 AES-256-GCM)`);
}

/* ------------------------- 4) resolver verification ------------------------- */
const resolved = await resolveMetaChannel(PAGE_ID, { includeCredential: true });
const verification = {
  channelExisted,
  channelId: resolved.channelId,
  tenantIdMatches: resolved.tenantId === tenant.id,
  brandIdMatches: resolved.brandId === brand.id,
  provider: resolved.provider,
  externalId: resolved.externalId,
  displayName: resolved.displayName,
  status: resolved.status,
  credentialAvailable: Boolean(resolved.credential),
  credentialMatchesLegacyEnv: resolved.credential === PAGE_TOKEN // internal compare only
};
console.log(`\n🔎 resolveMetaChannel → ${JSON.stringify(verification, null, 2)}`);

/* ------------------------- 5) tenant isolation verification ------------------------- */
const { rows: [credTenant] } = await pool.query(
  `SELECT tenant_id FROM provider_credentials WHERE channel_id = $1 AND kind = 'page_access_token' LIMIT 1`,
  [channelId]
);
console.log(`🔒 channel tenant matches expected: ${verification.tenantIdMatches}`);
console.log(`🔒 credential tenant matches channel tenant: ${credTenant.tenant_id === tenant.id}`);

let unknownFails = false;
try { await resolveMetaChannel('unknown_page_xyz_999'); } catch (e) { unknownFails = e.code === RESOLVE_ERRORS.UNKNOWN_META_PAGE; }
console.log(`🔒 unknown pageId → UNKNOWN_META_PAGE: ${unknownFails}`);

const isoClient = await pool.connect();
let inactiveFails = false;
try {
  await isoClient.query('BEGIN');
  await isoClient.query(`UPDATE channels SET status = 'disabled' WHERE id = $1`, [channelId]);
  try { await resolveMetaChannel(PAGE_ID, { db: isoClient }); } catch (e) { inactiveFails = e.code === RESOLVE_ERRORS.CHANNEL_INACTIVE; }
} finally {
  await isoClient.query('ROLLBACK');
  isoClient.release();
}
console.log(`🔒 disabled channel → CHANNEL_INACTIVE (rolled back): ${inactiveFails}`);

/* ------------------------- 6) DB integrity report ------------------------- */
const { rows: chIndexes } = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'channels'`);
const hasUniqueProviderExternal = chIndexes.some((i) => i.indexdef.toLowerCase().includes('unique') && i.indexdef.includes('provider') && i.indexdef.includes('external_id'));
console.log(`\n🗄️  channels indexes: ${chIndexes.map((i) => i.indexname).join(', ') || '(none)'}`);
console.log(`🗄️  unique constraint on (provider, external_id): ${hasUniqueProviderExternal ? 'EXISTS' : 'MISSING (app-level idempotency used)'}`);

const { rows: credIndexes } = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'provider_credentials'`);
console.log(`🗄️  provider_credentials indexes: ${credIndexes.map((i) => i.indexname).join(', ') || '(none)'}`);

console.log('\n✅ provisioning & verification complete\n');
process.exit(0);
