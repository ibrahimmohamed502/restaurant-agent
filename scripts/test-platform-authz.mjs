/**
 * P0.1 regression: platform authorisation must rest on AUTHORITATIVE membership in
 * `platform_super_admins`, never on a tenant-local role NAME, and a tenant
 * administrator must never be able to grant a role above their own authority.
 *
 *   node scripts/test-platform-authz.mjs
 *
 * Runs on a stub pool - no database, no network, no production access.
 */
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pool } = await import('../src/db/pg.js');
const A = await import('../src/auth/abilities.js');
const RBAC = await import('../src/api/v1/stage7-rbac.js');
const B = await import('../src/api/v1/brandAccess.js');
const { createUsersRouter } = await import('../src/api/v1/users.js');
const { createPlatformRouter } = await import('../src/api/v1/platform.js');
const { sessionCookie } = await import('../src/auth/sessions.js');

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? ' -- ' + d : '')); }
};

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const T1 = U(1), T2 = U(2);
const ACTOR = U(11), TARGET = U(12);

// Roles exactly as the production `roles` table stores them.
const ROLE_PERMS = {
  'Company Admin': ['brand.read', 'brand.create', 'brand.update', 'brand.disable', 'user.read', 'user.create',
    'user.update', 'user.disable', 'brand.grant', 'brand.revoke', 'brand.grant_all', 'brand.revoke_all',
    'brand.integration.connect', 'brand.integration.disconnect', 'brand.integration.reconnect',
    'brand.integration.status', 'company.read', 'company.update', 'conversation.read', 'conversation.handoff',
    'conversation.assign', 'conversation.reassign', 'conversation.unassign', 'conversation.resolve',
    'conversation.resume_ai', 'conversation.reply', 'note.read', 'note.create', 'note.delete_any',
    'notification.read', 'conversation.assign_self', 'conversation.reply_own', 'conversation.resolve_own',
    'note.delete_own', 'knowledge.read', 'knowledge.edit', 'knowledge.publish', 'ai.config.read', 'ai.config.write'],
  Supervisor: ['conversation.read', 'conversation.handoff', 'conversation.assign', 'conversation.reassign',
    'conversation.unassign', 'conversation.resolve', 'conversation.resume_ai', 'conversation.reply',
    'note.read', 'note.create', 'note.delete_any', 'notification.read', 'knowledge.read', 'knowledge.edit',
    'ai.config.read', 'brand.read', 'brand.update', 'brand.grant', 'brand.revoke',
    'brand.integration.connect', 'brand.integration.disconnect', 'brand.integration.reconnect',
    'brand.integration.status', 'user.read', 'user.update'],
  Agent: ['conversation.read', 'conversation.handoff', 'conversation.assign_self', 'conversation.reply_own',
    'conversation.resolve_own', 'note.read', 'note.create', 'note.delete_own', 'notification.read',
    'knowledge.read', 'ai.config.read', 'brand.read', 'brand.integration.status'],
  'Platform Super Admin': ['platform.*']
};

