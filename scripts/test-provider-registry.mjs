/**
 * Stage 8 Batch 2 — provider registry tests.
 *
 * Run: node scripts/test-provider-registry.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

const registry = await import('../src/providers/registry.js');

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\n🧪 Stage 8 Batch 2 — Provider Registry\n');

console.log('--- registry surface ---');
check('listProviderKeys() returns registered providers', Array.isArray(registry.listProviderKeys()) && registry.listProviderKeys().length > 0);
check('Meta is registered', registry.isRegistered('meta') === true);
check('Unknown provider is not registered', registry.isRegistered('whatsapp') === false, 'whatsapp must not be pre-registered');

const meta = registry.getProvider('meta');
check('getProvider("meta") returns a manifest', Boolean(meta));
check('manifest exposes a key + label', meta?.key === 'meta' && typeof meta?.label === 'string' && meta.label.length > 0);
check('manifest declares channelProviders', Array.isArray(meta?.channelProviders) && meta.channelProviders.includes('meta') && meta.channelProviders.includes('meta_dm') && meta.channelProviders.includes('meta_comment'));
check('manifest declares capabilities', meta?.capabilities?.comments === true && meta?.capabilities?.directMessages === true);
check('manifest exposes the normalizer contract', typeof meta?.normalizeWebhook === 'function' && typeof meta?.normalizeComment === 'function' && typeof meta?.normalizeMessage === 'function');
check('manifest exposes the outbound contract', typeof meta?.sendReply === 'function');
check('getProvider returns a copy (registry not mutable from outside)', (() => {
  const a = registry.getProvider('meta');
  a.key = 'tampered';
  return registry.getProvider('meta').key === 'meta';
})());

console.log('\n--- unknown providers ---');
check('getProvider("unknown") → null', registry.getProvider('unknown') === null);
check('providerLabel falls back to the raw value', registry.providerLabel('something_new') === 'something_new');

console.log('\n--- provider mapping for channels.provider values ---');
check('providerLabel("meta") → Meta label', registry.providerLabel('meta') === meta.label);
check('providerLabel("meta_dm") → Meta label', registry.providerLabel('meta_dm') === meta.label);
check('providerLabel("meta_comment") → Meta label', registry.providerLabel('meta_comment') === meta.label);
check('providerForChannel("meta_dm") → meta manifest', registry.providerForChannel('meta_dm')?.key === 'meta');
check('providerForChannel("whatsapp") → null (not implemented)', registry.providerForChannel('whatsapp') === null);

console.log('\n--- catalog (credential-free, API/UI safe) ---');
const catalog = registry.providerCatalog();
check('catalog is a serializable array', Array.isArray(catalog) && catalog.length === registry.listProviderKeys().length);
check('catalog entries expose key/label/capabilities only', catalog.every((p) => typeof p.key === 'string' && typeof p.label === 'string' && p.capabilities && typeof p.capabilities === 'object'));
check('catalog carries no functions (JSON safe)', catalog.every((p) => Object.values(p).every((v) => typeof v !== 'function')));
check('catalog is JSON serializable', (() => { try { JSON.stringify(catalog); return true; } catch { return false; } })());
check('catalog does not leak credentials (no token-ish keys)', catalog.every((p) => !Object.keys(p).some((k) => /token|secret|credential|password|key_/i.test(k))));

console.log('\n--- meta behaviour is unchanged (regression) ---');
{
  // The registry must delegate to the existing normalizer, untouched.
  const { normalizeMetaWebhook } = await import('../src/providers/meta/normalizer.js');
  const payload = {
    object: 'page',
    entry: [{
      id: 'PAGE123',
      changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', from: { id: 'U1', name: 'Ann' }, message: 'hi', post_id: 'P1' } }],
      messaging: [{ sender: { id: 'PSID1' }, message: { mid: 'M1', text: 'hello' }, timestamp: 1700000000 }]
    }]
  };
  const direct = normalizeMetaWebhook(payload);
  const viaRegistry = meta.normalizeWebhook(payload);
  // receivedAt is stamped at call time — compare everything else.
  const stable = (evts) => JSON.stringify(evts.map(({ receivedAt, ...rest }) => rest));
  check('registry normalizeWebhook === existing normalizer output', stable(direct) === stable(viaRegistry));
  check('comment event normalized', viaRegistry.some((e) => e.eventType === 'comment' && e.eventId === 'C1'));
  check('DM event normalized', viaRegistry.some((e) => e.eventType === 'message' && e.eventId === 'M1'));
  check('normalized events carry provider=meta', viaRegistry.every((e) => e.provider === 'meta'));
  check('non-page payload yields no events (unchanged Meta filter)', meta.normalizeWebhook({ object: 'instagram', entry: [] }).length === 0);
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);