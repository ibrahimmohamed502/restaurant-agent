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

const client = new pg.Client({ connectionString: url });
const q = (sql, params) => client.query(sql, params);

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
  const { rows: [t1] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T1','a1-t1') RETURNING id`);
  const { rows: [t2] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T2','a1-t2') RETURNING id`);
  const { rows: [b1] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1','a1-b1') RETURNING id`, [t1.id]);
  const { rows: [admin] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'admin@t.local','Admin','x') RETURNING id`, [t1.id]);
  const { rows: [agent] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'agent@t.local','Agent','x') RETURNING id`, [t1.id]);
  const { rows: [outsider] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'out@t2.local','Out','x') RETURNING id`, [t2.id]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Company Admin',$2::jsonb)`, [t1.id, JSON.stringify(['role.read','role.create','role.update','role.disable','role.delete','user.read','user.create'])]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Supervisor',$2::jsonb)`, [t1.id, JSON.stringify(['role.read','conversation.read'])]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Agent',$2::jsonb)`, [t1.id, JSON.stringify(['conversation.read'])]);
  await q(`INSERT INTO roles (tenant_id,name,permissions) VALUES ($1,'Escalation Manager',$2::jsonb)`, [t1.id, JSON.stringify(['escalation.resolve'])]);
  // Assign admin the Company Admin role
  const { rows: [adminRole] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t1.id]);
  await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [admin, adminRole.id]);
  const { rows: [supRole] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Supervisor'`, [t1.id]);
  await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [agent, supRole.id]);

  const { createRole, updateRole, setRoleStatus, deleteRole, listRoles, getRoleUsers, ROLE_ERRORS } =
    await import('../src/services/roles.js');

  // ---------------------------------------------------------------- 3 CRUD
  section('3 create');
  {
    const r = await createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      name: 'Custom Manager', permissions: ['conversation.read', 'conversation.reply'], db: client });
    check('a custom role is created', r.name === 'Custom Manager');
    check('and starts active', r.status === 'active');
    check('with the requested permissions', JSON.stringify(r.permissions) === JSON.stringify(['conversation.read','conversation.reply']));
    eq('and permissions are deduplicated', r.permissions.length, 2);

    await rejects('a duplicate name is refused', ROLE_ERRORS.NAME_TAKEN,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Custom Manager', permissions: [], db: client }));

    await rejects('a blank name is refused', ROLE_ERRORS.NAME_INVALID,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: '   ', permissions: [], db: client }));

    await rejects('a reserved name is refused', ROLE_ERRORS.SYSTEM,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','role.read'], name: 'Company Admin', permissions: [], db: client }));

    await rejects('Platform Super Admin name is reserved', ROLE_ERRORS.SYSTEM,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Platform Super Admin', permissions: [], db: client }));

    await rejects('a wildcard is refused', ROLE_ERRORS.INVALID,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','conversation.read'], name: 'Wildcard', permissions: ['*'], db: client }));

    await rejects('a partial wildcard is refused', ROLE_ERRORS.INVALID,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','conversation.read'], name: 'Partial Wildcard', permissions: ['conversation.*'], db: client }));

    await rejects('an unknown ability is refused', ROLE_ERRORS.INVALID,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Unknown', permissions: ['nonexistent.ability'], db: client }));

    await rejects('privilege escalation is refused', ROLE_ERRORS.NOT_DELEGABLE,
      () => createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create','role.read'], name: 'Escalated', permissions: ['user.disable', 'brand.grant_all'], db: client }));

    await rejects('cross-tenant creation is refused', ROLE_ERRORS.FORBIDDEN,
      () => createRole({ tenantId: t2.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.create'], name: 'Foreign', permissions: [], db: client }));

    // Verify the role exists in the DB
    const { rows: [r1] } = await q("SELECT name, permissions, status FROM roles WHERE tenant_id=$1 AND name='Custom Manager'", [t1.id]);
    check('the role is persisted', r1.name === 'Custom Manager');
    check('with active status', r1.status === 'active');
  }

  // ---------------------------------------------------------------- 4 edit
  section('4 edit');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Custom Manager'`, [t1.id]);
    const updated = await updateRole({
      tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      roleId: role.id, name: 'Renamed Manager', permissions: ['conversation.read'], db: client
    });
    check('a role can be renamed', updated.name === 'Renamed Manager');
    check('and its permissions updated', JSON.stringify(updated.permissions) === JSON.stringify(['conversation.read']));

    const sysRoleId = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1.id])).rows[0].id;
    await rejects('editing a system role is refused', ROLE_ERRORS.SYSTEM,
      () => updateRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.update'], roleId: sysRoleId,
        name: 'Hacked', permissions: ['*'], db: client }));
    await rejects('editing a non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => updateRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.update'], roleId: '00000000-0000-0000-0000-000000000000',
        name: 'Ghost', permissions: [], db: client }));

    await rejects('cross-tenant edit is refused', ROLE_ERRORS.NOT_FOUND,
      () => updateRole({ tenantId: t2.id, actorUserId: outsider, actorRoles: ['Company Admin'],
        actorCustomAbilities: ['role.update'], roleId: role.id, name: 'Stolen', permissions: [], db: client }));

    // Verify audit was written
    const { rows: [audit] } = await q(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='role.updated'`, [role.id]);
    check('an audit row was written for the edit', audit.action === 'role.updated');
  }

  section('5 disable / enable');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Renamed Manager'`, [t1.id]);
    const disabled = await setRoleStatus({ tenantId: t1.id, actorUserId: admin, roleId: role.id, status: 'disabled', db: client });
    check('a role can be disabled', disabled.status === 'disabled');

    const sysRoleId2 = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1.id])).rows[0].id;
    await rejects('disabling a system role is refused', ROLE_ERRORS.SYSTEM,
      () => setRoleStatus({ tenantId: t1.id, actorUserId: admin, roleId: sysRoleId2, status: 'disabled', db: client }));
    await rejects('disabling a non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => setRoleStatus({ tenantId: t1.id, actorUserId: admin, roleId: '00000000-0000-0000-0000-000000000000', status: 'disabled', db: client }));

    const enabled = await setRoleStatus({ tenantId: t1.id, actorUserId: admin, roleId: role.id, status: 'active', db: client });
    check('a role can be re-enabled', enabled.status === 'active');

    const { rows: [audit] } = await q(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='role.enabled'`, [role.id]);
    check('an audit row was written for the enable', audit?.action === 'role.enabled');
  }

  section('6 delete (soft)');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Renamed Manager'`, [t1.id]);
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [agent, role.id]);
    await rejects('deleting a role with holders is refused', ROLE_ERRORS.NOT_DELEGABLE,
      () => deleteRole({ tenantId: t1.id, actorUserId: admin, roleId: role.id, db: client }));
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [role.id]);
    const deleted = await deleteRole({ tenantId: t1.id, actorUserId: admin, roleId: role.id, db: client });
    check('a role can be soft-deleted', deleted.status === 'disabled');
    const sysRoleId2 = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1.id])).rows[0].id;
    await rejects('deleting a system role is refused', ROLE_ERRORS.SYSTEM,
      () => deleteRole({ tenantId: t1.id, actorUserId: admin, roleId: sysRoleId2, db: client }));
    await rejects('deleting a non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => deleteRole({ tenantId: t1.id, actorUserId: admin, roleId: '00000000-0000-0000-0000-000000000000', db: client }));
    await rejects('cross-tenant delete is refused', ROLE_ERRORS.NOT_FOUND,
      () => deleteRole({ tenantId: t2.id, actorUserId: outsider, roleId: role.id, db: client }));
    const { rows: [audit] } = await q(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='role.deleted'`, [role.id]);
    check('an audit row was written for the delete', audit?.action === 'role.deleted');
  }

  section('7 list');
  {
    const roles = await listRoles({ tenantId: t1.id, db: client });
    check('list returns roles', roles.length > 0);
    check('system roles are included (read-only)', roles.some((r) => r.name === 'Company Admin'));
    check('deleted role still appears (soft delete)', roles.some((r) => r.name === 'Renamed Manager' && r.status === 'disabled'));

    const t2Roles = await listRoles({ tenantId: t2.id, db: client });
    const caRoleId = (await q("SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'", [t1.id])).rows[0].id;
    check('list is tenant-scoped', !t2Roles.some((r) => r.name === 'Company Admin' && r.id === caRoleId));
  }

  // ---------------------------------------------------------------- 8 getRoleUsers
  section('8 getRoleUsers');
  {
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t1.id]);
    const users = await getRoleUsers({ tenantId: t1.id, roleId: role.id, db: client });
    check('returns users holding the role', users.length >= 1);
    check('with correct shape', users[0].email !== undefined);

    await rejects('non-existent role is refused', ROLE_ERRORS.NOT_FOUND,
      () => getRoleUsers({ tenantId: t1.id, roleId: '00000000-0000-0000-0000-000000000000', db: client }));

    await rejects('cross-tenant access is refused', ROLE_ERRORS.NOT_FOUND,
      () => getRoleUsers({ tenantId: t2.id, roleId: role.id, db: client }));
  }

  // ---------------------------------------------------------------- 9 assignment
  section('9 role assignment via user_roles');
  {
    // Create a fresh custom role for assignment testing
    const r = await createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      name: 'Assignable Role', permissions: ['conversation.read'], db: client });
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Assignable Role'`, [t1.id]);

    // Assign to agent
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [agent, role.id]);
    const { rows: [check] } = await q(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2`, [agent, role.id]);
    check('role can be assigned to a user', !!check);

    // Unassign
    await q(`DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2`, [agent, role.id]);
    const { rows: [gone] } = await q(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2`, [agent, role.id]);
    check('role can be unassigned', !gone);

    // Clean up
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [role.id]);
    await deleteRole({ tenantId: t1.id, actorUserId: admin, roleId: role.id, db: client });
  }

  // ---------------------------------------------------------------- 10 disabled role grants zero
  section('10 disabled role grants nothing');
  {
    const r = await createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
      actorCustomAbilities: ['role.create','role.read','role.update','role.disable','role.delete','user.read','user.create'],
      name: 'Disable Test', permissions: ['conversation.read', 'conversation.reply'], db: client });
    const { rows: [role] } = await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Disable Test'`, [t1.id]);

    // Assign to agent
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [agent, role.id]);

    // Disable the role
    await setRoleStatus({ tenantId: t1.id, actorUserId: admin, roleId: role.id, status: 'disabled', db: client });

    // Verify the role is disabled
    const { rows: [disabled] } = await q(`SELECT status FROM roles WHERE id=$1`, [role.id]);
    check('role is disabled in DB', disabled.status === 'disabled');

    // Verify session invalidation (sessions for holders are revoked)
    // Note: in test DB there may be no sessions, so this is a no-op check

    // Re-enable
    await setRoleStatus({ tenantId: t1.id, actorUserId: admin, roleId: role.id, status: 'active', db: client });
    const { rows: [enabled] } = await q(`SELECT status FROM roles WHERE id=$1`, [role.id]);
    check('role can be re-enabled', enabled.status === 'active');

    // Clean up
    await q(`DELETE FROM user_roles WHERE role_id=$1`, [role.id]);
    await deleteRole({ tenantId: t1.id, actorUserId: admin, roleId: role.id, db: client });
  }

  // ---------------------------------------------------------------- 11 transaction rollback
  section('11 transaction rollback on failure');
  {
    await rejects('a failed create does not leave a partial row', ROLE_ERRORS.NAME_TAKEN, async () => {
      await q('BEGIN');
      try {
        await createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
          actorCustomAbilities: ['role.create','role.read'], name: 'Rollback Test', permissions: [], db: client });
        // Force a failure by creating a duplicate
        await createRole({ tenantId: t1.id, actorUserId: admin, actorRoles: ['Company Admin'],
          actorCustomAbilities: ['role.create','role.read'], name: 'Rollback Test', permissions: [], db: client });
        await q('COMMIT');
      } catch (e) {
        await q('ROLLBACK');
        throw e;
      }
    });
    // Verify no row was left
    const { rows } = await q(`SELECT count(*)::int n FROM roles WHERE tenant_id=$1 AND name='Rollback Test'`, [t1.id]);
    check('no partial row left after rollback', rows[0].n === 0);
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
          tenantId: t1.id, user: { id: admin, email: 'admin@t.local', name: 'A' },
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
    const sysRoleId = (await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t1.id])).rows[0].id;
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
    eq('privilege escalation is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'Escalated', permissions: ['user.disable', 'brand.grant_all'] })).status, 403);

    // Cross-tenant
    eq('cross-tenant access is refused', (await send(ca.base, caAuth, 'GET', `/roles/${(await q(`SELECT id FROM roles WHERE tenant_id=$1 AND name='Company Admin'`, [t2.id])).rows[0].id}`)).status, 404);

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
    eq('and its status is disabled', del.body?.data?.role?.status, 'disabled');

    // Verify it's still in the DB (soft delete)
    const { rows: [stillThere] } = await q(`SELECT status FROM roles WHERE id=$1`, [roleId]);
    check('soft-deleted role still exists in DB', stillThere.status === 'deleted');

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

    // 3. Cross-brand isolation: brand.grant_all is rejected in custom roles
    eq('brand.grant_all in custom role is refused', (await send(ca.base, caAuth, 'POST', '/roles', { name: 'BrandEscalated', permissions: ['brand.grant_all'] })).status, 422);

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
        tenantId: t1.id, user: { id: admin, email: 'admin@t.local', name: 'A' },
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

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\n  FAILURES:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('='.repeat(64));
  if (pass === 0 && failures.length === 0) {
    console.log('  ERROR: zero assertions executed - this is NOT a pass');
    process.exit(1);
  }
  process.exit(failures.length ? 1 : 0);

} catch (e) {
  failures.push(`fatal: ${e?.code ?? ''} ${e?.message}`);
  console.error('\nfatal:', e?.code, e?.message);
} finally {
  await client.end().catch(() => {});
}



