import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, enabled } from './pg.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Apply pending migrations in filename order. Returns true if DB is in use. */
export async function migrate() {
  if (!enabled) {
    console.log('⏭️  DATABASE_URL not set — running in legacy JSON mode (no migrations)');
    return false;
  }

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id serial PRIMARY KEY,
        name text UNIQUE NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rows.length) continue;

      console.log(`⏳ applying migration ${file}...`);
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✅ migration ${file} applied`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    return true;
  } finally {
    client.release();
  }
}
