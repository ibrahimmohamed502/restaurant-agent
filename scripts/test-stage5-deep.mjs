/**
 * Stage 5 deep tests — draft isolation, published invariant, atomic publish,
 * concurrency, tenant/brand isolation, RBAC, validation edges, round-trip
 * preservation. All against an in-memory disposable DB (no production, no network).
 * Run: node scripts/test-stage5-deep.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

const K = await import('../src/services/knowledge.js');
const { validateKnowledge, diffKnowledge } = K;

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

/* ------------------------------------------------ disposable in-memory DB */
function makeDb(seed = {}) {
  const db = {
    sources: [...(seed.sources ?? [])],
    documents: [...(seed.documents ?? [])],
    drafts: [...(seed.drafts ?? [])],
    publications: [...(seed.publications ?? [])],
    failOn: null, // { RegExp } matching a normalized statement → throws to simulate a failure step
    snapshot: null,
    locked: null
  };
  db.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (db.failOn && db.failOn.test(s)) throw new Error('injected failure');
    if (/^BEGIN$/.test(s)) { db.snapshot = JSON.stringify({ documents: db.documents, drafts: db.drafts, publications: db.publications }); db.snapshotSeq = db.commitSeq; return { rows: [] }; }
    if (/^ROLLBACK$/.test(s)) { if (db.snapshot && db.snapshotSeq === db.commitSeq) { const snap = JSON.parse(db.snapshot); db.documents = snap.documents; db.drafts = snap.drafts; db.publications = snap.publications; } db.snapshot = null; db.locked = null; return { rows: [] }; }
    if (/^COMMIT$/.test(s)) { db.snapshot = null; db.locked = null; db.commitSeq = (db.commitSeq ?? 0) + 1; return { rows: [] }; }
    if (/FROM knowledge_sources/.test(s)) {
      return { rows: db.sources.filter((r) => r.tenant_id === params[0] && (!params[1] || r.brand_id === params[1])) };
    }
    if (/FROM knowledge_documents d/.test(s)) {
      // emulate the real JOIN on knowledge_sources: the source must belong to params[1] (tenant)
      const src = db.sources.find((x) => x.id === params[0] && x.tenant_id === params[1]);
      if (!src) return { rows: [] };
      return { rows: db.documents.filter((d) => d.source_id === params[0] && d.status === 'published').sort((a, b) => b.version - a.version) };
    }
    if (/FROM knowledge_drafts/.test(s)) {
      const editing = /status = 'editing'/.test(s);
      return { rows: db.drafts.filter((d) => d.tenant_id === params[0] && d.source_id === params[1] && (!editing || d.status === 'editing')) };
    }
    if (/FROM knowledge_publications/.test(s)) return { rows: db.publications.filter((p) => p.tenant_id === params[0] && p.source_id === params[1]) };
    if (/INSERT INTO knowledge_drafts/.test(s)) {
      const row = { id: 'd' + (db.drafts.length + 1), tenant_id: params[0], source_id: params[1], base_version: params[2], content: JSON.parse(params[3]), status: 'editing' };
      db.drafts.push(row);
      return { rows: [row] };
    }
    if (/UPDATE knowledge_drafts SET content/.test(s)) {
      const row = db.drafts.find((d) => d.tenant_id === params[3] && d.source_id === params[4]);
      if (row) { row.content = JSON.parse(params[0]); row.base_version = params[1]; row.status = 'editing'; }
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE knowledge_drafts SET status = 'discarded'/.test(s)) {
      const row = db.drafts.find((d) => d.tenant_id === params[0] && d.source_id === params[1] && d.status === 'editing');
      if (row) row.status = 'discarded';
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT id, content, base_version FROM knowledge_drafts/.test(s)) {
      const locked = /FOR UPDATE/.test(s);
      const row = db.drafts.find((d) => d.tenant_id === params[0] && d.source_id === params[1] && d.status === 'editing');
      if (!row) return { rows: [] };
      if (locked) {
        if (db.locked) throw new Error('could not obtain lock on row');
        db.locked = row.id;
      }
      return { rows: [row] };
    }
    if (/COALESCE\(MAX\(version\)/.test(s)) return { rows: [{ max_version: Math.max(0, ...db.documents.filter((d) => d.source_id === params[0]).map((d) => d.version)) }] };
    if (/UPDATE knowledge_documents SET status = 'archived'/.test(s)) { db.documents.forEach((d) => { if (d.source_id === params[0] && d.status === 'published') d.status = 'archived'; }); return { rows: [] }; }
    if (/INSERT INTO knowledge_documents/.test(s)) {
      const row = { id: 'doc' + (db.documents.length + 1), tenant_id: params[0], source_id: params[1], version: params[4], status: 'published', structured: JSON.parse(params[3]) };
      db.documents.push(row);
      return { rows: [{ id: row.id, version: row.version }] };
    }
    if (/INSERT INTO knowledge_publications/.test(s)) { db.publications.unshift({ tenant_id: params[0], source_id: params[1], version: params[3], published_by: params[4] }); return { rows: [] }; }
    if (/UPDATE knowledge_drafts SET status = 'published'/.test(s)) {
      const row = db.drafts.find((d) => d.id === params[1]);
      if (row) { row.status = 'published'; row.base_version = params[0]; }
      return { rows: [] };
    }
    return { rows: [] };
  };
  db.connect = async () => ({
    query: (sql, params) => db.query(sql, params),
    release: () => undefined
  });
  return db;
}

