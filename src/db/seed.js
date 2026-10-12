import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, enabled } from './pg.js';
import { encrypt } from './crypto.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Seed the first tenant (UFC / Life with Cacao) from the existing knowledge.json.
 * Runs ONLY when the tenants table is empty — never double-seeds.
 */
export async function seedIfEmpty() {
  if (!enabled) return false;

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM tenants');
  if (rows[0].c > 0) {
    console.log('⏭️  tenants already exist — skipping seed');
    return false;
  }

  console.log('🌱 empty DB — seeding tenant UFC / Life with Cacao from knowledge.json...');
  const kb = JSON.parse(readFileSync(path.join(ROOT, 'knowledge.json'), 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- tenant + brand ----
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ['United Food Company', 'ufc']
    );
    const { rows: [brand] } = await client.query(
      `INSERT INTO brands (tenant_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
      [tenant.id, 'Life with Cacao', 'lwc']
    );

    // ---- branches ----
    for (const b of kb.branches ?? []) {
      await client.query(
        `INSERT INTO branches (tenant_id, brand_id, name, area, phone, location_detail, maps_url, timings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenant.id, brand.id, b.name, b.area, b.phone, b.locationDetail, b.maps, b.timings]
      );
    }
    console.log(`  ✅ ${(kb.branches ?? []).length} branches`);

    // ---- teams (for the future assignment engine) ----
    for (const t of ['Marketing', 'Customer Service', 'Purchasing', 'IT', 'Management']) {
      await client.query(`INSERT INTO teams (tenant_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenant.id, t]);
    }

    // ---- roles + admin user ----
    const { rows: [adminRole] } = await client.query(
      `INSERT INTO roles (tenant_id, name, permissions) VALUES ($1,$2,$3) RETURNING id`,
      [tenant.id, 'Company Admin', JSON.stringify(['*'])]
    );
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (email && password) {
      const hash = await bcrypt.hash(password, 10);
      const { rows: [admin] } = await client.query(
        `INSERT INTO users (tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
        [tenant.id, email, 'Company Admin', hash]
      );
      await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [admin.id, adminRole.id]);
      console.log(`  ✅ admin user ${email}`);
    } else {
      console.warn('  ⚠️ SEED_ADMIN_EMAIL/PASSWORD not set — no admin user created');
    }

    // ---- channels (Meta comment + DM) ----
    const pageId = process.env.FB_PAGE_ID;
    const { rows: [chComment] } = await client.query(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenant.id, brand.id, 'meta_comment', pageId, 'Facebook Page — comments']
    );
    const { rows: [chDm] } = await client.query(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenant.id, brand.id, 'meta_dm', pageId, 'Facebook Page — Messenger']
    );

    // ---- provider credentials (encrypted) ----
    if (process.env.FB_PAGE_ACCESS_TOKEN && process.env.ENCRYPTION_KEY) {
      const enc = encrypt(process.env.FB_PAGE_ACCESS_TOKEN);
      await client.query(
        `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenant.id, chComment.id, 'page_access_token', enc.value, enc.iv]
      );
      await client.query(
        `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenant.id, chDm.id, 'page_access_token', enc.value, enc.iv]
      );
      console.log('  ✅ page token stored encrypted (2 channels)');
    } else {
      console.warn('  ⚠️ FB_PAGE_ACCESS_TOKEN or ENCRYPTION_KEY missing — credentials not seeded');
    }

    // ---- AI agent + config ----
    const { rows: [agent] } = await client.query(
      `INSERT INTO ai_agents (tenant_id, brand_id, name) VALUES ($1,$2,$3) RETURNING id`,
      [tenant.id, brand.id, 'LWC AI Agent']
    );
    await client.query(
      `INSERT INTO ai_configs (tenant_id, agent_id, tone, languages, rules)
       VALUES ($1,$2,$3,$4,$5)`,
      [tenant.id, agent.id, 'kuwaiti-friendly', JSON.stringify(['ar', 'en']), JSON.stringify({
        honesty: 'never lie about being automated',
        neverInvent: ['prices', 'offers', 'hours', 'policies', 'availability'],
        menuLinkInEveryCommentReply: true,
        dialect: 'kuwaiti'
      })]
    );

    // ---- knowledge: sources + documents + chunks ----
    const { rows: [src] } = await client.query(
      `INSERT INTO knowledge_sources (tenant_id, brand_id, kind, title) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenant.id, brand.id, 'menu', `${kb.restaurantName} — main menu & info`]
    );

    const chunks = [];
    chunks.push(`Restaurant: ${kb.restaurantName}. ${kb.about} Currency: ${kb.currency}. Halal: ${kb.halal}.`);
    for (const [menuName, categories] of Object.entries(kb.menus ?? {})) {
      for (const [catName, items] of Object.entries(categories)) {
        for (const item of items) {
          chunks.push(
            `Menu: ${menuName} > ${catName} > ${item.name}` +
            (item.price ? ` — ${item.price} KD` : ' — price on request') +
            (item.desc ? ` (${item.desc})` : '')
          );
        }
      }
    }
    for (const b of kb.branches ?? []) {
      chunks.push(`Branch: ${b.name} — area: ${b.area} — phone: ${b.phone} — timings: ${b.timings} — maps: ${b.maps}`);
    }
    for (const [k, v] of Object.entries(kb.meatSources ?? {})) {
      if (k !== 'note') chunks.push(`Meat source — ${k}: ${v}`);
    }
    for (const n of kb.agentNotes ?? []) chunks.push(`Agent rule: ${n}`);

    const { rows: [doc] } = await client.query(
      `INSERT INTO knowledge_documents (tenant_id, source_id, title, structured)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenant.id, src.id, `${kb.restaurantName} — full knowledge snapshot`, JSON.stringify(kb)]
    );
    for (const c of chunks) {
      await client.query(
        `INSERT INTO knowledge_chunks (tenant_id, document_id, content) VALUES ($1,$2,$3)`,
        [tenant.id, doc.id, c]
      );
    }
    console.log(`  ✅ knowledge: ${chunks.length} chunks`);

    await client.query(
      `INSERT INTO audit_logs (tenant_id, action, object_type, metadata) VALUES ($1,$2,$3,$4)`,
      [tenant.id, 'seed.initial', 'tenant', JSON.stringify({ brand: 'lwc', chunks: chunks.length })]
    );

    await client.query('COMMIT');
    console.log('🌱 seed complete — tenant UFC / LWC is live in Postgres');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ seed failed (rolled back):', e.message);
    throw e;
  } finally {
    client.release();
  }
}
