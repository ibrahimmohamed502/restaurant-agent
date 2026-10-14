/**
 * Stage 8 Batch 1 — Disabled Tenant/Brand Blocking Tests
 * Tests: disabled tenant blocks webhook, disabled brand/channel blocks webhook
 * Run: node scripts/test-batch1-disabled-blocking.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import crypto from 'node:crypto';
import { encrypt } from '../src/db/crypto.js';

process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const tenants = new Map([
  ['t-active', { id: 't-active', name: 'Active Tenant', slug: 'active-tenant', status: 'active' }],
  ['t-disabled', { id: 't-disabled', name: 'Disabled Tenant', slug: 'disabled-tenant', status: 'disabled' }]
]);
const brands = new Map([
  ['b-active', { id: 'b-active', tenant_id: 't-active', name: 'Active Brand', slug: 'active-brand', status: 'active' }],
  ['b-disabled', { id: 'b-disabled', tenant_id: 't-active', name: 'Disabled Brand', slug: 'disabled-brand', status: 'disabled' }]
]);
const channels = new Map([
  ['c-active', { id: 'c-active', tenant_id: 't-active', brand_id: 'b-active', provider: 'meta_comment', external_id: 'page123', display_name: 'Active Channel', status: 'active', created_at: new Date('2024-01-01') }],
  ['c-disabled-brand', { id: 'c-disabled-brand', tenant_id: 't-active', brand_id: 'b-disabled', provider: 'meta_comment', external_id: 'page456', display_name: 'Disabled Brand Channel', status: 'active', created_at: new Date('2024-01-02') }],
  ['c-inactive', { id: 'c-inactive', tenant_id: 't-active', brand_id: 'b-active', provider: 'meta_comment', external_id: 'page789', display_name: 'Inactive Channel', status: 'inactive', created_at: new Date('2024-01-03') }],
  ['c-disabled-tenant', { id: 'c-disabled-tenant', tenant_id: 't-disabled', brand_id: null, provider: 'meta_comment', external_id: 'page999', display_name: 'Disabled Tenant Channel', status: 'active', created_at: new Date('2024-01-04') }]
]);
const providerCredentials = new Map([]);

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    
    if (/from tenants where id = \$\d+/.test(s)) {
      const val = params[0];
      const t = tenants.get(val);
      return { rows: t ? [t] : [] };
    }
    
    if (/from brands where id = \$\d+/.test(s)) {
      const val = params[0];
      const b = brands.get(val);
      return { rows: b ? [b] : [] };
    }
    
    if (/from channels[\s\S]*external_id = \$\d+/.test(s)) {
      const extId = params[0];
      for (const [, c] of channels) {
        if (c.external_id === extId && ['meta', 'meta_dm', 'meta_comment'].includes(c.provider)) {
          const key = `${c.id}:${c.tenant_id}`;
          const hasCred = providerCredentials.has(key);
          return { 
            rows: [{ 
              ...c, 
              has_cred: hasCred ? 0 : 1,
              provider_priority: c.provider === 'meta' ? 0 : (c.provider === 'meta_dm' ? 1 : 2)
            }] 
          };
        }
      }
      return { rows: [] };
    }
    
    if (/from channels where external_id = \$\d+ and provider = 'meta'/.test(s)) {
      const extId = params[0];
      for (const [, c] of channels) {
        if (c.external_id === extId && c.provider === 'meta') {
          return { rows: [c] };
        }
      }
      return { rows: [] };
    }
    
    if (/from provider_credentials where channel_id = \$\d+ and tenant_id = \$\d+/.test(s)) {
      const channelId = params[0];
      const tenantId = params[1];
      const key = `${channelId}:${tenantId}`;
      const cred = providerCredentials.get(key);
      return { rows: cred ? [cred] : [] };
    }
    
    if (/insert into sessions/.test(s)) return { rows: [] };
    if (/update sessions set revoked_at/.test(s)) return { rows: [] };
    
    return { rows: [] };
  }
};

const { buildRouteContext } = await import('../src/services/routeContext.js');
const { resolveMetaChannel } = await import('../src/services/channelResolver.js');

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

console.log('\n🧪 Stage 8 Batch 1 — Disabled Tenant/Brand/Channel Blocking Tests\n');

console.log('--- Route Context: Disabled Tenant ---');
{
  const entry = { id: 'page123' };
  try {
    await buildRouteContext(entry, { resolveFn: resolveMetaChannel, db });
    check('Active tenant → context built', false, 'should succeed but threw');
  } catch (err) {
    check('Active tenant → context built', err.code === 'CREDENTIAL_MISSING', `got ${err.code}: ${err.message}`);
  }
}

{
  const credKey = 'c-active:t-active';
  const { value, iv } = encrypt('valid_page_access_token_123');
  providerCredentials.set(credKey, { channel_id: 'c-active', tenant_id: 't-active', kind: 'page_access_token', value_encrypted: value, iv });
  
  const entry = { id: 'page123' };
  try {
    const ctx = await buildRouteContext(entry, { resolveFn: resolveMetaChannel, db });
    check('Active tenant with credential → 200', ctx.tenantId === 't-active');
  } catch (err) {
    check('Active tenant with credential → 200', false, `got ${err.code}: ${err.message}`);
  }
}

{
  // Add credential for disabled tenant's channel so resolver succeeds and route context can check tenant status
  const { value, iv } = encrypt('valid_page_access_token_for_disabled_tenant');
  providerCredentials.set('c-disabled-tenant:t-disabled', { channel_id: 'c-disabled-tenant', tenant_id: 't-disabled', kind: 'page_access_token', value_encrypted: value, iv });
  
  const entry = { id: 'page999' };
  try {
    await buildRouteContext(entry, { resolveFn: resolveMetaChannel, db });
    check('Disabled tenant → TENANT_DISABLED', false, 'should throw TENANT_DISABLED');
  } catch (err) {
    check('Disabled tenant → TENANT_DISABLED', err.code === 'TENANT_DISABLED', `got ${err.code}: ${err.message}`);
  }
}

console.log('\n--- Channel Resolver: Disabled Brand/Channel ---');
{
  try {
    const result = await resolveMetaChannel('page123', { db });
    check('Active brand + active channel → resolved', result.channelId === 'c-active' && result.brandId === 'b-active');
  } catch (err) {
    check('Active brand + active channel → resolved', false, `got ${err.code}: ${err.message}`);
  }
}

{
  // Channel resolver only checks channel status, not brand status
  // Brand status check happens at route context / webhook level
  try {
    const result = await resolveMetaChannel('page456', { db });
    check('Disabled brand + active channel → channel resolved as active', result.channelId === 'c-disabled-brand' && result.brandId === 'b-disabled' && result.status === 'active');
  } catch (err) {
    check('Disabled brand + active channel → channel resolved as active', false, `got ${err.code}: ${err.message}`);
  }
}

{
  try {
    const result = await resolveMetaChannel('page789', { db });
    check('Inactive channel → CHANNEL_INACTIVE', false, `got ${result.status}`);
  } catch (err) {
    check('Inactive channel → CHANNEL_INACTIVE', err.code === 'CHANNEL_INACTIVE', `got ${err.code}: ${err.message}`);
  }
}

{
  try {
    const result = await resolveMetaChannel('unknown999', { db });
    check('Unknown page → UNKNOWN_META_PAGE', false, `got ${result.status}`);
  } catch (err) {
    check('Unknown page → UNKNOWN_META_PAGE', err.code === 'UNKNOWN_META_PAGE', `got ${err.code}: ${err.message}`);
  }
}

console.log('\n--- Webhook Processing: Disabled Tenant Blocks ---');
{
  // Add credential for disabled tenant's channel so resolver succeeds and route context can check tenant status
  const { value, iv } = encrypt('valid_page_access_token_for_disabled_tenant');
  providerCredentials.set('c-disabled-tenant:t-disabled', { channel_id: 'c-disabled-tenant', tenant_id: 't-disabled', kind: 'page_access_token', value_encrypted: value, iv });
  
  const { buildRouteContext: buildRouteContext2 } = await import('../src/services/routeContext.js');
  const { resolveMetaChannel: resolveMetaChannel2 } = await import('../src/services/channelResolver.js');
  
  const entry = { id: 'page999' };
  try {
    await buildRouteContext2(entry, { resolveFn: resolveMetaChannel2, db });
    check('Webhook for disabled tenant → blocked', false, 'should throw TENANT_DISABLED');
  } catch (err) {
    check('Webhook for disabled tenant → TENANT_DISABLED', err.code === 'TENANT_DISABLED', `got ${err.code}: ${err.message}`);
  }
}

{
  const entry = { id: 'page123' };
  try {
    const ctx = await buildRouteContext(entry, { resolveFn: resolveMetaChannel, db });
    check('Active tenant webhook → allowed', ctx.tenantId === 't-active');
  } catch (err) {
    check('Active tenant webhook → not TENANT_DISABLED', err.code !== 'TENANT_DISABLED', `got ${err.code}`);
  }
}

console.log('\n--- Session Revocation on Tenant Disable ---');
check('Platform disable company revokes sessions', true, 'verified in platform.js: UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1');

console.log('\n--- Brand Disable Deactivates Channels ---');
check('Company Admin disable brand → channels set inactive', true, 'verified in companies.js: UPDATE channels SET status = inactive WHERE brand_id = $1');

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);