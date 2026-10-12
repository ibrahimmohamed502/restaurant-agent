/**
 * Stage 6 Batch 1 — Gemini native embeddings.
 *
 * VERIFIED against the live environment:
 *   provider : Google Gemini native API (generativelanguage.googleapis.com/v1beta)
 *   model    : gemini-embedding-001
 *   dims     : 768 (outputDimensionality) — matches knowledge_chunks.embedding vector(768)
 *
 * Rate limits: the free quota is a few embed requests/minute. embedBatch
 * therefore throttles between requests and RETRIES 429/5xx with exponential
 * backoff (honouring Retry-After when present). The API key is read from the
 * runtime environment and NEVER logged, returned, or included in errors.
 */

const EMBED_MODEL = process.env.KNOWLEDGE_EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIMS = Number(process.env.KNOWLEDGE_EMBED_DIMS || 768);
const BATCH_SIZE = Number(process.env.KNOWLEDGE_EMBED_BATCH || 8);
const BATCH_DELAY_MS = Number(process.env.KNOWLEDGE_EMBED_DELAY_MS || 1500);
const MAX_ATTEMPTS = Number(process.env.KNOWLEDGE_EMBED_ATTEMPTS || 6);

function baseUrl() {
  const raw = process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
  // the app's LLM_BASE_URL ends with /openai (OpenAI-compat layer) — strip it to
  // reach the native v1beta API (verified: the compat layer has no /embeddings)
  return raw.replace(/\/openai\/?$/, '').replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertCredentials() {
  if (!process.env.LLM_API_KEY) {
    const err = new Error('embedding credential not configured');
    err.code = 'EMBED_CREDENTIALS_MISSING';
    throw err;
  }
}

function parseRetryAfter(ms) {
  // Gemini returns { error: { details: [ { retryDelay: '17s' } ] } }
  const m = /(\d+(?:\.\d+)?)\s*s/i.exec(String(ms ?? ''));
  return m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : null;
}

async function postWithRetry(url, body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && !json.error) return json;

      const status = res.status;
      const retryAfter = parseRetryAfter(json?.error?.details?.[0]?.retryDelay ?? json?.error?.message);
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        const err = new Error(`embedding failed (${status})`);
        err.code = 'EMBED_API_ERROR';
        err.status = status;
        throw err;
      }
      const delay = retryAfter ?? Math.min(2000 * 2 ** (attempt - 1), 45000);
      await sleep(delay);
    } catch (err) {
      // network-level failure — retry unless exhausted
      if (err.code === 'EMBED_API_ERROR' || attempt === MAX_ATTEMPTS) throw err;
      lastErr = err;
      await sleep(Math.min(2000 * 2 ** (attempt - 1), 45000));
    }
  }
  throw lastErr ?? Object.assign(new Error('embedding failed'), { code: 'EMBED_API_ERROR' });
}

function assertVector(values) {
  if (!Array.isArray(values) || values.length !== EMBED_DIMS) {
    const err = new Error(`embedding dimension mismatch (got ${values?.length ?? 'n/a'}, expected ${EMBED_DIMS})`);
    err.code = 'EMBED_DIM_MISMATCH';
    throw err;
  }
}

/**
 * Embed ONE text → number[768]. Throws with sanitized messages only.
 */
export async function embedText(text) {
  assertCredentials();
  const input = String(text ?? '');
  if (!input.trim()) {
    const err = new Error('empty embedding input');
    err.code = 'EMBED_EMPTY_INPUT';
    throw err;
  }
  const url = `${baseUrl()}/models/${EMBED_MODEL}:embedContent?key=${encodeURIComponent(process.env.LLM_API_KEY)}`;
  const json = await postWithRetry(url, {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: input }] },
    outputDimensionality: EMBED_DIMS
  });
  assertVector(json.embedding?.values);
  return json.embedding.values;
}

/**
 * Embed MANY texts → number[][768].
 * Batch requests are throttled + retried; on persistent failure the caller
 * (indexing pipeline) marks the version failed — partial data is never served.
 */
export async function embedBatch(texts, { batchSize = BATCH_SIZE, delayMs = BATCH_DELAY_MS } = {}) {
  const inputs = (texts ?? []).map((t) => String(t ?? ''));
  if (!inputs.length) return [];
  assertCredentials();
  const out = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const slice = inputs.slice(i, i + batchSize);
    const url = `${baseUrl()}/models/${EMBED_MODEL}:batchEmbedContents?key=${encodeURIComponent(process.env.LLM_API_KEY)}`;
    const json = await postWithRetry(url, {
      requests: slice.map((text) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIMS
      }))
    });
    if (Array.isArray(json.embeddings) && json.embeddings.length === slice.length) {
      for (const e of json.embeddings) {
        assertVector(e?.values);
        out.push(e.values);
      }
    } else {
      // sequential fallback — same guarantees, slower
      for (const text of slice) out.push(await embedText(text));
    }
    if (i + batchSize < inputs.length && delayMs > 0) await sleep(delayMs);
  }
  return out;
}

export const EMBEDDING_CONFIG = { model: EMBED_MODEL, dims: EMBED_DIMS };
