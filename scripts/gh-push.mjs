/**
 * Push local files to GitHub via the Contents API (no local git needed).
 *
 * Usage:
 *   node scripts/gh-push.mjs                      → pushes the DEFAULT list below
 *   node scripts/gh-push.mjs '["src/db.js"]'      → pushes specific file(s)
 *
 * Requires GITHUB_TOKEN in .env (fine-grained PAT, Contents: Read+write).
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'ibrahimmohamed502';
const REPO = 'restaurant-agent';
const BRANCH = 'main';
const API = 'https://api.github.com';

// Default deploy list (edit per wave or pass a custom JSON list as argv[2])
const DEFAULT = [
  'src/dashboard.js',
  'src/db.js',
  'ARCHITECTURE.md',
  'server.js',
  'src/webhook.js',
  '.env.example'
];

if (!TOKEN) {
  console.error('❌ GITHUB_TOKEN missing in .env');
  process.exit(1);
}

const arg = process.argv[2];
let list = DEFAULT;
if (arg) {
  try {
    list = JSON.parse(arg).map((x) => (typeof x === 'string' ? x : x.repo));
  } catch {
    console.error('❌ argv[2] must be a JSON array like ["server.js","src/db.js"]');
    process.exit(1);
  }
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28'
};

async function getSha(repoPath) {
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${repoPath}?ref=${BRANCH}`, { headers });
  if (r.status === 404) return null;
  const d = await r.json();
  if (!r.ok) throw new Error(`GET ${repoPath} → ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d.sha;
}

for (const repoPath of list) {
  if (!existsSync(repoPath)) {
    console.error(`⏭️  skipped (not found locally): ${repoPath}`);
    continue;
  }
  const content = readFileSync(repoPath, 'utf8');
  const sha = await getSha(repoPath);
  const body = {
    message: `${sha ? 'Update' : 'Add'} ${repoPath}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {})
  };
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${repoPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`PUT ${repoPath} → ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  console.log(`✅ ${sha ? 'Updated' : 'Created'} ${repoPath}  (${d.commit.sha.slice(0, 7)})`);
}
console.log('🎉 Done.');
