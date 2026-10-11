/**
 * Stage 6 Batch 1 — Structured knowledge chunking.
 *
 * Deterministically turns a PUBLISHED structured knowledge document into
 * retrieval chunks. Each chunk carries tenant/brand/version/section metadata
 * so retrieval can enforce isolation and an active index version.
 *
 * Business content is preserved VERBATIM — chunking never rewrites knowledge.
 * The knowledge `kind` vocabulary (menu | branch_info | policy | faq | offer |
 * document) drives which sections are produced.
 */

/** Deterministic chunk key for idempotent re-indexing (same content → same key). */
function chunkKey(section, entityKey) {
  return entityKey ? `${section}/${entityKey}` : section;
}

/**
 * @param {Record<string, unknown>} knowledge  published structured document
 * @returns {Array<{ key: string; section: string; entityKey: string | null; kind: string; content: string }>}
 */
export function chunkKnowledge(knowledge) {
  const k = knowledge ?? {};
  const out = [];

  const push = (section, entityKey, kind, content) => {
    const text = String(content ?? '').trim();
    if (!text) return;
    out.push({ key: chunkKey(section, entityKey), section, entityKey: entityKey ?? null, kind, content: text });
  };

  /* ------------------------------------------------------------ overview */
  const overviewParts = [];
  if (k.restaurantName) overviewParts.push(`Name: ${k.restaurantName}`);
  if (k.about) overviewParts.push(`About: ${k.about}`);
  if (overviewParts.length) push('overview', null, 'document', overviewParts.join('\n'));

  /* ---------------------------------------------------------------- menu */
  const menus = k.menus && typeof k.menus === 'object' ? k.menus : {};
  for (const [category, subs] of Object.entries(menus)) {
    if (!subs || typeof subs !== 'object') continue;
    for (const [subcategory, items] of Object.entries(subs)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name ?? item.name_en ?? '').trim();
        if (!name) continue;
        const nameAr = String(item.name_ar ?? '').trim();
        const desc = String(item.desc ?? item.description ?? '').trim();
        const price = item.price === undefined || item.price === null ? '' : String(item.price).trim();
        const lines = [`Item: ${name}`];
        if (nameAr) lines.push(`Name (AR): ${nameAr}`);
        if (desc) lines.push(`Description: ${desc}`);
        if (price) lines.push(`Price: ${price} KD`);
        if (k.menuUrl) lines.push(`Menu: ${k.menuUrl}`);
        push('menu', `${category}/${subcategory}/${name}`, 'menu', lines.join('\n'));
      }
    }
  }

  /* ------------------------------------------------------------- branches */
  if (Array.isArray(k.branches)) {
    for (const b of k.branches) {
      if (!b || typeof b !== 'object') continue;
      const name = String(b.name ?? b.name_en ?? '').trim();
      if (!name) continue;
      const lines = [`Branch: ${name}`];
      if (b.area) lines.push(`Area: ${b.area}`);
      if (b.timings) lines.push(`Opening hours: ${b.timings}`);
      if (b.phone) lines.push(`Phone: ${b.phone}`);
      if (b.maps) lines.push(`Map: ${b.maps}`);
      push('branches', name, 'branch_info', lines.join('\n'));
    }
  }

  /* ------------------------------------------------------------------ FAQ */
  const faqKey = ['faqs', 'faq', 'questions'].find((key) => Array.isArray(k[key])) ?? 'faqs';
  if (Array.isArray(k[faqKey])) {
    k[faqKey].forEach((f, i) => {
      if (!f || typeof f !== 'object') return;
      const q = String(f.question ?? f.q ?? '').trim();
      const a = String(f.answer ?? f.a ?? '').trim();
      if (!q && !a) return;
      const lines = [];
      if (q) lines.push(`Q: ${q}`);
      if (a) lines.push(`A: ${a}`);
      push('faq', `faq_${i}`, 'faq', lines.join('\n'));
    });
  }

  /* ------------------------------------------------------------- policies */
  const POLICY_FIELDS = [
    ['meatSources', 'Meat sources'],
    ['halal', 'Halal information'],
    ['delivery', 'Delivery / service'],
    ['location', 'Location'],
    ['reservations', 'Reservations policy']
  ];
  for (const [field, label] of POLICY_FIELDS) {
    const value = String(k[field] ?? '').trim();
    if (value) push('policies', field, 'policy', `${label}: ${value}`);
  }

  /* ------------------------------------------------------- misc scalar fields */
  for (const [key, value] of Object.entries(k)) {
    if (['restaurantName', 'about', 'menus', 'branches', 'faqs', 'faq', 'questions', 'meatSources', 'halal', 'delivery', 'location', 'reservations', 'menuUrl', 'currency'].includes(key)) continue;
    const text = String(value ?? '').trim();
    if (text) push('policies', key, 'policy', `${key}: ${text}`);
  }

  return out;
}