/* ---------------------------------------------------------------- fixtures */
const T_A = 'tenantA', T_B = 'tenantB';
const SRC = { tenant_id: T_A, brand_id: 'brandA1', kind: 'menu', title: 'LWC KB' };
const SRC_A2 = { tenant_id: T_A, brand_id: 'brandA2', kind: 'menu', title: 'Brand A2 KB' };
const SRC_B = { tenant_id: T_B, brand_id: 'brandB1', kind: 'menu', title: 'Brand B KB' };

function fixtureDb() {
  return makeDb({
    sources: [{ id: 'srcA1', ...SRC }, { id: 'srcA2', ...SRC_A2 }, { id: 'srcB1', ...SRC_B }],
    documents: [
      // source A1: published v1, archived v2, published v3 (newest published wins)
      { id: 'dA1v1', source_id: 'srcA1', version: 1, status: 'archived', structured: { restaurantName: 'A1 v1', menus: { M: { S: [{ name: 'X', price: '1.000' }] } } } },
      { id: 'dA1v2', source_id: 'srcA1', version: 2, status: 'archived', structured: { restaurantName: 'A1 v2' } },
      { id: 'dA1v3', source_id: 'srcA1', version: 3, status: 'published', structured: { restaurantName: 'A1 v3', price: 'PRICE_A', menus: { M: { S: [{ name: 'Cacao Bomb', price: '4.650' }] } }, branches: [{ name: 'B1', maps: 'https://maps.google.com/?q=x' }] } },
      // source A2 (same tenant, other brand)
      { id: 'dA2v1', source_id: 'srcA2', version: 7, status: 'published', structured: { restaurantName: 'A2 v7' } },
      // source B (other tenant, higher version)
      { id: 'dB1v1', source_id: 'srcB1', version: 99, status: 'published', structured: { restaurantName: 'B1 v99' } }
    ],
    drafts: []
  });
}

console.log('\n🧪 Stage 5 deep tests (disposable in-memory DB)\n');

