/**
 * Stage 5 — Knowledge Base service layer.
 *
 * Draft → validate → preview → publish workflow on top of the existing
 * knowledge_sources / knowledge_documents model. Production AI keeps reading the
 * PUBLISHED document (see services/aiContext.js, which now filters
 * status='published' and picks the newest version), so a draft is never consumed
 * by the live AI before publication.
 *
 * All functions are tenant-scoped: the tenant always comes from the session.
 * `db` defaults to the shared pool and is injectable for tests.
 */
import { pool as defaultPool } from '../db/pg.js';

/* ------------------------------------------------------------------ reads */

/** Resolve the knowledge source for a tenant (+ optional brand). */
export async function resolveKnowledgeSource({ tenantId, brandId = null, db = defaultPool }) {
  const params = [tenantId];
  let sql = `SELECT id, tenant_id, brand_id, kind, title FROM knowledge_sources WHERE tenant_id = $1`;
  if (brandId) {
    sql += ` AND brand_id = $2`;
    params.push(brandId);
  }
  sql += ` ORDER BY created_at ASC LIMIT 1`;
  const { rows } = await db.query(sql, params);
  return rows[0] ?? null;
}

/** Current PUBLISHED structured knowledge (never a draft). */
export async function getPublishedKnowledge({ tenantId, sourceId, db = defaultPool }) {
  const { rows } = await db.query(
    `SELECT d.id, d.source_id, d.version, d.updated_at, d.structured
       FROM knowledge_documents d
       JOIN knowledge_sources s ON s.id = d.source_id
      WHERE d.source_id = $1 AND s.tenant_id = $2 AND d.status = 'published'
      ORDER BY d.version DESC, d.updated_at DESC
      LIMIT 1`,
    [sourceId, tenantId]
  );
  return rows[0] ?? null;
}

export async function getDraft({ tenantId, sourceId, db = defaultPool }) {
  // Only an EDITING draft is exposed as a working draft.
  const { rows } = await db.query(
    `SELECT id, source_id, base_version, content, status, updated_at FROM knowledge_drafts WHERE tenant_id = $1 AND source_id = $2 AND status = 'editing'`,
    [tenantId, sourceId]
  );
  return rows[0] ?? null;
}

/** Any draft row (including published/discarded history of the working copy). */
export async function getAnyDraft({ tenantId, sourceId, db = defaultPool }) {
  const { rows } = await db.query(
    `SELECT id, source_id, base_version, content, status, updated_at FROM knowledge_drafts WHERE tenant_id = $1 AND source_id = $2`,
    [tenantId, sourceId]
  );
  return rows[0] ?? null;
}

export async function getPublicationHistory({ tenantId, sourceId, limit = 20, db = defaultPool }) {
  const { rows } = await db.query(
    `SELECT p.version, p.created_at, u.name AS published_by_name
       FROM knowledge_publications p
       LEFT JOIN users u ON u.id = p.published_by
      WHERE p.tenant_id = $1 AND p.source_id = $2
      ORDER BY p.created_at DESC
      LIMIT $3`,
    [tenantId, sourceId, limit]
  );
  return rows;
}

/* ----------------------------------------------------------------- writes */

/** Create or update the single working draft for a tenant/source. */
export async function saveDraft({ tenantId, sourceId, content, baseVersion, userId, db = defaultPool }) {
  const existing = await getAnyDraft({ tenantId, sourceId, db });
  if (existing) {
    // A previously published/discounted draft row is reusable: reset it to editing.
    const { rows } = await db.query(
      `UPDATE knowledge_drafts
          SET content = $1, base_version = $2, status = 'editing', updated_by = $3, updated_at = now()
        WHERE tenant_id = $4 AND source_id = $5
        RETURNING id, base_version, content, status, updated_at`,
      [JSON.stringify(content), baseVersion, userId ?? null, tenantId, sourceId]
    );
    return { draft: rows[0], created: false };
  }
  const { rows } = await db.query(
    `INSERT INTO knowledge_drafts (tenant_id, source_id, base_version, content, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING id, base_version, content, status, updated_at`,
    [tenantId, sourceId, baseVersion, JSON.stringify(content), userId ?? null]
  );
  return { draft: rows[0], created: true };
}

