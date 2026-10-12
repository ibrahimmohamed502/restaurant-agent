/**
 * Stage 7 — provider-neutral HUMAN outbound registry.
 *
 * The Unified Inbox never talks to a provider directly. It calls
 * `sendHumanOutbound()`, which dispatches to the adapter registered for the
 * conversation's channel provider.
 *
 * Instagram (Stage 8) and WhatsApp (Stage 9) become *adapters* here — no Inbox,
 * API or service redesign is required.
 *
 * ADAPTER CONTRACT (all functions are pure / server-side data only):
 *
 *   resolveTarget({ conversation, channel, lastInbound })
 *     → { kind, identifier }   // derived from DB rows, NEVER from the browser
 *
 *   evaluatePolicy({ target, lastInbound, now })
 *     → { allowed, mode, code, message }
 *
 *   async send({ target, text, credential, policy })
 *     → { providerMessageId }   // throws on failure
 */

const adapters = new Map();

/** Register (or replace) an adapter for a channel provider name. */
export function registerHumanOutboundAdapter(adapter) {
  if (!adapter || !adapter.provider) throw new Error('human outbound adapter requires a provider name');
  adapters.set(adapter.provider, adapter);
  return adapter;
}

/** Resolve the adapter for a provider name. Throws when unsupported. */
export function getHumanOutboundAdapter(provider) {
  const adapter = adapters.get(provider);
  if (!adapter) {
    const err = new Error(`no human outbound adapter registered for provider "${provider}"`);
    err.code = 'HUMAN_OUTBOUND_PROVIDER_UNSUPPORTED';
    throw err;
  }
  return adapter;
}

export function listHumanOutboundAdapters() {
  return [...adapters.keys()];
}