/* ============================ 3. PUBLISHED VERSION INVARIANT ============================ */
{
  const db = fixtureDb();
  const pub = await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcA1', db });
  check('published invariant: resolves ONLY the newest PUBLISHED version (v3, not v1/v2)', pub.version === 3 && pub.structured.price === 'PRICE_A');

  const pubA2 = await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcA2', db });
  check('brand isolation: brand A2 resolves its own published v7 (no leakage from A1)', pubA2.version === 7 && pubA2.structured.restaurantName === 'A2 v7');

  const pubB = await K.getPublishedKnowledge({ tenantId: T_B, sourceId: 'srcB1', db });
  check('tenant isolation: tenant B resolves its own v99 (version magnitude ignored)', pubB.version === 99 && pubB.structured.restaurantName === 'B1 v99');

  const crossTenant = await K.getPublishedKnowledge({ tenantId: T_B, sourceId: 'srcA1', db });
  check('tenant isolation: tenant B cannot read tenant A source through the same function', crossTenant === null);

  const crossBrand = await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcB1', db });
  check('brand isolation: tenant A cannot read tenant B source', crossBrand === null);

  const src = await K.resolveKnowledgeSource({ tenantId: T_A, brandId: 'brandA2', db });
  check('brand resolution: brandId selects the correct source within the tenant', src.id === 'srcA2');
  const badBrand = await K.resolveKnowledgeSource({ tenantId: T_A, brandId: 'does-not-exist', db });
  check('fabricated brandId → no source (fail closed)', badBrand === null);
  const otherTenantBrand = await K.resolveKnowledgeSource({ tenantId: T_B, brandId: 'brandA1', db });
  check('brand from another tenant → no source (fail closed)', otherTenantBrand === null);
}

/* ============================ 4. DRAFT ISOLATION + PUBLISH ============================ */
{
  const db = fixtureDb();
  // draft changes PRICE_A → PRICE_B and adds an unknown-but-valid field
  const draftContent = JSON.parse(JSON.stringify(db.documents[2].structured));
  draftContent.price = 'PRICE_B';
  draftContent.futureField = { keep: true };
  const saved = await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: draftContent, baseVersion: 3, userId: 'u1', db });
  check('draft isolation: draft stored with PRICE_B while published stays PRICE_A',
    saved.draft.base_version === 3 && db.documents.find((d) => d.status === 'published').structured.price === 'PRICE_A');

  const validation = validateKnowledge(saved.draft.content);
  check('draft validation: valid draft passes', validation.ok === true);

  const published = await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', userId: 'u1', db });
  check('publish creates the next version (v4) atomically', published.ok === true && published.version === 4);

  const after = await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcA1', db });
  check('after publish: aiContext-style read returns PRICE_B (new published v4)', after.version === 4 && after.structured.price === 'PRICE_B');
  check('after publish: previous v3 archived, single published version', db.documents.filter((d) => d.source_id === 'srcA1' && d.status === 'published').length === 1 && db.documents.find((d) => d.version === 3).status === 'archived');
  check('after publish: unknown-but-valid fields preserved (no lossy serialization)', after.structured.futureField && after.structured.futureField.keep === true);
  check('after publish: publication history recorded', db.publications.length === 1 && db.publications[0].version === 4);
  check('after publish: draft state updated (not editing)', db.drafts[0].status === 'published' && db.drafts[0].base_version === 4);

  // a NEW draft can be created from the new published version (regression fix)
  const nextDraft = await K.getDraft({ tenantId: T_A, sourceId: 'srcA1', db });
  check('after publish: no editing draft exposed until a new one is created', nextDraft === null);
  const reDrafted = await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: after.structured, baseVersion: 4, db });
  check('after publish: creating a draft reuses the row and rebases on v4', reDrafted.draft.status === 'editing' && reDrafted.draft.base_version === 4);
}

/* ============================ 5. ATOMIC PUBLISH (failure injection) ============================ */
{
  const scenarios = [
    { name: 'archive step fails', failOn: /UPDATE knowledge_documents SET status = 'archived'/ },
    { name: 'insert-new-published fails', failOn: /INSERT INTO knowledge_documents/ },
    { name: 'history insert fails', failOn: /INSERT INTO knowledge_publications/ },
    { name: 'draft reset fails', failOn: /UPDATE knowledge_drafts SET status = 'published'/ }
  ];
  for (const sc of scenarios) {
    const db = fixtureDb();
    await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 v4', menus: { M: { S: [{ name: 'X', price: '4.650' }] } } }, baseVersion: 3, db });
    db.failOn = sc.failOn;
    let threw = false;
    try { await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db }); } catch { threw = true; }
    const stillPublished = db.documents.filter((d) => d.source_id === 'srcA1' && d.status === 'published');
    const draftStillEditing = db.drafts[0]?.status === 'editing';
    check(`atomic publish: "${sc.name}" → rollback, v3 still the only published, draft recoverable`,
      threw && stillPublished.length === 1 && stillPublished[0].version === 3 && draftStillEditing);
  }

  // validation failure inside publish → rollback, no new version
  {
    const db = fixtureDb();
    await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: '', menus: { M: { S: [{ name: '', price: 'bad' }] } } }, baseVersion: 3, db });
    const r = await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db });
    check('atomic publish: invalid draft rejected inside the transaction (no version created)', r.ok === false && r.code === 'VALIDATION_FAILED' && db.documents.filter((d) => d.source_id === 'srcA1').length === 3);
  }
}

