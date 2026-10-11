/**
 * Stage 6 Batch 2 — deterministic structured lookup on the PUBLISHED knowledge.
 *
 * Exact facts (price, hours, phone, map URL) come from the structured JSON via
 * SQL-free lookups — values are returned VERBATIM, so they cannot be invented.
 * Used only for high-confidence intents; everything else goes semantic.
 */

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

/** Arabic/English aliases → canonical branch-name fragments for matching. */
const BRANCH_ALIASES = [
  [/الأفينيو|الافينيو|الافينيوز|avenues?/i, 'avenues'],
  [/360/i, '360'],
  [/السالمية|السالميه|salmiya/i, 'salmiya'],
  [/الناصرة|ناصر|nasr/i, 'nasr'],
  [/الراي|الراى|alrai|al rai/i, 'alrai'],
  [/الجهراء|jahra/i, 'jahra'],
  [/الفنطاس|finteas/i, 'finteas']
];

function normalizeEntity(name) {
  const n = String(name ?? '');
  for (const [re, canonical] of BRANCH_ALIASES) {
    if (re.test(n)) return canonical;
  }
  return norm(n);
}

function containsMatch(haystack, needle) {
  return norm(haystack).includes(norm(needle));
}

/** Extract a likely named entity from the question (branch/item hint). */
function extractEntity(text) {
  const t = String(text ?? '');
  // "فرع الأفينيو" / "the avenues branch" / "360"
  const arBranch = t.match(/فرع\s+([^\s،.؟?]{2,})/);
  if (arBranch) return arBranch[1];
  const enBranch = t.match(/(\bavenues?\b|\b360\b|\bsalmiya\b|\bnasser\b|\balrai\b)/i);
  if (enBranch) return enBranch[1];
  return null;
}

function menuItemByName(menus, name) {
  const n = norm(name);
  if (!n) return null;
  for (const [category, subs] of Object.entries(menus ?? {})) {
    for (const [subcategory, items] of Object.entries(subs ?? {})) {
      for (const item of items ?? []) {
        const itemName = norm(item.name ?? item.name_en ?? '');
        const itemAr = norm(item.name_ar ?? '');
        if ((itemName && (itemName.includes(n) || n.includes(itemName))) || (itemAr && (itemAr.includes(n) || n.includes(itemAr)))) {
          return { item, category, subcategory };
        }
      }
    }
  }
  return null;
}

function branchByName(branches, name) {
  const target = normalizeEntity(name);
  if (!target) return null;
  return (branches ?? []).find((b) => {
    const branchName = norm(b.name ?? b.name_en ?? '');
    return branchName.includes(target) || normalizeEntity(b.name ?? b.name_en ?? '').includes(target);
  }) ?? null;
}

/** Best-effort item name extraction from the message. */
function extractItemHint(text) {
  const t = String(text ?? '');
  // strip question words → what remains often contains the item
  const stripped = t.replace(/\b(بكم|كام|سعر|كام|price|cost|how much|is|the|هل|عندكم)\b/gi, ' ').trim();
  return stripped.length >= 3 ? stripped : null;
}

/**
 * Deterministic fact lookup for a classified intent.
 * @returns {{ fact: object; source: string } | null}
 */
export function lookupStructured(intent, text, knowledge) {
  const k = knowledge ?? {};
  const menus = k.menus ?? {};
  const branches = k.branches ?? [];
  const entity = extractEntity(text);

  switch (intent) {
    case 'price': {
      const hint = extractItemHint(text);
      if (!hint) return null;
      const found = menuItemByName(menus, hint);
      if (!found) return null;
      const name = found.item.name ?? found.item.name_en ?? '';
      return {
        fact: { type: 'price', item: name, price: String(found.item.price ?? ''), category: found.category },
        source: `menu/${found.category}/${found.subcategory}/${name}`
      };
    }
    case 'hours': {
      const branch = entity ? branchByName(branches, entity) : null;
      if (branch) {
        return {
          fact: { type: 'hours', branch: branch.name, timings: String(branch.timings ?? '') },
          source: `branches/${branch.name}`
        };
      }
      if (k.workingHoursSummary) {
        return { fact: { type: 'hours', summary: String(k.workingHoursSummary) }, source: 'policies/workingHoursSummary' };
      }
      return null;
    }
    case 'phone': {
      const branch = entity ? branchByName(branches, entity) : branches[0] ?? null;
      if (branch?.phone) {
        return { fact: { type: 'phone', branch: branch.name, phone: String(branch.phone) }, source: `branches/${branch.name}` };
      }
      return null;
    }
    case 'branch_location': {
      const branch = entity ? branchByName(branches, entity) : null;
      if (branch) {
        return {
          fact: { type: 'branch', branch: branch.name, area: String(branch.area ?? ''), maps: String(branch.maps ?? '') },
          source: `branches/${branch.name}`
        };
      }
      return null;
    }
    case 'menu': {
      if (k.menuUrl) return { fact: { type: 'menuUrl', url: String(k.menuUrl) }, source: 'overview/menuUrl' };
      return null;
    }
    default:
      return null;
  }
}