export async function discardDraft({ tenantId, sourceId, db = defaultPool }) {
  const { rowCount } = await db.query(
    `UPDATE knowledge_drafts SET status = 'discarded', updated_at = now() WHERE tenant_id = $1 AND source_id = $2 AND status = 'editing'`,
    [tenantId, sourceId]
  );
  return rowCount > 0;
}

/**
 * Atomic publish: archive the current published document, insert the new
 * published version from the draft, record the publication, reset the draft.
 * All inside one transaction — no partial publish is possible.
 */
export async function publishDraft({ tenantId, sourceId, userId, db = defaultPool }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const draftRes = await client.query(
      `SELECT id, content, base_version FROM knowledge_drafts WHERE tenant_id = $1 AND source_id = $2 AND status = 'editing' FOR UPDATE`,
      [tenantId, sourceId]
    );    const draft = draftRes.rows[0];
    if (!draft) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'NO_DRAFT' };
    }

    // validate inside the transaction — an invalid draft can never publish
    const validation = validateKnowledge(draft.content);
    if (!validation.ok) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'VALIDATION_FAILED', errors: validation.errors };
    }

    const maxRes = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int AS max_version FROM knowledge_documents WHERE source_id = $1`,
      [sourceId]
    );
    const nextVersion = Math.max(maxRes.rows[0].max_version, draft.base_version) + 1;

    await client.query(`UPDATE knowledge_documents SET status = 'archived' WHERE source_id = $1 AND status = 'published'`, [sourceId]);

    const inserted = await client.query(
      `INSERT INTO knowledge_documents (tenant_id, source_id, title, structured, version, status)
       VALUES ($1,$2,$3,$4,$5,'published') RETURNING id, version`,
      [tenantId, sourceId, 'published knowledge', JSON.stringify(draft.content), nextVersion]
    );
    const document = inserted.rows[0];

    await client.query(
      `INSERT INTO knowledge_publications (tenant_id, source_id, document_id, version, published_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, sourceId, document.id, document.version, userId ?? null]
    );

    await client.query(
      `UPDATE knowledge_drafts SET status = 'published', base_version = $1, updated_at = now() WHERE id = $2`,
      [document.version, draft.id]
    );

    await client.query('COMMIT');
    return { ok: true, version: document.version, documentId: document.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------- validation */

const URL_RE = /^https?:\/\/[^\s<>"')]+\.[^\s<>"')]+$/i;
const PRICE_RE = /^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,3})?$/;

/**
 * Authoritative server-side validation.
 * Returns { ok, errors: [{ section, path, field, messageKey }] } with stable
 * message keys so the UI can localize them without exposing internals.
 */