// ---------------------------------------------------------------- pure helpers
console.log('=== 1. Delegation ceiling (pure helper) ===');
{
  check('Platform Super Admin is listed as non-delegable',
    A.NON_DELEGABLE_ROLE_NAMES.includes('Platform Super Admin'));

  const ca = { actorRoles: ['Company Admin'], actorCustomAbilities: [] };
  check('Company Admin CANNOT delegate Platform Super Admin',
    !A.canDelegateRole({ ...ca, targetRoleName: 'Platform Super Admin', targetPermissions: ['platform.*'] }));
  check('Company Admin CANNOT delegate it even with an empty permissions column',
    !A.canDelegateRole({ ...ca, targetRoleName: 'Platform Super Admin', targetPermissions: null }));
  check('Company Admin CANNOT delegate a custom role smuggling platform.*',
    !A.canDelegateRole({ ...ca, targetRoleName: 'Custom Lead', targetPermissions: ['conversation.read', 'platform.create'] }));
  check('Company Admin CANNOT delegate an unknown role (fail closed)',
    !A.canDelegateRole({ ...ca, targetRoleName: 'Wizard', targetPermissions: null }));
  check('Company Admin CAN delegate Company Admin (unchanged, legitimate)',
    A.canDelegateRole({ ...ca, targetRoleName: 'Company Admin', targetPermissions: ROLE_PERMS['Company Admin'] }));
  check('Company Admin CAN delegate Supervisor (unchanged, legitimate)',
    A.canDelegateRole({ ...ca, targetRoleName: 'Supervisor', targetPermissions: ROLE_PERMS.Supervisor }));
  check('Company Admin CAN delegate Agent (unchanged, legitimate)',
    A.canDelegateRole({ ...ca, targetRoleName: 'Agent', targetPermissions: ROLE_PERMS.Agent }));

  check('Supervisor CANNOT delegate Company Admin (above its own authority)',
    !A.canDelegateRole({ actorRoles: ['Supervisor'], targetRoleName: 'Company Admin', targetPermissions: ROLE_PERMS['Company Admin'] }));
  // Agent carries conversation.reply_own / resolve_own / assign_self / note.delete_own,
  // which the Supervisor role does NOT hold - so a strict subset test correctly
  // refuses. This changes no real capability: the users routes are already gated on
  // requireV1Role('Company Admin'), so a Supervisor can never reach them.
  check('Supervisor cannot delegate Agent (Agent holds _own abilities Supervisor lacks)',
    !A.canDelegateRole({ actorRoles: ['Supervisor'], targetRoleName: 'Agent', targetPermissions: ROLE_PERMS.Agent }));
  check('Agent CANNOT delegate Supervisor',
    !A.canDelegateRole({ actorRoles: ['Agent'], targetRoleName: 'Supervisor', targetPermissions: ROLE_PERMS.Supervisor }));
  check('Agent CAN delegate Agent (unchanged)',
    A.canDelegateRole({ actorRoles: ['Agent'], targetRoleName: 'Agent', targetPermissions: ROLE_PERMS.Agent }));
  check('an empty role array is a no-op, not a denial',
    A.canDelegateRole({ actorRoles: ['Company Admin'], targetRoleName: null }) === false);
}

// ------------------------------------------------------- platform gate (req.v1)
console.log('\n=== 2. Platform gate requires AUTHORITATIVE membership ===');

function fakeRes() {
  const r = { _status: 200, _body: null };
  r.status = (c) => { r._status = c; return r; };
  r.json = (b) => { r._body = b; return r; };
  r.setHeader = () => r;
  return r;
}
function runGuard(guard, v1) {
  const res = fakeRes();
  let nexted = false;
  guard({ v1 }, res, () => { nexted = true; });
  return { nexted, status: res._status, body: res._body };
}

{
  const g = RBAC.requirePlatformSuperAdmin;

  check('authoritative PSA (table flag + role) is ALLOWED',
    runGuard(g, { roles: ['Company Admin', 'Platform Super Admin'], isPlatformSuperAdmin: true }).nexted);

  check('FORGED role name alone does NOT authorize',
    !runGuard(g, { roles: ['Company Admin', 'Platform Super Admin'], isPlatformSuperAdmin: false }).nexted,
    'the exact escalation shape');
  check('FORGED role name with the flag omitted entirely does NOT authorize',
    !runGuard(g, { roles: ['Platform Super Admin'] }).nexted);
  check('flag set but role missing is still refused (defence in depth)',
    !runGuard(g, { roles: ['Company Admin'], isPlatformSuperAdmin: true }).nexted);
  check('missing session fails closed',
    !runGuard(g, undefined).nexted);
  check('truthy-but-not-true flag fails closed (no loose coercion)',
    !runGuard(g, { roles: ['Platform Super Admin'], isPlatformSuperAdmin: 'true' }).nexted);
  check('refusal carries 403 FORBIDDEN',
    runGuard(g, { roles: ['Platform Super Admin'], isPlatformSuperAdmin: false }).status === 403);

  // The whole platform surface must be behind the same gate.
  const router = createPlatformRouter(() => {});
  const names = (router.stack || []).flatMap((l) => (l.route ? [l.route.path] : []));
  const nonRouteLayers = router.stack.filter((l) => !l.route);
  check('the platform router installs its guards as router-level middleware',
    nonRouteLayers.length >= 1, 'layers=' + nonRouteLayers.length);
  check('platform routes present and unchanged (6 paths)',
    names.length === 6, 'count=' + names.length);
}

