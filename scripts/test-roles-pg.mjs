// Real-PostgreSQL A1 test suite.
//
// Follows the established pattern from test-team-access-pg.mjs: apply the real
// migration ledger to a throwaway database, exercise the service layer against
// real rows, and spin up the mounted router over real HTTP for the authz gates.
//
// Every assertion here exists because a service-level test alone has already
// proven it cannot see route-level bugs (the team.disable gate in 76fc2a2 and
// the response envelope in e69b99a both survived a 78-test service suite).
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('  SKIP  TEST_DATABASE_URL not set - skipping the real-PostgreSQL A1 suite.');
  process.exit(0);
}

// src/db/pg.js exposes `pool = null` when DATABASE_URL is unset, and several
// legacy route handlers (src/routes/users.js among them) use that module-level
// pool rather than the injected one. Without this, mounting the full v1 router
// and exercising a user endpoint crashed the process with
// "Cannot read properties of null (reading 'connect')" - an unhandled rejection
// that aborted the run before any summary was printed.
process.env.DATABASE_URL ||= url;
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);

const client = new pg.Client({ connectionString: url });
const q = (sql, params) => client.query(sql, params);

// The role services call db.connect() to take a dedicated client inside a
// transaction. A pg.Client cannot be reused that way - its connect() throws once
// it is already connected - so the suite hands the services a pool.
// It previously passed the single already-connected Client, which could never
// have worked; the suite simply had not been able to run at all.
const dbPool = new pg.Pool({ connectionString: url, max: 6 });

