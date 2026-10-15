/**
 * Stage 8 Batch 2 — provider registry (provider-neutral integration seam).
 *
 * A single lookup point for provider manifests so that integrations code,
 * APIs and the UI never hardcode a provider name. Meta is the only provider
 * registered today; adding another provider is: write `<key>/provider.js` +
 * `<key>/normalizer.js`, then register it below. No change to the webhook,
 * queue, worker or routing paths.
 *
 * CONTRACT (what every provider must expose):
 *   key                 stable provider identifier (matches channels.provider)
 *   label               human-readable name for UI surfaces
 *   channelProviders    channels.provider values owned by this provider
 *   capabilities        { comments, directMessages }
 *   normalizeWebhook    (payload) => NormalizedEvent[]
 *   normalizeComment    (entry, change) => NormalizedEvent
 *   normalizeMessage    (entry, messaging) => NormalizedEvent
 *   sendReply           ({ event, text, credential }) => provider message id
 *
 * SECURITY: manifests never carry credentials. A credential is always resolved
 * from the database at call time (see services/channelResolver.js) and must
 * never be embedded, cached or logged here.
 */
import { normalizeMetaWebhook, normalizeMetaComment, normalizeMetaMessage } from './meta/normalizer.js';
import { sendMetaReply } from './meta/provider.js';

/** @type {Record<string, object>} */
const PROVIDERS = {
  meta: {
    key: 'meta',
    label: 'Meta (Facebook & Messenger)',
    channelProviders: ['meta', 'meta_dm', 'meta_comment'],
    capabilities: { comments: true, directMessages: true },
    normalizeWebhook: normalizeMetaWebhook,
    normalizeComment: normalizeMetaComment,
    normalizeMessage: normalizeMetaMessage,
    sendReply: (event, text, credential) => sendMetaReply(event, text, credential)
  }
};

/** Registered provider keys, in stable order. */
export function listProviderKeys() {
  return Object.keys(PROVIDERS);
}

/** Public manifest for a provider (callers get a shallow, credential-free copy). */
export function getProvider(key) {
  const p = PROVIDERS[key];
  return p ? { ...p } : null;
}

/** Is this provider implemented? Unknown providers are never guessed. */
export function isRegistered(key) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key);
}

/**
 * Display label for a channels.provider value (e.g. 'meta_dm').
 * Falls back to the raw value so unknown/legacy rows still render.
 */
export function providerLabel(channelProvider) {
  for (const p of Object.values(PROVIDERS)) {
    if (p.channelProviders.includes(channelProvider)) return p.label;
  }
  return channelProvider;
}

/** Which provider owns a channels.provider value (or null when unregistered). */
export function providerForChannel(channelProvider) {
  for (const p of Object.values(PROVIDERS)) {
    if (p.channelProviders.includes(channelProvider)) return getProvider(p.key);
  }
  return null;
}

/** Credential-free catalog for UI/API surfaces (no functions are serialized). */
export function providerCatalog() {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key,
    label: p.label,
    channelProviders: [...p.channelProviders],
    capabilities: { ...p.capabilities }
  }));
}