export function validateKnowledge(knowledge) {
  const errors = [];
  const push = (section, path, field, messageKey) => errors.push({ section, path, field, messageKey });

  if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) {
    return { ok: false, errors: [{ section: 'root', path: '/', field: null, messageKey: 'invalid_structure' }] };
  }

  // --- overview / business profile ---
  const name = knowledge.restaurantName ?? knowledge.brandName ?? knowledge.name;
  if (typeof name !== 'string' || !name.trim()) push('overview', '/', 'name', 'required');
  if (knowledge.menuUrl !== undefined && knowledge.menuUrl !== null && String(knowledge.menuUrl).trim() !== '' && !URL_RE.test(String(knowledge.menuUrl).trim())) {
    push('overview', '/', 'menuUrl', 'invalid_url');
  }

  // --- branches ---
  if (knowledge.branches !== undefined) {
    if (!Array.isArray(knowledge.branches)) push('branches', '/branches', null, 'invalid_type');
    else {
      const names = new Set();
      knowledge.branches.forEach((b, i) => {
        const p = `/branches/${i}`;
        const bName = b?.name ?? b?.name_en;
        if (typeof bName !== 'string' || !bName.trim()) push('branches', p, 'name', 'required');
        else {
          const key = bName.trim().toLowerCase();
          if (names.has(key)) push('branches', p, 'name', 'duplicate');
          names.add(key);
        }
        if (b?.maps !== undefined && b.maps !== null && String(b.maps).trim() !== '' && !URL_RE.test(String(b.maps).trim())) push('branches', p, 'maps', 'invalid_url');
        if (b?.phone !== undefined && b.phone !== null && String(b.phone).trim() !== '' && !/^\+?[\d\s().-]{7,20}$/.test(String(b.phone).trim())) push('branches', p, 'phone', 'invalid_phone');
      });
    }
  }

  // --- menu hierarchy ---
  if (knowledge.menus !== undefined) {
    if (!knowledge.menus || typeof knowledge.menus !== 'object' || Array.isArray(knowledge.menus)) push('menu', '/menus', null, 'invalid_type');
    else {
      for (const [category, subcategories] of Object.entries(knowledge.menus)) {
        if (!category.trim()) push('menu', '/menus', null, 'empty_category');
        if (!subcategories || typeof subcategories !== 'object' || Array.isArray(subcategories)) {
          push('menu', `/menus/${category}`, null, 'invalid_type');
          continue;
        }
        for (const [subcategory, items] of Object.entries(subcategories)) {
          if (!subcategory.trim()) push('menu', `/menus/${category}`, null, 'empty_subcategory');
          if (!Array.isArray(items)) {
            push('menu', `/menus/${category}/${subcategory}`, null, 'invalid_type');
            continue;
          }
          items.forEach((item, i) => {
            const p = `/menus/${category}/${subcategory}/${i}`;
            const itemName = item?.name ?? item?.name_en;
            if (typeof itemName !== 'string' || !itemName.trim()) push('menu', p, 'name', 'required');
            const price = item?.price;
            if (price === undefined || price === null || String(price).trim() === '') push('menu', p, 'price', 'required');
            else if (!PRICE_RE.test(String(price).trim())) push('menu', p, 'price', 'invalid_price');
          });
        }
      }
    }
  }

  // --- FAQs ---
  for (const key of ['faqs', 'faq', 'questions']) {
    if (knowledge[key] !== undefined) {
      if (!Array.isArray(knowledge[key])) push('faq', `/${key}`, null, 'invalid_type');
      else knowledge[key].forEach((f, i) => {
        const q = f?.question ?? f?.q;
        const a = f?.answer ?? f?.a;
        const p = `/${key}/${i}`;
        if (typeof q !== 'string' || !q.trim()) push('faq', p, 'question', 'required');
        if (typeof a !== 'string' || !a.trim()) push('faq', p, 'answer', 'required');
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Human-readable change summary between two structured documents (preview). */
export function diffKnowledge(previous, next) {
  const changes = [];
  const flat = (v, prefix, out) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') {
      if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${prefix}[${i}]`, out));
      else Object.entries(v).forEach(([k, x]) => flat(x, `${prefix}.${k}`, out));
    } else out.set(prefix, String(v));
  };
  const a = new Map(); const b = new Map();
  if (previous) flat(previous, '', a);
  if (next) flat(next, '', b);
  for (const [k, v] of b) if (!a.has(k)) changes.push({ path: k, type: 'added', value: v });
  for (const [k, v] of a) if (!b.has(k)) changes.push({ path: k, type: 'removed', value: v });
  for (const [k, v] of b) if (a.has(k) && a.get(k) !== v) changes.push({ path: k, type: 'modified', from: a.get(k), to: v });
  const sectionOf = (p) => (p.startsWith('.menus') ? 'menu' : p.startsWith('.branches') ? 'branches' : p.startsWith('.faqs') || p.startsWith('.faq') ? 'faq' : 'overview');
  return {
    counts: {
      added: changes.filter((c) => c.type === 'added').length,
      modified: changes.filter((c) => c.type === 'modified').length,
      removed: changes.filter((c) => c.type === 'removed').length
    },
    bySection: changes.reduce((acc, c) => {
      const s = sectionOf(c.path);
      acc[s] = acc[s] || { added: 0, modified: 0, removed: 0 };
      acc[s][c.type] += 1;
      return acc;
    }, {}),
    // capped detail keeps the review readable for large menus
    items: changes.slice(0, 60)
  };
}
