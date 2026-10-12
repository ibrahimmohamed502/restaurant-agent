/**
 * Create (or repair) the tenant admin user.
 * Usage:  node scripts/create-admin.mjs [email] [password]
 * Defaults: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from env.
 * Idempotent: existing user gets the new password + Company Admin role.
 */
import 'dotenv/config';
import { pool } from '../src/db/pg.js';
import { hashPassword } from '../src/auth/passwords.js';

const email = (process.argv[2] || process.env.SEED_ADMIN_EMAIL || '').toLowerCase().trim();
const password = process.argv[3] || process.env.SEED_ADMIN_PASSWORD;

if (!email || !password) {
  console.error('usage: node scripts/create-admin.mjs [email] [password]');
  process.exit(1);
}

const { rows: [tenant] } = await pool.query(`SELECT id FROM tenants WHERE slug = 'ufc'`);
if (!tenant) {
  console.error('❌ tenant ufc not found — did the seed run?');
  process.exit(1);
}

const hash = await hashPassword(password);
const { rows: [user] } = await pool.query(
  `INSERT INTO users (tenant_id, email, name, password_hash)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash
   RETURNING id, email`,
  [tenant.id, email, 'Company Admin', hash]
);

const { rows: [role] } = await pool.query(
  `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Company Admin'`,
  [tenant.id]
);
await pool.query(
  `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  [user.id, role.id]
);

console.log(`✅ admin ready: ${user.email} (id ${user.id})`);
process.exit(0);
