/**
 * Stage 5 — Knowledge Base API v1 (tenant-scoped, RBAC-enforced).
 *
 * Tenant identity ALWAYS comes from the authenticated session (req.v1). The
 * browser can only choose a brandId (validated against the session tenant).
 * Publishing requires Company Admin; editing requires Company Admin or
 * Supervisor; agents get read-only access to the published knowledge.
 */
import express from 'express';
import { requireV1Auth, requireV1Role, apiError } from './index.js';
import {
  resolveKnowledgeSource,
  getAnyDraft,
  getPublishedKnowledge,
  getDraft,
  saveDraft,
  discardDraft,
  publishDraft,
  getPublicationHistory,
  validateKnowledge,
  diffKnowledge
} from '../../services/knowledge.js';

const COMPANY_ADMIN = 'Company Admin';

export function createKnowledgeRouter({ pool }) {
  const router = express.Router();
  router.use(requireV1Auth);

  const tenantOf = (req) => req.v1.tenantId;
  const rolesOf = (req) => req.v1.roles || [];
  const canEdit = (req) => rolesOf(req).includes(COMPANY_ADMIN) || rolesOf(req).includes('Supervisor');
  const canPublish = (req) => rolesOf(req).includes(COMPANY_ADMIN);
  const scope = (req) => ({ tenantId: tenantOf(req), db: pool });

  /** Resolve the source for the session tenant (+ optional brand), 404 when absent. */
  async function withSource(req, res, fn) {
    const source = await resolveKnowledgeSource({ ...scope(req), brandId: req.query.brandId ?? null });
    if (!source) return apiError(res, 404, 'KNOWLEDGE_SOURCE_NOT_FOUND', 'no knowledge source for this tenant/brand');
    return fn(source);
  }

  /* ------------------------------------------------------------- overview */
  router.get('/', async (req, res) => {
    try {
      const source = await resolveKnowledgeSource({ ...scope(req), brandId: req.query.brandId ?? null });
      if (!source) return apiError(res, 404, 'KNOWLEDGE_SOURCE_NOT_FOUND', 'no knowledge source for this tenant/brand');
      const [published, draft, history] = await Promise.all([
        getPublishedKnowledge({ ...scope(req), sourceId: source.id }),
        getDraft({ ...scope(req), sourceId: source.id }),
        getPublicationHistory({ ...scope(req), sourceId: source.id })
      ]);
      return res.json({
        data: {
          source: { id: source.id, kind: source.kind, title: source.title, brandId: source.brand_id },
          published: published ? { version: published.version, updatedAt: published.updated_at, structured: published.structured } : null,
          draft: draft ? { id: draft.id, baseVersion: draft.base_version, status: draft.status, updatedAt: draft.updated_at, content: draft.content } : null,
          history,
          permissions: { canEdit: canEdit(req), canPublish: canPublish(req) }
        }
      });
    } catch (err) {
      console.error('api/v1 knowledge list failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ---------------------------------------------------------------- draft */
  router.post('/draft', async (req, res) => {
    if (!canEdit(req)) return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    return withSource(req, res, async (source) => {
      try {
        const published = await getPublishedKnowledge({ ...scope(req), sourceId: source.id });
        if (!published) return apiError(res, 404, 'NO_PUBLISHED_KNOWLEDGE', 'nothing published yet');
        const existing = await getDraft({ ...scope(req), sourceId: source.id });
        if (existing) return res.json({ data: { draft: shapeDraft(existing), created: false } });
        const { draft, created } = await saveDraft({
          ...scope(req),
          sourceId: source.id,
          content: published.structured, baseVersion: published.version,
          userId: req.v1.user?.id
        });
        return res.json({ data: { draft: shapeDraft(draft), created } });
      } catch (err) {
        console.error('api/v1 knowledge draft failed:', err.message);
        return apiError(res, 500, 'INTERNAL', 'unexpected error');
      }
    });
  });

  router.put('/draft', async (req, res) => {
    if (!canEdit(req)) return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    return withSource(req, res, async (source) => {
      try {
        const { content, baseVersion } = req.body ?? {};
        if (!content || typeof content !== 'object' || Array.isArray(content)) {
          return apiError(res, 422, 'VALIDATION_ERROR', 'draft content must be an object');
        }
        const existing = await getAnyDraft({ ...scope(req), sourceId: source.id });
        // optimistic concurrency: a stale baseVersion cannot silently overwrite newer data.
        // A non-editing (published/discarded) draft is simply reset to editing.
        if (existing && existing.status === 'editing' && Number(existing.base_version) !== Number(baseVersion)) {
          return apiError(res, 409, 'STALE_DRAFT', 'this draft is based on an older version — reload before saving', {
            expectedBaseVersion: existing.base_version,
            receivedBaseVersion: baseVersion ?? null
          });
        }
        const published = await getPublishedKnowledge({ ...scope(req), sourceId: source.id });
        const base = existing && existing.status === 'editing' ? existing.base_version : (published?.version ?? 1);
        const { draft } = await saveDraft({ ...scope(req), sourceId: source.id, content, baseVersion: base, userId: req.v1.user?.id });
        const validation = validateKnowledge(content);
        return res.json({
          data: {
            draft: shapeDraft(draft),
            validation: { ok: validation.ok, errorCount: validation.errors.length, errors: validation.errors.slice(0, 100) }
          }
        });
      } catch (err) {
        console.error('api/v1 knowledge save failed:', err.message);
        return apiError(res, 500, 'INTERNAL', 'unexpected error');
      }
    });
  });

  router.post('/validate', async (req, res) => {
    if (!canEdit(req)) return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    return withSource(req, res, async (source) => {
      const draft = await getDraft({ ...scope(req), sourceId: source.id });
      if (!draft) return apiError(res, 404, 'NO_DRAFT', 'no draft to validate');
      const validation = validateKnowledge(draft.content);
      const published = await getPublishedKnowledge({ ...scope(req), sourceId: source.id });
      return res.json({
        data: {
          ok: validation.ok,
          errorCount: validation.errors.length,
          errors: validation.errors.slice(0, 100),
          review: diffKnowledge(published?.structured ?? {}, draft.content)
        }
      });
    });
  });

  router.post('/preview', async (req, res) => {
    if (!canEdit(req)) return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    return withSource(req, res, async (source) => {
      const draft = await getDraft({ ...scope(req), sourceId: source.id });
      if (!draft) return apiError(res, 404, 'NO_DRAFT', 'no draft to preview');
      const published = await getPublishedKnowledge({ ...scope(req), sourceId: source.id });
      const validation = validateKnowledge(draft.content);
      return res.json({
        data: {
          validation: { ok: validation.ok, errorCount: validation.errors.length, errors: validation.errors.slice(0, 100) },
          review: diffKnowledge(published?.structured ?? {}, draft.content),
          preview: draft.content
        }
      });
    });
  });

  router.post('/publish', async (req, res) => {
    if (!canPublish(req)) return apiError(res, 403, 'FORBIDDEN', 'publishing requires Company Admin');
    return withSource(req, res, async (source) => {
      try {
        const result = await publishDraft({ ...scope(req), sourceId: source.id, userId: req.v1.user?.id });
        if (!result.ok) {
          if (result.code === 'VALIDATION_FAILED') {
            return apiError(res, 422, 'VALIDATION_FAILED', 'draft has validation errors', { errors: (result.errors ?? []).slice(0, 100) });
          }
          return apiError(res, 404, 'NO_DRAFT', 'no draft to publish');
        }
        const [published, history] = await Promise.all([
          getPublishedKnowledge({ ...scope(req), sourceId: source.id }),
          getPublicationHistory({ ...scope(req), sourceId: source.id })
        ]);
        return res.json({ data: { version: result.version, published: published ? { version: published.version, updatedAt: published.updated_at } : null, history } });
      } catch (err) {
        console.error('api/v1 knowledge publish failed:', err.message);
        return apiError(res, 500, 'PUBLISH_FAILED', 'publish failed — the published version is unchanged');
      }
    });
  });

  router.post('/discard', async (req, res) => {
    if (!canEdit(req)) return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
    return withSource(req, res, async (source) => {
      const discarded = await discardDraft({ ...scope(req), sourceId: source.id });
      return res.json({ data: { discarded } });
    });
  });

  router.get('/history', async (req, res) => {
    return withSource(req, res, async (source) => {
      const history = await getPublicationHistory({ ...scope(req), sourceId: source.id, limit: 50 });
      return res.json({ data: history });
    });
  });

  return router;
}

function shapeDraft(draft) {
  return {
    id: draft.id,
    baseVersion: draft.base_version,
    status: draft.status,
    updatedAt: draft.updated_at,
    content: draft.content
  };
}