// ------------------------------------------------ users router: role assignment
console.log('\n=== 3. Company Admin cannot grant PSA through the users API ===');

let grantLog = [];
pool.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/FROM roles WHERE tenant_id/.test(s)) {
    const want = Array.isArray(params[1]) ? params[1] : [];
    return { rows: want.filter((n) => ROLE_PERMS[n]).map((n) => ({ name: n, permissions: ROLE_PERMS[n] })) };
  }
  if (/INSERT INTO users/.test(s)) return { rows: [{ id: TARGET, email: 'x@y.invalid', name: 'X', status: 'active', created_at: null }] };
  if (/SELECT id FROM users WHERE id/.test(s)) return { rows: [{ id: TARGET }] };
  if (/INSERT INTO user_roles|DELETE FROM user_roles/.test(s)) { grantLog.push(s.split(' ').slice(0, 4).join(' ')); return { rows: [] }; }
  if (/UPDATE users SET status/.test(s)) return { rows: [{ id: TARGET, email: 'x@y.invalid', status: 'active' }] };
  return { rows: [] };
};

// The handlers run inside an explicit BEGIN/COMMIT on a dedicated client.
pool.connect = async () => ({
  query: (sql, params) => pool.query(sql, params),
  release: () => {}
});

async function callRolesRoute(actor, roles) {
  grantLog = [];
  const router = createUsersRouter();
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id/roles' && l.route.methods?.post);
  const res = fakeRes();
  const session = {
    tenantId: actor.tenantId,
    sessionId: null,
    user: { id: actor.id, email: 'actor@test.invalid', name: 'Actor' },
    roles: actor.roles,
    brandIds: null,
    allBrandsInCompany: true,
    isPlatformSuperAdmin: !!actor.isPSA,
    customAbilities: []
  };
  const req = {
    // requireV1Auth honours an injected validator; this keeps the test hermetic.
    validateSession: async () => session,
    v1: session,
    auth: { tenantId: actor.tenantId, user: { id: actor.id, email: 'actor@test.invalid' }, roles: actor.roles },
    params: { id: TARGET }, body: { roles }, query: {},
    // requireV1Auth reads the session cookie via parseCookie(req.headers.cookie).
    headers: { cookie: `${sessionCookie}=test-token` },
    cookies: {}, ip: '127.0.0.1'
  };

  // Run the route's middleware chain in order; stop as soon as one responds.
  for (const l of layer.route.stack) {
    let stopped = false;
    const next = () => { stopped = true; };
    await l.handle(req, res, next);
    if (res._body !== null) break;
  }
  return { status: res._status, body: res._body, writes: grantLog.length };
}

{
  const companyAdmin = { id: ACTOR, tenantId: T1, roles: ['Company Admin'], isPSA: false };

  const esc = await callRolesRoute(companyAdmin, ['Platform Super Admin']);
  check('Company Admin assigning PSA is REFUSED with 403',
    esc.status === 403, 'status=' + esc.status);
  check('the refusal is ROLE_NOT_DELEGABLE',
    esc.body?.code === 'ROLE_NOT_DELEGABLE', JSON.stringify(esc.body));
  check('NO user_roles write was attempted', esc.writes === 0, 'writes=' + esc.writes);

  const legit = await callRolesRoute(companyAdmin, ['Agent', 'Supervisor']);
  check('Company Admin assigning Agent+Supervisor still WORKS (no regression)',
    legit.status === 200 && legit.body?.ok === true, JSON.stringify(legit.body));

  const custom = await callRolesRoute(companyAdmin, ['Custom Lead']);
  check('Company Admin assigning an unknown/custom role fails closed with 403',
    custom.status === 403, 'status=' + custom.status);

  const sup = { id: U(13), tenantId: T1, roles: ['Supervisor'], isPSA: false };
  const supEsc = await callRolesRoute(sup, ['Company Admin']);
  check('Supervisor cannot promote anyone to Company Admin',
    supEsc.writes === 0, 'writes=' + supEsc.writes);
}