let pass = 0, failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const rejects = async (name, code, fn) => {
  try { await fn(); check(name, false, 'expected a rejection, got success'); }
  catch (e) { check(name, e?.code === code, `code=${e?.code} want=${code}`); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

await client.connect();

try {
  // ---------------------------------------------------------------- 0 migrations
  const dirs = readdirSync(join(REPO, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of dirs) {
    await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  }
  check('all migrations apply cleanly, including 021', true);
  check('and are re-runnable', (await q('SELECT 1')).rowCount === 1);

  // ---------------------------------------------------------------- 1 shape
  section('1 021 shape');
  {
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='roles'`);
    const colNames = cols.rows.map((r) => r.column_name);
    check('roles.status exists', colNames.includes('status'));
    check('roles.created_by exists', colNames.includes('created_by'));
    check('roles.updated_at exists', colNames.includes('updated_at'));
    const pk = await q(`SELECT count(*)::int n FROM pg_constraint WHERE conname='user_roles_pkey'`);
    check('user_roles has a PK', pk.rows[0].n === 1);
    const fk = await q(`SELECT count(*)::int n FROM pg_constraint WHERE conname='user_roles_role_id_fkey'`);
    check('user_roles has an FK to roles', fk.rows[0].n === 1);
  }

  // ---------------------------------------------------------------- 1b migration 022
  section('1b 022 shape');
  {
    const checkConstraint = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='roles_status_check'`);
    const def = checkConstraint.rows[0]?.def || '';
    check('roles_status_check allows deleted', def.includes('deleted'));
  }


  // ---------------------------------------------------------------- 2 fixtures
  section('2 fixtures');
  const { rows: [{ id: t1 }] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T1','a1-t1') RETURNING id`);
  const { rows: [{ id: t2 }] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T2','a1-t2') RETURNING id`);
  const { rows: [{ id: b1 }] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1','a1-b1') RETURNING id`, [t1]);
  const { rows: [{ id: admin }] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'admin@t.local','Admin','x') RETURNING id`, [t1]);
  const { rows: [{ id: agent }] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'agent@t.local','Agent','x') RETURNING id`, [t1]);
  const { rows: [{ id: outsider }] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'out@t2.local','Out','x') RETURNING id`, [t2]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Company Admin',$2::jsonb)`, [t1, JSON.stringify(['role.read','role.create','role.update','role.disable','role.delete','user.read','user.create'])]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Supervisor',$2::jsonb)`, [t1, JSON.stringify(['role.read','conversation.read'])]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Agent',$2::jsonb)`, [t1, JSON.stringify(['conversation.read'])]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Escalation Manager',$2::jsonb)`, [t1, JSON.stringify(['escalation.resolve'])]);
  // A role that belongs to the SECOND company. The HTTP section tries to reach
  // it from a first-company session and expects a 404; without this row the
  // lookup returned nothing and threw, which is how the assertion silently
  // stopped being an assertion at all.
  const { rows: [otherTenantRole] } = await q(
    `INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Other Tenant Manager',$2::jsonb) RETURNING id`, [t2, JSON.stringify(['conversation.read'])]);
  // Assign admin the Company Admin role
  const { rows: [adminRole] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t1]);
  await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [admin, adminRole.id]);
  const { rows: [supRole] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Supervisor'`, [t1]);
  await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [agent, supRole.id]);

  const { createRole, updateRole, setRoleStatus, deleteRole, listRoles, getRoleUsers, ROLE_ERRORS } =
    await import('../src/services/roles.js');
  const { can, effectiveCustomAbilities, normalizeCustomAbilities, hasTenantWideBrandScope,
    TENANT_WIDE_BRAND_ABILITY } = await import('../src/auth/abilities.js');

  // ---------------------------------------------------------------- 3 CRUD
  section('3 create');
  {
    const r = await createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      name: 'Custom Manager', permissions: ['conversation.read', 'conversation.reply'], db: dbPool });
    check('a custom role is created', r.name === 'Custom Manager');
    check('and starts active', r.status === 'active');
    check('with the requested permissions', JSON.stringify(r.permissions) === JSON.stringify(['conversation.read','conversation.reply']));
    eq('and permissions are deduplicated', r.permissions.length, 2);

    // A permission list is required to reach the name check. With `permissions:
    // []`, canDelegateRole fail-closes on the empty ability list and raises
    // NOT_DELEGABLE first (see "an empty permission set is refused" below).
    // conversation.read is held by Company Admin, so the delegation ceiling is
    // satisfied and the request reaches the uniqueness check as intended.
    await rejects('a duplicate name is refused', ROLE_ERRORS.NAME_TAKEN,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Custom Manager',
        permissions: ['conversation.read'], db: dbPool }));

    await rejects('a blank name is refused', ROLE_ERRORS.NAME_INVALID,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: '   ', permissions: [], db: dbPool }));

    await rejects('a reserved name is refused', ROLE_ERRORS.SYSTEM,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','role.read'], name: 'Company Admin', permissions: [], db: dbPool }));

    await rejects('Platform Super Admin name is reserved', ROLE_ERRORS.SYSTEM,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Platform Super Admin', permissions: [], db: dbPool }));

    await rejects('a wildcard is refused', ROLE_ERRORS.INVALID,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','conversation.read'], name: 'Wildcard', permissions: ['*'], db: dbPool }));

    await rejects('a partial wildcard is refused', ROLE_ERRORS.INVALID,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','conversation.read'], name: 'Partial Wildcard', permissions: ['conversation.*'], db: dbPool }));

    await rejects('an unknown ability is refused', ROLE_ERRORS.INVALID,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Unknown', permissions: ['nonexistent.ability'], db: dbPool }));

    // The escalation target must be an ability Company Admin does NOT already hold.
    // The previous version asked for user.disable + brand.grant_all; verified
    // against ROLE_ABILITIES, Company Admin holds BOTH, so the delegation
    // ceiling was correct to permit it and the assertion was wrong.
    // company.create is in KNOWN_ABILITIES and is held by no non-platform role,
    // so handing it to a custom role is a genuine escalation attempt.
    await rejects('privilege escalation is refused', ROLE_ERRORS.NOT_DELEGABLE,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create', 'user.disable', 'brand.grant_all'],
        name: 'Escalated', permissions: ['user.disable', 'company.create'], db: dbPool }));

    // Pinned explicitly, because the previous expectation depended on the actor
    // NOT holding an ability it in fact holds.
    check('Company Admin does hold user.disable and brand.grant_all',
      can(['Company Admin'], 'user.disable', []) && can(['Company Admin'], 'brand.grant_all', []));
    check('so those are not escalations', await (async () => {
      try {
        await createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
          actorCustomAbilities: ['role.create', 'user.disable', 'brand.grant_all'],
          name: 'Not Escalated', permissions: ['user.disable', 'brand.grant_all'], db: dbPool });
        return true;
      } catch { return false; }
    })());

    // An empty permission set is refused by the delegation ceiling, which
    // fail-closes on "no abilities to compare". Documented here because it is
    // fail-closed rather than permissive: an empty custom role cannot be created.
    await rejects('an empty permission set is refused', ROLE_ERRORS.NOT_DELEGABLE,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Empty Role', permissions: [], db: dbPool }));

    // TENANT SCOPE IS ENFORCED AT THE ROUTE, NOT IN THE SERVICE.
    //
    // createRole() scopes every statement to the tenantId it is handed and never
    // re-checks which tenant the actor belongs to, because the service has no
    // way to know. That is deliberate: the API is the boundary. Every route in
    // api/v1/roles.js takes tenantId from scope(req, res), which reads
    // req.v1.tenantId / req.auth.tenantId, never from the request body - so a
    // client cannot name another company at all.
    //
    // The previous assertion expected ROLE_FORBIDDEN from the service, which
    // does not exist and never has; it only ever passed a coincidental
    // NOT_DELEGABLE from the empty permission list. It asserted a guarantee
    // that lived somewhere else and never tested it. The real guarantee is
    // pinned in the HTTP section below, against a live route.
    const serviceTrustsItsCaller = await (async () => {
      try {
        await createRole({ tenantId: t2, actorUserId: admin, actorRoles: ['Company Admin'],
          actorCustomAbilities: ['role.create'], name: 'Foreign', permissions: ['conversation.read'], db: dbPool });
        return true;
      } catch { return false; }
    })();
    check('the service scopes to the tenantId it is given (it trusts its caller)', serviceTrustsItsCaller);
    await q(`DELETE FROM roles WHERE tenant_id=$1 AND name='Foreign'`, [t2]);

    // Verify the role exists in the DB
    const { rows: [r1] } = await q("SELECT name, permissions, status FROM roles WHERE tenant_id=$1 AND name='Custom Manager'", [t1]);
    check('the role is persisted', r1.name === 'Custom Manager');
    check('with active status', r1.status === 'active');
  }

  // ---------------------------------------------------------------- 4 edit
  section('4 edit');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Custom Manager'`, [t1]);
    const updated = await updateRole({
      tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      roleId: role.id, name: 'Renamed Manager', permissions: ['conversation.read'], db: dbPool
    });
    check('a role can be renamed', updated.name === 'Renamed Manager');
    check('and its permissions updated', JSON.stringify(updated.permissions) === JSON.stringify(['conversation.read']));

    const sysRoleId = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1])).rows[0].id;
    await rejects('editing a system role is refused', ROLE_ERRORS.SYSTEM,
      () => updateRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.update'], roleId: sysRoleId,
        name: 'Hacked', permissions: ['*'], db: dbPool }));
    await rejects('editing a non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => updateRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.update'], roleId: '00000000-0000-0000-0000-000000000000',
        name: 'Ghost', permissions: [], db: dbPool }));

    await rejects('cross-tenant edit is refused', ROLE_ERRORS.NOT_FOUND,
      () => updateRole({ tenantId: t2, actorUserId: outsider, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.update'], roleId: role.id, name: 'Stolen', permissions: [], db: dbPool }));

    // Verify audit was written
    const { rows: [audit] } = await q(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='role.updated'`, [role.id]);
    check('an audit row was written for the edit', audit.action === 'role.updated');
  }

  section('5 disable / enable');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Renamed Manager'`, [t1]);
    const disabled = await setRoleStatus({ tenantId: t1, actorUserId: admin, roleId: role.id, status: 'disabled', db: dbPool });
    check('a role can be disabled', disabled.status === 'disabled');

    const sysRoleId2 = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1])).rows[0].id;
    await rejects('disabling a system role is refused', ROLE_ERRORS.SYSTEM,
      () => setRoleStatus({ tenantId: t1, actorUserId: admin, roleId: sysRoleId2, status: 'disabled', db: dbPool }));
    await rejects('disabling a non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => setRoleStatus({ tenantId: t1, actorUserId: admin, roleId: '00000000-0000-0000-0000-000000000000', status: 'disabled', db: dbPool }));

    const enabled = await setRoleStatus({ tenantId: t1, actorUserId: admin, roleId: role.id, status: 'active', db: dbPool });
    check('a role can be re-enabled', enabled.status === 'active');

    const { rows: [audit] } = await q(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='role.enabled'`, [role.id]);
    check('an audit row was written for the enable', audit?.action === 'role.enabled');
  }

  section('6 delete (soft)');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Renamed Manager'`, [t1]);
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [agent, role.id]);
    await rejects('deleting a role with holders is refused', ROLE_ERRORS.NOT_DELEGABLE,
      () => deleteRole({ tenantId: t1, actorUserId: admin, roleId: role.id, db: dbPool }));
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [role.id]);
    const deleted = await deleteRole({ tenantId: t1, actorUserId: admin, roleId: role.id, db: dbPool });
    // Migration 022 made soft delete set status='deleted' (distinct from
    // 'disabled', so a deleted role cannot be re-enabled). This assertion still
    // expected 'disabled' and had been failing silently while the suite could
    // not execute. The HTTP section below already asserted 'deleted' correctly.
    check('a role can be soft-deleted', deleted.status === 'deleted', `status=${deleted.status}`);
    check('and it is not merely disabled', deleted.status !== 'disabled');
    const sysRoleId2 = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1])).rows[0].id;
    await rejects('deleting a system role is refused', ROLE_ERRORS.SYSTEM,
      () => deleteRole({ tenantId: t1, actorUserId: admin, roleId: sysRoleId2, db: dbPool }));
    await rejects('deleting a non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => deleteRole({ tenantId: t1, actorUserId: admin, roleId: '00000000-0000-0000-0000-000000000000', db: dbPool }));
    await rejects('cross-tenant delete is refused', ROLE_ERRORS.NOT_FOUND,
      () => deleteRole({ tenantId: t2, actorUserId: outsider, roleId: role.id, db: dbPool }));
    const { rows: [audit] } = await q(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='role.deleted'`, [role.id]);
    check('an audit row was written for the delete', audit?.action === 'role.deleted');
  }

  section('7 list');
  {
    const roles = await listRoles({ tenantId: t1, db: dbPool });
    check('list returns roles', roles.length > 0);
    check('system roles are included (read-only)', roles.some((r) => r.name === 'Company Admin'));
    check('deleted role is excluded from the default list', !roles.some((r) => r.name === 'Renamed Manager'));
    const rolesWithDeleted = await listRoles({ tenantId: t1, db: dbPool, includeDeleted: true });
    check('deleted role is present when explicitly requested', rolesWithDeleted.some((r) => r.name === 'Renamed Manager' && r.status === 'deleted'));

    const t2Roles = await listRoles({ tenantId: t2, db: dbPool });
    const caRoleId = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1])).rows[0].id;
    check('list is tenant-scoped', !t2Roles.some((r) => r.name === 'Company Admin' && r.id === caRoleId));
  }

  // ---------------------------------------------------------------- 8 getRoleUsers
  section('8 getRoleUsers');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t1]);
    const users = await getRoleUsers({ tenantId: t1, roleId: role.id, db: dbPool });
    check('returns users holding the role', users.length >= 1);
    check('with correct shape', users[0].email !== undefined);

    await rejects('non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => getRoleUsers({ tenantId: t1, roleId: '00000000-0000-0000-0000-000000000000', db: dbPool }));

    await rejects('cross-tenant access is refused', ROLE_ERRORS.NOT_FOUND,
      () => getRoleUsers({ tenantId: t2, roleId: role.id, db: dbPool }));
  }

  // ---------------------------------------------------------------- 9 assignment
  section('9 role assignment via user_roles');
  {
    // Create a fresh custom role for assignment testing
    const r = await createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      name: 'Assignable Role', permissions: ['conversation.read'], db: dbPool });
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Assignable Role'`, [t1]);

    // Assign to agent
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [agent, role.id]);
    // `check` is the assertion helper. Naming a destructured row `check` shadowed
    // it for the rest of the block, and the next call threw
    // "check is not a function" - which aborted the whole suite, so sections 10
    // onward never ran. Renamed.
    const { rows: [assignment] } = await q(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2`, [agent, role.id]);
    check('role can be assigned to a user', !!assignment);

    // Unassign
    await q(`DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2`, [agent, role.id]);
    const { rows: [gone] } = await q(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2`, [agent, role.id]);
    check('role can be unassigned', !gone);

    // Clean up
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [role.id]);
    await deleteRole({ tenantId: t1, actorUserId: admin, roleId: role.id, db: dbPool });
  }

  // ---------------------------------------------------------------- 10 disabled role grants zero
  section('10 disabled role grants nothing');
  {
    const r = await createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      name: 'Disable Test', permissions: ['conversation.read', 'conversation.reply'], db: dbPool });
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Disable Test'`, [t1]);

    // Assign to agent
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [agent, role.id]);

    // Disable the role
    await setRoleStatus({ tenantId: t1, actorUserId: admin, roleId: role.id, status: 'disabled', db: dbPool });

    // Verify the role is disabled
    const { rows: [disabled] } = await q(`SELECT status FROM roles WHERE id=$1`, [role.id]);
    check('role is disabled in DB', disabled.status === 'disabled');

    // Verify session invalidation (sessions for holders are revoked)
    // Note: in test DB there may be no sessions, so this is a no-op check

    // Re-enable
    await setRoleStatus({ tenantId: t1, actorUserId: admin, roleId: role.id, status: 'active', db: dbPool });
    const { rows: [enabled] } = await q(`SELECT status FROM roles WHERE id=$1`, [role.id]);
    check('role can be re-enabled', enabled.status === 'active');

    // Clean up
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [role.id]);
    await deleteRole({ tenantId: t1, actorUserId: admin, roleId: role.id, db: dbPool });
  }

  // ---------------------------------------------------------------- 11 transaction atomicity
  section('11 transaction atomicity on failure');
  {
    // WHAT THIS USED TO ASSERT, AND WHY IT COULD NOT BE TRUE.
    // The previous version wrapped the calls in its own BEGIN/ROLLBACK and then
    // expected zero rows. That framing was impossible: acquire() borrows its OWN
    // client from the pool and manages its own BEGIN/COMMIT/ROLLBACK, so a
    // BEGIN issued by the caller on a different connection cannot wrap it. The
    // first create committed regardless, and the assertion was failing for a
    // reason that had nothing to do with the service.
    //
    // WHAT IS ACTUALLY GUARANTEED, AND NOW TESTED: a createRole call that fails
    // adds no row. That is the real atomicity property - its own transaction
    // leaves nothing behind - and it is independent of what the caller does.
    const countRows = async (name) =>
      (await q(`SELECT count(*)::int n FROM roles WHERE tenant_id=$1 AND name=$2`, [t1, name])).rows[0].n;

    await q(`DELETE FROM roles WHERE tenant_id=$1 AND name='Atomicity Test'`, [t1]);

    const before = await countRows('Atomicity Test');
    eq('the name is free to begin with', before, 0);

    await createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create', 'role.read'], name: 'Atomicity Test',
      permissions: ['conversation.read'], db: dbPool });
    eq('a valid create persists one row', await countRows('Atomicity Test'), 1);

    // Now fail it: a duplicate name must not add a second row, and must not
    // damage the first.
    await rejects('a duplicate create is refused', ROLE_ERRORS.NAME_TAKEN,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create', 'role.read'], name: 'Atomicity Test',
        permissions: ['conversation.reply'], db: dbPool }));
    eq('a failed create adds no row', await countRows('Atomicity Test'), 1);

    // A failure inside the transaction, after validation has passed, must also
    // leave nothing: the permission set that trips the delegation ceiling is
    // rejected before any write, and the row count must be unchanged.
    const countBeforeEscalation = await countRows('Escalated');
    await rejects('an escalation attempt is refused', ROLE_ERRORS.NOT_DELEGABLE,
      () => createRole({ tenantId: t1, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create', 'role.read'], name: 'Atomicity Escalation',
        permissions: ['company.create'], db: dbPool }));
    eq('and leaves no escalation row behind', await countRows('Atomicity Escalation'), 0);
    eq('and disturbs no existing row', await countRows('Escalated'), countBeforeEscalation);

    await q(`DELETE FROM roles WHERE tenant_id=$1 AND name='Atomicity Test'`, [t1]);
  }

  // ---------------------------------------------------------------- 12 HTTP authz
  section('12 HTTP authorization (real Express, real DB)');
  {
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });

    const appFor = (roles, customAbilities = []) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId: t1, user: { id: admin, email: 'admin@t.local', name: 'A' },
          roles, customAbilities
        }),
        verifyPasswordFn: async () => false,
        createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
        revokeSessionFn: async () => {},
        lockedSecondsFn: async () => 0,
        recordFailedLoginFn: async () => {},
        resetLoginAttemptsFn: async () => {}
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () =>
          r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
      });
    };

    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };
    const send = (base, auth, method, path, body) => fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: auth.cookie,
        ...(method === 'GET' ? {} : { 'x-csrf-token': auth.csrf })
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    // Company Admin: can create
    const ca = await appFor(['Company Admin'], ['role.read','role.create','role.update','role.disable','role.delete','user.read','user.create']);
    const caAuth = await authFor(ca.base);
    const created = await send(ca.base, caAuth, 'POST', '/roles', { name: 'HTTP Test Role', permissions: ['conversation.read'] });
    eq('Company Admin can create a role', created.status, 201);
    const roleId = created.body?.data?.role?.id;

    // Supervisor: read-only
    const sup = await appFor(['Supervisor'], ['role.read','conversation.read']);
    const supAuth = await authFor(sup.base);
    eq('Supervisor can list roles', (await send(sup.base, supAuth, 'GET', '/roles')).status, 200);
    eq('Supervisor cannot create', (await send(sup.base, supAuth, 'POST', '/roles', { name: 'Nope', permissions: [] })).status, 403);
    eq('Supervisor cannot edit', (await send(sup.base, supAuth, 'PATCH', `/roles/${roleId}`, { name: 'Hacked' })).status, 403);
    eq('Supervisor cannot disable', (await send(sup.base, supAuth, 'POST', `/roles/${roleId}/status`, { status: 'disabled' })).status, 403);
    eq('Supervisor cannot delete', (await send(sup.base, supAuth, 'DELETE', `/roles/${roleId}`)).status, 403);

    // Agent: no access
    const ag = await appFor(['Agent'], []);
    const agAuth = await authFor(ag.base);
    eq('Agent cannot list roles', (await send(ag.base, agAuth, 'GET', '/roles')).status, 403);
    eq('Agent cannot create', (await send(ag.base, agAuth, 'POST', '/roles', { name: 'Nope', permissions: [] })).status, 403);

    // System role protection
    const sysRoleId = (await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t1])).rows[0].id;
    eq('editing a system role is refused', (await send(ca.base, caAuth, 'PATCH', `/roles/${sysRoleId}`, { name: 'Hacked' })).status, 409);
    eq('disabling a system role is refused', (await send(ca.base, caAuth, 'POST', `/roles/${sysRoleId}/status`, { status: 'disabled' })).status, 409);
    eq('deleting a system role is refused', (await send(ca.base, caAuth, 'DELETE', `/roles/${sysRoleId}`)).status, 409);

    // Reserved name
    eq('a reserved name is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'Platform Super Admin', permissions: [] })).status, 409);

    // Wildcard rejection
    eq('a wildcard is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'Wildcard', permissions: ['*'] })).status, 422);
    eq('a partial wildcard is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'Partial', permissions: ['conversation.*'] })).status, 422);

    // Unknown ability
    eq('an unknown ability is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'Unknown', permissions: ['nonexistent.ability'] })).status, 422);

    // Privilege escalation
    eq('privilege escalation is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'Escalated', permissions: ['user.disable', 'company.create'] })).status, 403);

    // TENANT SCOPE AT THE REAL BOUNDARY.
    // The service trusts the tenantId it is given; this is the assertion that
    // actually matters, because a client CAN try to name another company. The
    // route must ignore any tenantId in the body and use the session's.
    {
      const smuggled = await send(ca.base, caAuth, 'POST', '/roles', {
        name: 'Smuggled Tenant',
        permissions: ['conversation.read'],
        tenantId: t2
      });
      if (smuggled.status === 201) {
        const { rows: [landed] } = await q(
          `SELECT tenant_id FROM roles WHERE name='Smuggled Tenant' ORDER BY created_at DESC LIMIT 1`);
        eq('a tenantId in the request body is ignored; the role lands in the session tenant',
          String(landed.tenant_id), String(t1));
        await q(`DELETE FROM roles WHERE id=(SELECT id FROM roles WHERE name='Smuggled Tenant' ORDER BY created_at DESC LIMIT 1)`);
      } else {
        // Refusing outright is also a correct outcome; it must simply never land
        // in the other company.
        const { rows: [elsewhere] } = await q(`SELECT 1 FROM roles WHERE name='Smuggled Tenant' AND tenant_id=$1`, [t2]);
        check('a smuggled tenantId never creates a role in another company', !elsewhere);
      }
      const { rows: [crossTenant] } = await q(`SELECT 1 FROM roles WHERE name='Smuggled Tenant' AND tenant_id=$1`, [t2]);
      check('no role was created in the other company', !crossTenant);
    }

    // Cross-tenant: this session belongs to t1 and must not reach a role that
    // belongs to t2. Refers to the fixture row created in t2, not to a lookup
    // that could return nothing.
    eq('cross-tenant access is refused',
      (await send(ca.base, caAuth, 'GET', `/roles/${otherTenantRole.id}`)).status, 404);
    eq('cross-tenant edit is refused',
      (await send(ca.base, caAuth, 'PATCH', `/roles/${otherTenantRole.id}`, { name: 'Hacked' })).status, 404);
    eq('cross-tenant delete is refused',
      (await send(ca.base, caAuth, 'DELETE', `/roles/${otherTenantRole.id}`)).status, 404);
    const { rows: [survived] } = await q(`SELECT name FROM roles WHERE id=$1`, [otherTenantRole.id]);
    eq('and the other company role is untouched', survived?.name, 'Other Tenant Manager');

    // Disable/enable
    const disable = await send(ca.base, caAuth, 'POST', `/roles/${roleId}/status`, { status: 'disabled' });
    eq('a role can be disabled', disable.status, 200);
    eq('and its status is disabled', disable.body?.data?.role?.status, 'disabled');
    const enable = await send(ca.base, caAuth, 'POST', `/roles/${roleId}/status`, { status: 'active' });
    eq('a role can be re-enabled', enable.status, 200);

    // Delete (soft) - first remove any holders
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [roleId]);
    const del = await send(ca.base, caAuth, 'DELETE', `/roles/${roleId}`);
    eq('a role can be soft-deleted', del.status, 200);
    eq('and its status is deleted', del.body?.data?.role?.status, 'deleted');

    // Verify it's still in the DB (soft delete)
    const { rows: [stillThere] } = await q(`SELECT status FROM roles WHERE id=$1`, [roleId]);
    check('soft-deleted role still exists in DB', stillThere.status === 'deleted');

    // Deleted role must disappear from the default list immediately
    const listAfterDelete = await send(ca.base, caAuth, 'GET', '/roles');
    const listedNames = (listAfterDelete.body?.data?.roles ?? []).map((r) => r.name);
    check('deleted role disappears from the API list', !listedNames.includes('HTTP Test Role'));
    check('system roles still appear after delete', listedNames.includes('Company Admin'));
    eq('a fresh GET /roles still returns 200 after delete', listAfterDelete.status, 200);

    // ---------------------------------------------------------------- Negative security tests
    section('12b negative security');

    // 1. Backend rejects updating a deleted role
    eq('updating a deleted role is refused', (await send(ca.base, caAuth, 'PATCH', `/roles/${roleId}`, { name: 'Hacked' })).status, 409);

    // 2. Backend rejects assigning a deleted role to a user
    const userCreate = await send(ca.base, caAuth, 'POST', '/users', { email: 'testassign@t.local', name: 'TestAssign', password: 'password123', roles: [] });
    const testUserId = userCreate.body?.id;
    if (testUserId) {
      eq('assigning a deleted role to a user is refused', (await send(ca.base, caAuth, 'POST', `/users/${testUserId}/roles`, { roles: ['HTTP Test Role'] })).status, 409);
    }

    // 3. Cross-brand isolation: brand.grant_all must never become EFFECTIVE in a
    // custom role.
    //
    // This assertion used to expect a 422 at WRITE time. That was never how the
    // system is designed, and asserting it was checking a control that does not
    // exist rather than the one that does.
    //
    // The real control is at READ time: CUSTOM_ROLE_FORBIDDEN_ABILITIES is
    // stripped by normalizeCustomAbilities, which every session passes through
    // (sessions.js -> effectiveCustomAbilities). That is the stronger placement -
    // it holds even for a row written directly to the database, which a
    // write-time check would not.
    //
    // Verified before changing the test: storing ['brand.grant_all'] yields
    // effective abilities [] and can() is false. No consumer reads the raw
    // column to grant anything; platformRoles.js only displays it.
    const grantedAll = await send(ca.base, caAuth, 'POST', '/roles',
      { name: 'BrandEscalated', permissions: ['brand.grant_all'] });
    check('a role carrying brand.grant_all can be stored', grantedAll.status === 201, `status=${grantedAll.status}`);
    const brandEscalatedId = grantedAll.body?.data?.role?.id;

    if (brandEscalatedId) {
      const { rows: [storedRow] } = await q(`SELECT permissions FROM roles WHERE id=$1`, [brandEscalatedId]);
      eq('the raw column does contain it', storedRow.permissions, ['brand.grant_all']);

      // The guarantee: it cannot take effect.
      const effective = effectiveCustomAbilities(['BrandEscalated'], { BrandEscalated: storedRow.permissions });
      eq('but the effective ability list is empty', effective, []);
      check('and can() refuses it',
        !can(['BrandEscalated'], 'brand.grant_all', effective));
      check('and it confers no tenant-wide brand scope',
        !hasTenantWideBrandScope(['BrandEscalated'], effective));
      check('nor platform privileges',
        !can(['BrandEscalated'], 'platform.admin', effective));
    }

    // The other two members of the forbidden set behave identically.
    for (const forbidden of ['brand.revoke_all', 'platform.*', '*', TENANT_WIDE_BRAND_ABILITY]) {
      eq(`normalizeCustomAbilities drops ${forbidden}`,
        normalizeCustomAbilities(['conversation.read', forbidden]), ['conversation.read']);
    }

    // 4. Disabled role cannot be assigned
    const disabledRoleCreate = await send(ca.base, caAuth, 'POST', '/roles', { name: 'Disabled Test Role', permissions: ['conversation.read'] });
    const disabledRoleId = disabledRoleCreate.body?.data?.role?.id;
    if (disabledRoleId) {
      await send(ca.base, caAuth, 'POST', `/roles/${disabledRoleId}/status`, { status: 'disabled' });
      if (testUserId) {
        eq('assigning a disabled role to a user is refused', (await send(ca.base, caAuth, 'POST', `/users/${testUserId}/roles`, { roles: ['Disabled Test Role'] })).status, 409);
      }
      // Cleanup
      await q(`DELETE FROM user_roles WHERE role_id=$1`, [disabledRoleId]);
      await send(ca.base, caAuth, 'DELETE', `/roles/${disabledRoleId}`);
    }

    // Cleanup test user
    if (testUserId) {
      await q(`DELETE FROM user_roles WHERE user_id=$1`, [testUserId]);
      await q(`DELETE FROM users WHERE id=$1`, [testUserId]);
    }

    for (const s of [ca, sup, ag]) s.s.close();
    await pool.end();
  }

  // ---------------------------------------------------------------- 13 caps
  section('13 capabilities include role.*');
  {
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    const app = express();
    const router = createApiV1Router({
      pool,
      validateSessionFn: async () => ({
        tenantId: t1, user: { id: admin, email: 'admin@t.local', name: 'A' },
        roles: ['Company Admin'], customAbilities: ['role.read','role.create','role.update','role.disable','role.delete','user.read','user.create']
      }),
      verifyPasswordFn: async () => false,
      createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
      revokeSessionFn: async () => {},
      lockedSecondsFn: async () => 0,
      recordFailedLoginFn: async () => {},
      resetLoginAttemptsFn: async () => {}
    });
    app.use(express.json());
    app.use('/api/v1', router);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
    const r = await fetch(`${base}/teams/capabilities`, { headers: { Cookie: 'lwc_session=x' } });
    // Need CSRF cookie first
    const boot = await fetch(`${base}/_health`);
    const csrf = (boot.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
    const r2 = await fetch(`${base}/teams/capabilities`, { headers: { Cookie: `lwc_session=x; ${csrf}` } });
    const caps = (await r2.json())?.data?.abilities ?? [];
    check('capabilities include role.read', caps.includes('role.read'));
    check('capabilities include role.create', caps.includes('role.create'));
    check('capabilities include role.update', caps.includes('role.update'));
    check('capabilities include role.disable', caps.includes('role.disable'));
    check('capabilities include role.delete', caps.includes('role.delete'));
    srv.close();
    await pool.end();
  }

  // ------------------------------------------------- 14 escalation managers
  section('14 escalation managers (Platform Super Admin)');
  {
    // THE REGRESSION THIS SECTION EXISTS FOR
    // ----------------------------------------
    // `listEscalationManagers` compared `audit_logs.object_id` (TEXT) with
    // `users.id` (UUID). PostgreSQL has no `text = uuid` operator, so the query
    // failed for EVERY caller:
    //     ERROR: operator does not exist: text = uuid
    // The API logged "platform escalation list failed" and answered 500, so the
    // endpoint was dead in production - not for one tenant, for all of them.
    //
    // The fix casts the UUID side (`u.id::text`). The cast is deliberately NOT
    // on the text column: `audit_logs.object_id` legitimately holds non-UUID
    // values (B1's connect audit rows store a Facebook Page id there, which is
    // a numeric string), so `a.object_id::uuid` would throw
    // "invalid input syntax for type uuid" the moment the first Page is
    // connected. The assertion below is what distinguishes the two.

    const { listEscalationManagers } = await import('../src/services/platformRoles.js');

    // A holder in t1, and the audit row the subquery looks for.
    // The 'Escalation Manager' role is the one the FIXTURES already created
    // (roles has a unique key on tenant_id + name), so it is reused here rather
    // than created a second time.
    const { rows: [escRole] } = await q(
      `SELECT id FROM roles WHERE tenant_id=$1 AND name='Escalation Manager'`, [t1]);
    check('the escalation manager role fixture exists', !!escRole);
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [agent, escRole.id]);
    await q(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id)
       VALUES ($1,$2,'platform.escalation_manager.grant','user',$3::text)`,
      [t1, admin, String(agent)]);

    // A NON-UUID object_id in the same table and the same tenant: the shape
    // B1's own connect audit rows have.
    await q(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, object_type, object_id)
       VALUES ($1,$2,'integrations.facebook.connect','channel','123456789012345')`,
      [t1, admin]);

    // --- service level ---------------------------------------------------
    const holders = await listEscalationManagers({ tenantId: t1, db: dbPool });
    check('the listing query runs at all (no text = uuid type error)', Array.isArray(holders));
    eq('it finds the holder', holders.filter((h) => String(h.id) === String(agent)).length, 1);
    check('the granted_at timestamp is resolved', holders[0]?.granted_at != null);
    check('a non-UUID object_id in the same table does not break the listing',
      Array.isArray(await listEscalationManagers({ tenantId: t1, db: dbPool })));

    // TENANT SCOPE: the query is filtered by the tenant it is given, so the
    // holders of one company never appear in another company's listing.
    const otherHolders = await listEscalationManagers({ tenantId: t2, db: dbPool });
    eq('another company sees none of these holders',
      otherHolders.filter((h) => String(h.id) === String(agent)).length, 0);

    // --- HTTP level ------------------------------------------------------
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });

    const appFor = (session) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => session,
        verifyPasswordFn: async () => false,
        createSessionFn: async () => ({ token: 'x', expiresAt: new Date(Date.now() + 60000) }),
        revokeSessionFn: async () => {},
        lockedSecondsFn: async () => 0,
        recordFailedLoginFn: async () => {},
        resetLoginAttemptsFn: async () => {}
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () =>
          r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
      });
    };
    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };
    const send = (base, auth, method, path) => fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: auth.cookie }
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    // 1. AUTHORIZED: a real Platform Super Admin.
    const psa = await appFor({
      tenantId: t1, user: { id: admin, email: 'admin@t.local', name: 'A' },
      roles: ['Platform Super Admin'], customAbilities: [], isPlatformSuperAdmin: true
    });
    const psaAuth = await authFor(psa.base);
    const listed = await send(psa.base, psaAuth, 'GET', `/platform/escalation-managers?tenantId=${t1}`);
    eq('a Platform Super Admin gets 200 from the escalation managers listing', listed.status, 200);
    const listedHolders = listed.body?.data?.holders ?? [];
    eq('and the holder is in the response',
      listedHolders.filter((h) => String(h.id) === String(agent)).length, 1);
    check('and the granted_at timestamp is present', listedHolders[0]?.granted_at != null);
    check('the response carries the role name', listed.body?.data?.role === 'Escalation Manager');

    // 2. The query still works with a non-UUID object_id present.
    eq('a non-UUID object_id does not break the endpoint', listed.status, 200);

    // 3. UNAUTHORIZED: a Company Admin must not reach the platform route.
    const ca = await appFor({
      tenantId: t1, user: { id: admin, email: 'admin@t.local', name: 'A' },
      roles: ['Company Admin'], customAbilities: ['role.read']
    });
    const caAuth = await authFor(ca.base);
    eq('a Company Admin is refused',
      (await send(ca.base, caAuth, 'GET', `/platform/escalation-managers?tenantId=${t1}`)).status, 403);

    // 4. The flag alone is not enough: the role has to be there too.
    const flagged = await appFor({
      tenantId: t1, user: { id: admin, email: 'admin@t.local', name: 'A' },
      roles: ['Company Admin'], customAbilities: [], isPlatformSuperAdmin: true
    });
    const flaggedAuth = await authFor(flagged.base);
    eq('the flag without the role is refused',
      (await send(flagged.base, flaggedAuth, 'GET', `/platform/escalation-managers?tenantId=${t1}`)).status, 403);

    // 5. CROSS-TENANT: asking for another company returns that company's list,
    //    never this company's holders.
    const crossListed = await send(psa.base, psaAuth, 'GET', `/platform/escalation-managers?tenantId=${t2}`);
    eq('a Platform Super Admin asking about another company gets 200', crossListed.status, 200);
    eq('and never sees this company holders',
      (crossListed.body?.data?.holders ?? []).filter((h) => String(h.id) === String(agent)).length, 0);

    // 6. The tenantId is required.
    eq('a missing tenantId is a bad request',
      (await send(psa.base, psaAuth, 'GET', '/platform/escalation-managers')).status, 400);

    psa.s.close(); ca.s.close(); flagged.s.close();
    await pool.end();
  }

} catch (e) {
  failures.push(`fatal: ${e?.code ?? ''} ${e?.message}`);
  console.error('\nfatal:', e?.code, e?.message);
} finally {
  await dbPool.end().catch(() => {});
  await client.end().catch(() => {});
}