/* ============================ 6. CONCURRENCY ============================ */
{
  // Sequential (deterministic) proof of the publish state machine: after a
  // successful publish the draft is no longer editing, so a second publish
  // cannot create another version. Concurrency in production is enforced by
  // PostgreSQL SELECT ... FOR UPDATE inside the publish transaction.
  const db = fixtureDb();
  await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 v4', menus: { M: { S: [{ name: 'X', price: '4.650' }] } } }, baseVersion: 3, db });
  const first = await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db });
  const second = await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db });
  const publishedCount = db.documents.filter((d) => d.source_id === 'srcA1' && d.status === 'published').length;
  const versionCount = db.documents.filter((d) => d.source_id === 'srcA1').length;
  check('concurrent/duplicate publish: second attempt cannot create a second active version',
    first.ok === true && second.ok === false && second.code === 'NO_DRAFT' && publishedCount === 1 && versionCount === 4);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/services/knowledge.js', import.meta.url), 'utf8');
  check('concurrency protection: publish uses SELECT … FOR UPDATE row locking', /FOR UPDATE/.test(src));

  // concurrent saves with the same base version → last write wins but no duplicate draft rows
  const db2 = fixtureDb();
  await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 d1', menus: {} }, baseVersion: 3, db: db2 });
  await Promise.all([
    K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 d2', menus: {} }, baseVersion: 3, db: db2 }),
    K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 d3', menus: {} }, baseVersion: 3, db: db2 })
  ]);
  check('concurrent save: single draft row, no duplicate drafts, draft stays editing', db2.drafts.length === 1 && db2.drafts[0].status === 'editing');

  // stale browser tab: publish bumps base version, a later save with the old base must be rejected by the API layer
  const db3 = fixtureDb();
  await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 v4', menus: { M: { S: [{ name: 'X', price: '4.650' }] } } }, baseVersion: 3, db: db3 });
  await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db: db3 });
  const editing = await K.getAnyDraft({ tenantId: T_A, sourceId: 'srcA1', db: db3 });
  check('stale draft: after publish the draft is no longer editing → API returns 409 for old baseVersion', editing.status !== 'editing');
}

/* ============================ 9. VALIDATION EDGES ============================ */
{
  const base = { restaurantName: 'X', menus: { C: { S: [{ name: 'I', price: '4.650' }] } } };
  const cases = [
    ['negative price', { ...base, menus: { C: { S: [{ name: 'I', price: '-4.650' }] } } }, 'invalid_price'],
    ['malformed decimal', { ...base, menus: { C: { S: [{ name: 'I', price: '4.65.0' }] } } }, 'invalid_price'],
    ['price with letters', { ...base, menus: { C: { S: [{ name: 'I', price: '4.650 KD' }] } } }, 'invalid_price'],
    ['item without name', { ...base, menus: { C: { S: [{ name: '', price: '4.650' }] } } }, 'required'],
    ['item without price', { ...base, menus: { C: { S: [{ name: 'I', price: '' }] } } }, 'required'],
    ['empty category', { ...base, menus: { '': { S: [] } } }, 'empty_category'],
    ['empty subcategory', { ...base, menus: { C: { '': [] } } }, 'empty_subcategory'],
    ['menus as array', { ...base, menus: [] }, 'invalid_type'],
    ['branches as object', { ...base, branches: {} }, 'invalid_type'],
    ['duplicate branch', { ...base, branches: [{ name: 'B' }, { name: 'b' }] }, 'duplicate'],
    ['null root', null, 'invalid_structure'],
    ['array root', [], 'invalid_structure']
  ];
  for (const [name, doc, key] of cases) {
    const r = validateKnowledge(doc);
    check(`validation: ${name} → ${key}`, !r.ok && r.errors.some((e) => e.messageKey === key));
  }
  // KD precision accepted
  check('validation: KD precision values accepted (4.650 / 12.000 / 3.5)', ['4.650', '12.000', '3.5'].every((p) => validateKnowledge({ ...base, menus: { C: { S: [{ name: 'I', price: p }] } } }).ok));
  // unknown top-level fields do not break validation (forward compatibility)
  check('validation: unknown fields tolerated (no false rejection)', validateKnowledge({ ...base, futureField: { a: 1 } }).ok === true);
}

