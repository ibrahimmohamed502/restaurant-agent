/**
 * Stage 6 Batch 3B — active-mode generation wrapper.
 *
 * shadow mode  → unchanged legacy generation (Path A only).
 * active mode  → retrieval-grounded generation (Path B). If retrieval finds no
 *                usable context, or generation fails, the reply is the SAFE
 *                FALLBACK — the legacy Path A is NEVER used as an automatic
 *                fallback (it could answer ungrounded). Falling back to Path A
 *                requires an explicit rollback of KNOWLEDGE_RETRIEVAL_MODE.
 */
import { retrieveContext, RETRIEVAL_MODE } from './retrieval.js';
import { loadAiConfig } from './aiConfig.js';
import { localize, NOT_CONFIRMED_REPLY } from './grounding.js';
import { pool } from '../db/pg.js';

function guessLang(text) {
  return /[\u0600-\u06FF]/.test(String(text ?? '')) ? 'ar' : 'en';
}

/**
 * @param {object} args
 * @param {(params: object) => Promise<any>} args.analyzeFn  the existing analyzeAndDraft
 * @returns {Promise<{draft: object, retrieval: object|null, safeFallback: boolean}>}
 */
export async function generateWithRetrieval({ text, authorName, channel, ctx, analyzeFn }) {
  if (RETRIEVAL_MODE !== 'active') {
    return { draft: await analyzeFn({ text, authorName, channel, ctx }), retrieval: null, safeFallback: false };
  }

  let rc = null;
  try {
    rc = await retrieveContext({ text, tenantId: ctx.tenantId, brandId: ctx.brandId, db: pool });
  } catch {
    rc = null; // retrieval failure → safe fallback (never Path A)
  }

  const lang = guessLang(text);
  const empty = !rc || (!rc.facts.length && !rc.chunks.length);
  if (empty) {
    return { draft: { intent: 'fallback', inScope: true, escalate: false, reply: localize(NOT_CONFIRMED_REPLY, lang), lang }, retrieval: rc, safeFallback: true };
  }

  const aiConfig = await loadAiConfig({ tenantId: ctx.tenantId }).catch(() => null);
  const draft = await analyzeFn({ text, authorName, channel, ctx, retrieval: rc, aiConfig });
  if (draft?.intent === 'fallback') {
    return { draft: { ...draft, reply: localize(NOT_CONFIRMED_REPLY, draft.lang) }, retrieval: rc, safeFallback: true };
  }
  return { draft, retrieval: rc, safeFallback: false };
}