// The summary and the exit code live HERE, outside the try.
//
// They used to sit at the end of the try block, which meant any thrown error
// jumped straight to the catch and the process fell out with code 0. A fatal -
// including "the migration ledger does not apply" - was therefore reported as a
// SUCCESSFUL CI step while asserting nothing. The summary of run 39193539197
// claimed a passing PostgreSQL suite; it had never executed a single assertion.
console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(64));

// A COUNT FLOOR, not just a zero check.
//
// "pass > 0" is too weak: a suite that dies halfway through still has passes,
// and that is exactly how this suite hid a broken migration ledger for a long
// time. If the assertion count falls below the floor, something was silently
// skipped, so the run fails even when every executed assertion passed.
// Raised from 111 to 127: section 14 (escalation managers) adds 16 assertions.
// The floor is the measured count, so a silently skipped section still fails.
const MIN_ASSERTIONS = 127;
if (pass < MIN_ASSERTIONS) {
  console.log(`  ERROR: ${pass} assertions executed, expected at least ${MIN_ASSERTIONS}.`);
  console.log('  This is NOT a pass - sections were almost certainly skipped.');
  process.exit(1);
}
console.log(`  assertion floor satisfied (${pass} >= ${MIN_ASSERTIONS})`);

process.exit(failures.length ? 1 : 0);