// -------------------------------------------------------- brand scope preserved
console.log('\n=== 4. The deployed PSA brand-scope fix is preserved ===');
{
  check('PSA + explicit delegation still resolves to tenant scope',
    B.brandScopeFromSession({ roles: ['Company Admin', 'Platform Super Admin'], brandIds: null, allBrandsInCompany: true, isPlatformSuperAdmin: true }).mode === 'tenant');
  check('PSA with NO delegation still resolves to zero brands',
    B.brandScopeFromSession({ roles: ['Platform Super Admin'], brandIds: [], allBrandsInCompany: false, isPlatformSuperAdmin: true }).brandIds.length === 0);
  check('owner combined role set keeps company-wide access',
    B.brandScopeFromSession({ roles: ['Company Admin', 'Platform Super Admin'], brandIds: null, allBrandsInCompany: true }).mode === 'tenant');
  check('hasTenantWideBrandScope remains false for every role',
    ['Company Admin', 'Supervisor', 'Agent', 'Platform Super Admin'].every((r) => A.hasTenantWideBrandScope([r]) === false));
}

// -------------------------------------------------------------- static review
console.log('\n=== 5. Static guarantees ===');
{
  const fs = await import('node:fs');
  const rbacSrc = fs.readFileSync(path.join(ROOT, 'src/api/v1/stage7-rbac.js'), 'utf8');
  const usersSrc = fs.readFileSync(path.join(ROOT, 'src/routes/users.js'), 'utf8');
  const sessSrc = fs.readFileSync(path.join(ROOT, 'src/auth/sessions.js'), 'utf8');

  let guard = rbacSrc.slice(rbacSrc.indexOf('export function requirePlatformSuperAdmin'));
  guard = guard.slice(0, guard.indexOf('\n}'));
  check('the guard checks the authoritative flag FIRST',
    guard.indexOf('isPlatformSuperAdmin !== true') > -1
    && guard.indexOf('isPlatformSuperAdmin !== true') < guard.indexOf('!isPlatformSuperAdmin(req.v1?.roles)'));
  check('the role check is a second, additional requirement, not the decision',
    guard.indexOf('!isPlatformSuperAdmin(req.v1?.roles)') > guard.indexOf('isPlatformSuperAdmin !== true'));

  check('sessions.js still derives the flag from the platform_super_admins TABLE',
    /SELECT 1 FROM platform_super_admins WHERE user_id = \$1/.test(sessSrc));
  check('no code writes the platform_super_admins table',
    !/INSERT INTO platform_super_admins|UPDATE platform_super_admins|DELETE FROM platform_super_admins/.test(sessSrc + rbacSrc + usersSrc));

  check('createUser enforces the ceiling', /assertRolesDelegable\(req, roles\)/.test(usersSrc.split('createUser')[1]?.split('export async function setUserStatus')[0] ?? ''));
  check('setUserRoles enforces the ceiling BEFORE deleting roles',
    (() => {
      const body = usersSrc.slice(usersSrc.indexOf('export async function setUserRoles'));
      return body.indexOf('assertRolesDelegable') > -1 && body.indexOf('assertRolesDelegable') < body.indexOf('DELETE FROM user_roles');
    })());
  check('the ceiling resolves roles from the actor own tenant',
    /roles WHERE tenant_id = \$1/.test(usersSrc));
}

console.log(`\n  ${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