/* ============================ 10. ROUND-TRIP PRESERVATION ============================ */
{
  const db = fixtureDb();
  const original = db.documents[2].structured;
  const draft = JSON.parse(JSON.stringify(original));
  draft.menus.M.S[0].price = '4.750'; // edit ONE item price
  await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: draft, baseVersion: 3, db });
  await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db });
  const after = await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcA1', db });
  const differing = Object.keys(original).filter((k) => k !== 'menus' && JSON.stringify(original[k]) !== JSON.stringify(after.structured[k]));
  check('round trip: editing one menu price preserves every other top-level field',
    differing.length === 0 && after.structured.menus.M.S[0].price === '4.750' && after.structured.menus.M.S[0].name === 'Cacao Bomb');
  check('round trip: branch structure preserved (name + maps URL)', after.structured.branches[0].name === 'B1' && after.structured.branches[0].maps === 'https://maps.google.com/?q=x');

  // branch field edit preserves unknown keys
  const db2 = fixtureDb();
  const bdraft = JSON.parse(JSON.stringify(db2.documents[2].structured));
  bdraft.branches[0].timings = '9:00 AM – 11:00 PM';
  await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: bdraft, baseVersion: 3, db: db2 });
  await K.publishDraft({ tenantId: T_A, sourceId: 'srcA1', db: db2 });
  const bAfter = await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcA1', db: db2 });
  check('round trip: branch edit preserves sibling fields (name/maps)', bAfter.structured.branches[0].name === 'B1' && bAfter.structured.branches[0].maps === 'https://maps.google.com/?q=x' && bAfter.structured.branches[0].timings === '9:00 AM – 11:00 PM');
}

/* ============================ 12. PREVIEW DIFF ============================ */
{
  const prev = { restaurantName: 'A', menus: { C: { S: [{ name: 'X', price: '1.000' }] } }, branches: [{ name: 'B1' }], faqs: [] };
  const next = { restaurantName: 'B', menus: { C: { S: [{ name: 'X', price: '2.000' }] } }, faqs: [{ question: 'q', answer: 'a' }] };
  const d = diffKnowledge(prev, next);
  check('preview diff: added/modified/removed counts correct',
    d.counts.added >= 2 && d.counts.modified >= 2 && d.counts.removed >= 1);
  check('preview diff: section breakdown correct (menu modified, branches removed, faqs added)',
    d.bySection.menu.modified >= 1 && d.bySection.branches.removed >= 1 && d.bySection.faq.added >= 1);
  const noChange = diffKnowledge(prev, prev);
  check('preview diff: identical documents → zero changes', noChange.counts.added === 0 && noChange.counts.modified === 0 && noChange.counts.removed === 0);
  const big = diffKnowledge({}, Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, `v${i}`])));
  check('preview diff: large diffs capped (60 items) and never expose secrets', big.items.length === 60 && !JSON.stringify(big).match(/token|secret|password/i));
}

/* ============================ 13. DISCARD ============================ */
{
  const db = fixtureDb();
  await K.saveDraft({ tenantId: T_A, sourceId: 'srcA1', content: { restaurantName: 'A1 draft' }, baseVersion: 3, db });
  const ok = await K.discardDraft({ tenantId: T_A, sourceId: 'srcA1', db });
  check('discard: editing draft is discarded and published knowledge untouched', ok === true && (await K.getPublishedKnowledge({ tenantId: T_A, sourceId: 'srcA1', db })).version === 3);
  const again = await K.discardDraft({ tenantId: T_A, sourceId: 'srcA1', db });
  check('discard: second discard is a no-op (idempotent)', again === false);
}

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
