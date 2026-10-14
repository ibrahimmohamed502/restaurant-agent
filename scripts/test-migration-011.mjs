/**
 * Stage 8 Batch 1 — Migration 011 Verification Tests
 * Tests the wildcard permission fix for Company Admin roles.
 * Run: node scripts/test-migration-011.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import crypto from 'node:crypto';

const roles = new Map();
const auditLogs = [];

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const explicitPermissions = [
  "brand.read","brand.create","brand.update","brand.disable",
  "user.read","user.create","user.update","user.disable",
  "brand.integration.connect","brand.integration.disconnect",
  "brand.integration.reconnect","brand.integration.status",
  "company.read","company.update",
  "conversation.read","conversation.handoff","conversation.assign",
  "conversation.reassign","conversation.unassign","conversation.resolve",
  "conversation.resume_ai","conversation.reply",
  "note.read","note.create","note.delete_any","notification.read",
  "conversation.assign_self","conversation.reply_own","conversation.resolve_own",
  "note.delete_own"
];

const db = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    console.log('[DEBUG MIGRATION DB] SQL:', s);
    
    // SELECT count(*) with wildcard
    if (/select count\(\*\)/.test(s) && /from roles where name = 'company admin' and permissions @>/.test(s)) {
      console.log('[DEBUG MIGRATION DB] MATCHED: SELECT count(*) with @>');
      let count = 0;
      for (const [, r] of roles) {
        if (r.name === 'Company Admin' && Array.isArray(r.permissions) && r.permissions.includes('*')) {
          count++;
        }
      }
      console.log('[DEBUG MIGRATION DB] Count:', count);
      return { rows: [{ count }] };
    }
    
    // SELECT roles with wildcard (non-count)
    if (/from roles where name = 'company admin' and permissions @>/.test(s)) {
      console.log('[DEBUG MIGRATION DB] MATCHED: SELECT with @> (non-count)');
      console.log('[DEBUG MIGRATION DB] Roles map:', Array.from(roles.entries()));
      const results = [];
      for (const [, r] of roles) {
        console.log('[DEBUG MIGRATION DB] Checking role:', r);
        if (r.name === 'Company Admin' && Array.isArray(r.permissions) && r.permissions.includes('*')) {
          results.push(r);
        }
      }
      console.log('[DEBUG MIGRATION DB] Results:', results);
      return { rows: results };
    }
    
    // UPDATE roles - replace wildcard
    if (/update roles set permissions = \$\d+/.test(s) && /where name = 'company admin' and permissions @>/.test(s)) {
      console.log('[DEBUG MIGRATION DB] MATCHED: UPDATE with @>');
      console.log('[DEBUG MIGRATION DB] Roles map before:', Array.from(roles.entries()));
      console.log('[DEBUG MIGRATION DB] Update params:', params);
      let count = 0;
      for (const [key, r] of roles) {
        console.log('[DEBUG MIGRATION DB] Checking role for update:', r.name, r.permissions, Array.isArray(r.permissions), r.permissions?.includes('*'));
        if (r.name === 'Company Admin' && Array.isArray(r.permissions) && r.permissions.includes('*')) {
          // Parse JSON string to array
          r.permissions = JSON.parse(params[0]);
          roles.set(key, r);
          count++;
        }
      }
      console.log('[DEBUG MIGRATION DB] Roles map after:', Array.from(roles.entries()));
      return { rows: [], rowCount: count };
    }
    
    // SELECT all Company Admin roles (without @> condition)
    if (/from roles where name = 'company admin'/.test(s) && !/permissions @>/.test(s)) {
      console.log('[DEBUG MIGRATION DB] MATCHED: SELECT all Company Admin');
      const results = [];
      for (const [, r] of roles) {
        if (r.name === 'Company Admin') results.push(r);
      }
      return { rows: results };
    }
    
    // SELECT permissions for specific tenant/role (for test verification)
    if (/select permissions from roles where tenant_id = '[^']+' and name = 'company admin'/.test(s) ||
        /select name, permissions from roles where tenant_id = '[^']+'/.test(s)) {
      console.log('[DEBUG MIGRATION DB] MATCHED: SELECT permissions for tenant');
      const results = [];
      for (const [, r] of roles) {
        if (r.name === 'Company Admin' || r.name === 'Supervisor' || r.name === 'Agent') {
          results.push(r);
        }
      }
      return { rows: results };
    }
    
    // INSERT role (for test setup)
    if (/insert into roles/.test(s)) {
      console.log('[DEBUG MIGRATION DB] MATCHED: INSERT role');
      const key = `${params[0]}:${params[1]}`;
      const r = { id: key, tenant_id: params[0], name: params[1], permissions: params[2] };
      roles.set(key, r);
      return { rows: [r] };
    }
    
    console.log('[DEBUG MIGRATION DB] NO MATCH');
    return { rows: [] };
  }
};

// Helper to run migration logic
async function runMigration() {
  // Step 1: Identify affected
  const { rows: affected } = await db.query(
    `SELECT count(*) as count FROM roles WHERE name = 'Company Admin' AND permissions @> '["*"]'::jsonb`
  );
  console.log(`[MIGRATION] Found ${affected[0]?.count || 0} Company Admin role(s) with wildcard permissions`);
  
  // Step 2: Replace wildcard
  const result = await db.query(
    `UPDATE roles SET permissions = $1 WHERE name = 'Company Admin' AND permissions @> '["*"]'::jsonb`,
    [JSON.stringify(explicitPermissions)]
  );
  console.log(`[MIGRATION] Updated ${result.rowCount || 0} role(s)`);
  
  // Step 3: Verify
  const { rows: remaining } = await db.query(
    `SELECT count(*) as count FROM roles WHERE name = 'Company Admin' AND permissions @> '["*"]'::jsonb`
  );
  console.log(`[MIGRATION] Remaining with wildcard: ${remaining[0]?.count || 0}`);
  
  return { affected: affected[0]?.count || 0, updated: result.rowCount || 0, remaining: remaining[0]?.count || 0 };
}

console.log('\n🧪 Migration 011 Verification Tests\n');

// Test 1: Legacy Company Admin with wildcard gets converted
console.log('--- Test 1: Legacy Company Admin wildcard replaced ---');
roles.clear();
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-legacy', 'Company Admin', ['*']]);
const r1 = await runMigration();
check('Wildcard role detected', r1.affected === 1);
check('Wildcard role updated', r1.updated === 1);
check('No wildcards remain', r1.remaining === 0);
const { rows: check1 } = await db.query(`SELECT permissions FROM roles WHERE tenant_id = 't-legacy' AND name = 'Company Admin'`);
check('Permissions are explicit array', Array.isArray(check1[0]?.permissions));
check('All 30 permissions present', check1[0]?.permissions?.length === 30);
check('No wildcard in permissions', !check1[0]?.permissions?.includes('*'));

// Test 2: Custom explicit permissions preserved
console.log('\n--- Test 2: Custom explicit permissions preserved ---');
roles.clear();
const customPerms = ['brand.read', 'brand.create', 'user.read'];
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-custom', 'Company Admin', customPerms]);
const r2 = await runMigration();
check('Custom permissions role not affected', r2.affected === 0);
check('Custom permissions role not updated', r2.updated === 0);
const { rows: check2 } = await db.query(`SELECT permissions FROM roles WHERE tenant_id = 't-custom' AND name = 'Company Admin'`);
check('Custom permissions preserved', JSON.stringify(check2[0]?.permissions) === JSON.stringify(customPerms));

// Test 3: Other roles unaffected
console.log('\n--- Test 3: Other roles unaffected ---');
roles.clear();
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-other', 'Company Admin', ['*']]);
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-other', 'Supervisor', ['*']]);
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-other', 'Agent', ['conversation.read']]);
const r3 = await runMigration();
check('Company Admin wildcard updated', r3.updated === 1);
const { rows: check3 } = await db.query(`SELECT name, permissions FROM roles WHERE tenant_id = 't-other'`);
const supervisor = check3.find(r => r.name === 'Supervisor');
const agent = check3.find(r => r.name === 'Agent');
check('Supervisor wildcard preserved', supervisor?.permissions?.includes('*') === true);
check('Agent permissions preserved', JSON.stringify(agent?.permissions) === JSON.stringify(['conversation.read']));

// Test 4: Idempotent re-execution
console.log('\n--- Test 4: Idempotent re-execution ---');
roles.clear();
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-idem', 'Company Admin', ['*']]);
await runMigration(); // First run
const r4a = await runMigration(); // Second run
const r4b = await runMigration(); // Third run
check('Second run updates 0', r4a.updated === 0);
check('Third run updates 0', r4b.updated === 0);
check('No wildcards after re-runs', r4a.remaining === 0 && r4b.remaining === 0);
const { rows: check4 } = await db.query(`SELECT permissions FROM roles WHERE tenant_id = 't-idem' AND name = 'Company Admin'`);
check('Permissions still explicit after re-runs', check4[0]?.permissions?.length === 30);

// Test 5: No Company Admin roles at all
console.log('\n--- Test 5: No Company Admin roles ---');
roles.clear();
await db.query(`INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, $2, $3)`, ['t-none', 'Supervisor', ['*']]);
const r5 = await runMigration();
check('No Company Admin roles detected', r5.affected === 0);
check('No updates performed', r5.updated === 0);

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);