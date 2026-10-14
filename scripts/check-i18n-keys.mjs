#!/usr/bin/env node
/**
 * Scan all t('...') keys used in app pages/components and verify they exist
 * as STRING values in both en.json and ar.json.
 * Correctly maps translator variable names to their declared namespaces.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const messages = {};
for (const loc of ['en', 'ar']) {
  messages[loc] = JSON.parse(readFileSync(join(root, 'messages', `${loc}.json`), 'utf8'));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === '.next') continue;
      walk(p, out);
    } else if (/\.(tsx|ts)$/.test(e)) out.push(p);
  }
  return out;
}

// Scope: Batch 1 pages only (companies + brands). Other pages are out of scope.
const SCOPE = process.argv[2] === '--all' ? null : ['companies', 'brands'];
const files = walk(join(root, 'app')).concat(walk(join(root, 'components')))
  .filter(f => !SCOPE || SCOPE.some(s => f.includes(s)));

let issues = 0;
const seen = new Set();

/**
 * Detect values that are themselves raw i18n keys (e.g. "brands.status",
 * "platform.actions") — these indicate an untranslated fallback leaking through.
 */
function looksLikeRawKey(v) {
  if (!v.includes('.')) return false;
  // Known top-level message namespaces in this project
  const namespaces = ['common', 'platform', 'brands', 'nav', 'shell', 'auth', 'states',
    'channels', 'companies', 'dashboard', 'inbox', 'knowledge', 'team', 'settings',
    'notifications', 'ai', 'audit', 'integrations', 'customers', 'conversations'];
  return namespaces.some(ns => v.startsWith(`${ns}.`));
}

function lookup(ns, key) {
  const parts = (`${ns}.${key}`).split('.');
  const out = {};
  for (const loc of ['en', 'ar']) {
    let cur = messages[loc];
    for (const p of parts) {
      cur = cur?.[p];
      if (cur === undefined) break;
    }
    out[loc] = cur;
  }
  return out;
}

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(root, f);

  // Map: variable name -> namespace, e.g. const t = useTranslations('brands')
  const nsMap = {};
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    nsMap[m[1]] = m[2];
  }
  const varNames = Object.keys(nsMap).sort((a, b) => b.length - a.length); // longest first
  if (varNames.length === 0) continue;

  // t('key'), t(`key.${x}`), tc('key')...
  const alt = varNames.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\b(${alt})\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  for (const m of src.matchAll(re)) {
    const ns = nsMap[m[1]];
    const rawKey = m[2];
    // Normalize dynamic segments for static lookup
    const base = rawKey.replace(/\$\{[^}]*\}/g, 'X');
    const isDynamic = base.includes('X');
    const dedupe = `${ns}:${base}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const r = lookup(ns, isDynamic ? base.split('.').slice(0, -1).join('.') : base);
    for (const loc of ['en', 'ar']) {
      const v = r[loc];
      if (v === undefined) {
        // For dynamic keys the parent object must exist instead
        if (isDynamic) {
          const parent = lookup(ns, base.split('.').slice(0, -1).join('.'));
          if (typeof parent[loc] === 'object' && parent[loc] !== null) continue;
        }
        console.log(`❌ [${loc}] MISSING  ${ns}.${base}   (${rel})`);
        issues++;
      } else if (typeof v !== 'string') {
        // dynamic key parent is allowed to be object
        if (isDynamic) continue;
        console.log(`⚠️  [${loc}] NOT-STRING (${typeof v})  ${ns}.${base}   (${rel})`);
        issues++;
      } else if (v.trim() === '') {
        console.log(`❌ [${loc}] EMPTY-VALUE  ${ns}.${base}   (${rel})`);
        issues++;
      } else if (looksLikeRawKey(v)) {
        console.log(`⚠️  [${loc}] LOOKS-LIKE-RAW-KEY  ${ns}.${base} = "${v}"   (${rel})`);
        issues++;
      }
    }
  }
}

console.log(`\nScanned ${files.length} files, ${seen.size} namespace:key pairs`);
if (SCOPE) console.log(`Scope: ${SCOPE.join(', ')} (Batch 1)`);
console.log(issues === 0 ? '✅ No missing or non-string translation keys found' : `💥 ${issues} issue(s) found`);
process.exit(issues === 0 ? 0 : 1);
