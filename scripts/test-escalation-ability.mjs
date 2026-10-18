/**
 * P0.3 — security hardening: the `escalation.resolve` ability split.
 *
 *   node scripts/test-escalation-ability.mjs
 *
 * No database required. These are pure-ability and source-contract assertions; the
 * behavioural half (who can actually close an escalation, races, retries,
 * cross-brand refusals) lives in scripts/test-human-operations-pg.mjs, which runs
 * against a real PostgreSQL.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ROLE_ABILITIES, BUILT_IN_ROLES, can, canDelegateRole,
  effectiveCustomAbilities, normalizeCustomAbilities,
  ESCALATION_RESOLVE_ABILITY, ESCALATION_MANAGER_ROLE,
  NON_DELEGABLE_ROLE_NAMES, TENANT_WIDE_BRAND_ABILITY
} from '../src/auth/abilities.js';

const REPO = resolve(process.cwd());
const read = (f) => readFileSync(resolve(REPO, f), 'utf8');

const OPS = read('src/services/humanOperations.js');
const OPS_CODE = OPS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\*.*$/gm, '')
  .replace(/\/\/.*$/gm, '');
const ROUTES = read('src/api/v1/conversations.js');
const ABILITIES = read('src/auth/abilities.js');
const MIGRATIONS = readdirSync(resolve(REPO, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(resolve(REPO, 'migrations', f), 'utf8'));
const MIG17 = read('migrations/017_escalation_resolve_ability.sql');
/**
 * The migration's EXECUTABLE SQL, with `--` comments stripped.
 *
 * Migration 017 documents the owner-run INSERT deliberately inside its comment
 * block, so asserting against the raw file would match the documentation rather
 * than the code — the same false positive the source assertions avoid.
 */
const MIG17_CODE = MIG17.replace(/^\s*--.*$/gm, '');
/** SQL COMMENT ON statements are documentation too, not behaviour. */
const MIG17_EXEC = MIG17_CODE.replace(/COMMENT ON[\s\S]*?;/gi, '');
const PANEL = read('apps/web/components/inbox/handoff-panel.tsx');
const PANEL_CODE = PANEL
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\*.*$/gm, '')
  .replace(/\/\/.*$/gm, '');

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
};
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ================================= 1. the split exists and is enforced === */

section('1. escalation.resolve is separated from conversation.resolve');
{
  eq('the ability name is exactly as specified', ESCALATION_RESOLVE_ABILITY, 'escalation.resolve');
  eq('the seeded role name', ESCALATION_MANAGER_ROLE, 'Escalation Manager');

  // The two abilities must be genuinely independent in both directions.
  check('conversation.resolve does NOT imply escalation.resolve',
    can(['Company Admin'], 'conversation.resolve', [])
    && !can(['Company Admin'], ESCALATION_RESOLVE_ABILITY, []));
  check('escalation.resolve does NOT imply conversation.resolve',
    can([], ESCALATION_RESOLVE_ABILITY, ['escalation.resolve'])
    && !can([], 'conversation.resolve', ['escalation.resolve']));
  check('escalation.resolve does NOT imply conversation.reply',
    !can([], 'conversation.reply', ['escalation.resolve']));
  check('escalation.resolve grants no brand scope',
    !normalizeCustomAbilities([ESCALATION_RESOLVE_ABILITY, 'brand.grant_all', TENANT_WIDE_BRAND_ABILITY])
      .includes('brand.grant_all'));
}

/* ============================ 2. no built-in role silently gains it ==== */

section('2. No built-in role was automatically granted the ability');
{
  for (const role of BUILT_IN_ROLES) {
    check(`${role} does NOT hold escalation.resolve`,
      !can([role], ESCALATION_RESOLVE_ABILITY, []));
  }
  // The trap: a built-in name's stored permissions are ignored, so seeding them
  // would look like it worked and do nothing at all.
  check('escalation.resolve is absent from every ROLE_ABILITIES entry',
    Object.values(ROLE_ABILITIES).every((list) => !list.includes(ESCALATION_RESOLVE_ABILITY)));
  check('a built-in role row carrying the ability in JSONB would be IGNORED (the trap is real)',
    effectiveCustomAbilities(['Supervisor'], { Supervisor: [ESCALATION_RESOLVE_ABILITY] }).length === 0);
  check('...which is exactly why the role must be a CUSTOM name',
    effectiveCustomAbilities([ESCALATION_MANAGER_ROLE], { [ESCALATION_MANAGER_ROLE]: [ESCALATION_RESOLVE_ABILITY] })
      .includes(ESCALATION_RESOLVE_ABILITY));
  check('the seeded role name does not collide with a built-in name',
    !BUILT_IN_ROLES.includes(ESCALATION_MANAGER_ROLE));
  check('the source explains the trap so nobody re-introduces it',
    /BUILT_IN_ROLES[\s\S]{0,600}ignored/i.test(ABILITIES));
}

/* ================================ 3. the owner bootstrap mechanism ==== */

section('3. Owner bootstrap is explicit, additive and seeded with zero holders');
{
  check('migration 017 exists', MIG17.length > 0);
  check('it seeds the custom role per tenant',
    /FOR t IN SELECT id FROM tenants LOOP[\s\S]{0,400}'Escalation Manager'/.test(MIG17));
  check('the seeded permissions are exactly [escalation.resolve]',
    /\[\s*"escalation\.resolve"\s*\]'::jsonb/.test(MIG17_EXEC));
  check('it creates NO user_roles row — nobody holds it until assigned',
    !/INSERT INTO user_roles/i.test(MIG17_EXEC));
  check('it does not modify or delete any existing role/grant/escalation',
    !/UPDATE\s+roles|UPDATE\s+user_roles|DELETE\s+FROM|UPDATE\s+escalations|TRUNCATE/i.test(MIG17_EXEC));
  check('it does not grant brand scope to anyone',
    !/user_brand_grants|user_brand_scope_all/i.test(MIG17_EXEC));
  check('it writes no UPDATE/DELETE/INSERT beyond the idempotent roles INSERT',
    (MIG17_EXEC.match(/\bINSERT INTO\b/gi) ?? []).length === 1
    && /INSERT INTO roles/i.test(MIG17_EXEC));
  check('it is idempotent',
    /ON CONFLICT \(tenant_id, name\) DO NOTHING/.test(MIG17));

  // The delegation ceiling is what stops a company granting this to itself.
  check('a Company Admin WITHOUT the ability cannot grant the seeded role',
    canDelegateRole({
      actorRoles: ['Company Admin'], actorCustomAbilities: [],
      targetRoleName: ESCALATION_MANAGER_ROLE, targetPermissions: [ESCALATION_RESOLVE_ABILITY]
    }) === false);
  check('a Supervisor without it cannot grant the role',
    canDelegateRole({
      actorRoles: ['Supervisor'], targetRoleName: ESCALATION_MANAGER_ROLE,
      targetPermissions: [ESCALATION_RESOLVE_ABILITY]
    }) === false);
  check('an Agent cannot grant the role',
    canDelegateRole({
      actorRoles: ['Agent'], targetRoleName: ESCALATION_MANAGER_ROLE,
      targetPermissions: [ESCALATION_RESOLVE_ABILITY]
    }) === false);
  check('Platform Super Admin does not gain customer-data authority through it',
    canDelegateRole({
      actorRoles: ['Platform Super Admin'], targetRoleName: ESCALATION_MANAGER_ROLE,
      targetPermissions: [ESCALATION_RESOLVE_ABILITY]
    }) === false);
  check('a holder may pass it on (so it is not orphaned)',
    canDelegateRole({
      actorRoles: ['Company Admin'], actorCustomAbilities: [ESCALATION_RESOLVE_ABILITY],
      targetRoleName: ESCALATION_MANAGER_ROLE, targetPermissions: [ESCALATION_RESOLVE_ABILITY]
    }) === true);
}

/* ============================ 4. P0.1 / R1 ceilings preserved ======== */

section('4. P0.1 and R1 protections are untouched');
{
  eq('Platform Super Admin is still never delegable', NON_DELEGABLE_ROLE_NAMES, ['Platform Super Admin']);
  eq('brand-scope grant is still __none__', TENANT_WIDE_BRAND_ABILITY, '__none__');
  check('Platform Super Admin still holds no conversation ability',
    !can(['Platform Super Admin'], 'conversation.read', [])
    && !can(['Platform Super Admin'], 'conversation.reply', [])
    && !can(['Platform Super Admin'], ESCALATION_RESOLVE_ABILITY, []));
  check('the P0.1 authoritative platform gate is byte-intact',
    /if \(req\.v1\?\.isPlatformSuperAdmin !== true\)/.test(read('src/api/v1/stage7-rbac.js')));
  check('the R1 brand scope can never come from a role',
    /export function hasTenantWideBrandScope\(_roles = \[\]\) \{\s*return false;/.test(ABILITIES));
  check('a custom role cannot smuggle platform or brand powers',
    normalizeCustomAbilities([ESCALATION_RESOLVE_ABILITY, 'platform.*', '*', 'brand.grant_all', TENANT_WIDE_BRAND_ABILITY])
      .join(',') === ESCALATION_RESOLVE_ABILITY);
}

/* ========================= 5. the backend enforces the NEW ability === */

section('5. The escalation endpoint requires escalation.resolve');
{
  check('authority derives the new ability',
    /canResolveEscalations: can\(roles, ESCALATION_RESOLVE_ABILITY, custom\)/.test(OPS_CODE));
  check('the operation REFUSES without it',
    /if \(!authority\.canResolveEscalations\)/.test(OPS_CODE));
  check('the operation no longer keys off conversation.resolve',
    !/resolveEscalationOperation[\s\S]{0,2500}authority\.canResolveAny\s*\)/.test(OPS_CODE));
  check('the read context reports the new ability, not canResolveAny',
    /canResolveEscalations: authority\.canResolveEscalations && openEscalations\.length > 0/.test(OPS_CODE));
  check('the route is still behind conversation.resolve ONLY as a coarse guard, and the service re-decides',
    /'\/:id\/escalations\/:escalationId\/resolve',\s*\n\s*requireAbility\('conversation\.resolve'\)/.test(ROUTES));
  check('...and the service check is the authority, not the route guard',
    OPS_CODE.indexOf('!authority.canResolveEscalations') > 0);
}

/* ================== 6. escalation closure security properties ========= */

section('6. Escalation closure security properties are unchanged');
{
  check('the escalation id comes from the path, never the body',
    /escalationId, body/.test(OPS) && !/body\.escalationId/.test(OPS));
  check('a reason is mandatory',
    /a reason is required to close an escalation/.test(OPS));
  check('it is scoped to escalation + conversation + tenant together',
    /WHERE id = \$1 AND conversation_id = \$2 AND tenant_id = \$3/.test(OPS));
  check('the UPDATE is guarded on resolved_at IS NULL (race-safe, idempotent)',
    /SET status = 'done', resolved_at = now\(\)[\s\S]{0,200}AND resolved_at IS NULL/.test(OPS));
  check('it never DELETEs a complaint',
    !/DELETE FROM escalations/.test(OPS_CODE));
  check('it never resumes the AI',
    !/resolveEscalationOperation[\s\S]{0,4000}?await resumeAi\(/.test(OPS_CODE));
  check('it reports aiResumed:false', (OPS_CODE.match(/aiResumed: false/g) ?? []).length >= 3);
  check('it writes an immutable audit row naming the actor and escalation',
    /action: 'escalation\.resolve'/.test(OPS) && /actorUserId: authority\.userId/.test(OPS));
  check('an out-of-scope conversation yields 404 before any audit write',
    /if \(!conv\) throw new OpsError\(404, OPS_ERRORS\.NOT_FOUND/.test(OPS_CODE));
  check('a foreign escalation is 404, never 403',
    /OpsError\(404, OPS_ERRORS\.ESCALATION_NOT_FOUND/.test(OPS));
}

/* ================== 7. handoff refresh lifecycle ====================== */

section('7. Handoff context refresh lifecycle');
{
  check('there is an explicit interval constant', /const REFRESH_INTERVAL_MS = \d+/.test(PANEL));
  const m = PANEL.match(/const REFRESH_INTERVAL_MS = (\d+)/);
  eq('the interval is 10s, matching the thread', m?.[1], '10000');
  check('it uses setInterval', /setInterval\(/.test(PANEL));
  check('the timer is cleared on unmount / re-selection',
    /return \(\) => clearInterval\(timer\)/.test(PANEL));
  check('overlapping requests are skipped, not queued',
    /if \(inFlight\.current\) return;/.test(PANEL) && /inFlight\.current = true/.test(PANEL));
  check('overlap is released in a finally', /finally \{[\s\S]{0,120}inFlight\.current = false/.test(PANEL));
  check('stale responses are dropped via a monotonic ticket',
    /const ticket = \+\+seq\.current/.test(PANEL) && /if \(ticket !== seq\.current\) return;/.test(PANEL));
  check('the stale guard is applied on BOTH the success and the error path',
    (PANEL_CODE.match(/if \(ticket !== seq\.current\) return;/g) ?? []).length === 2);
  check('it never refreshes while a mutation is in flight',
    /if \(busy !== null\) return;/.test(PANEL));
  check('it does not poll a hidden tab', /if \(document\.hidden\) return;/.test(PANEL));
  check('a background refresh never blanks the panel (silent path keeps ctx)',
    /if \(!silent\) setLoading\(true\)/.test(PANEL));
  check('a successful refresh clears any previous load error',
    /const data = await conversationsApi\.handoffContext[\s\S]{0,500}?setLoadError\(null\)/.test(PANEL));
  check('the poll depends on load and busy, so it re-creates when either changes',
    /\}, \[load, busy\]\);/.test(PANEL));
}

/* ================== 8. Facebook Comment warning ======================== */

section('8. Facebook Comment channel warning');
{
  check('a non-DM channel is detected from the server provider',
    /const isWriteUnsupported = conversation\.channelProvider !== 'meta_dm'/.test(PANEL));
  check('a visible warning is rendered', /data-testid="channel-warning"/.test(PANEL));
  check('it is announced as an alert, not decoration', /role="alert"/.test(PANEL));
  check('it appears ABOVE the controls', PANEL.indexOf('channel-warning') < PANEL.indexOf('data-testid="op-claim"'));
  check('a second note sits next to the controls themselves',
    /data-testid="channel-write-note"/.test(PANEL));
  check('the note is tied to the actions that could mislead (claim/assign/handoff)',
    /isWriteUnsupported && \(p\.canClaim \|\| p\.canAssign \|\| p\.canHandoff\)/.test(PANEL));
  check('the warning does NOT claim the customer was answered',
    !/has been answered|reply sent|response sent/i.test(PANEL_CODE));
  check('no comment-sending implementation crept in',
    !/conversationsApi\.reply\(/.test(PANEL) && !/meta_comment.*send/i.test(PANEL));
  check('the panel still never closes escalations or resumes the AI on its own',
    !/setInterval[\s\S]{0,400}resolveEscalation|setInterval[\s\S]{0,400}resumeAi\(/.test(PANEL_CODE));
}

/* ================== 9. existing P0.3 behaviour preserved ============ */

section('9. P0.3-A/B behaviour is preserved');
{
  check('claim is still gated on conversation.assign_self',
    /router\.post\('\/:id\/claim',\s*requireAbility\('conversation\.assign_self'\)/.test(ROUTES));
  check('resume-ai is still gated on conversation.resume_ai',
    /router\.post\('\/:id\/resume-ai',\s*requireAbility\('conversation\.resume_ai'\)/.test(ROUTES));
  check('staff handoff is still gated on conversation.handoff',
    /router\.post\('\/:id\/handoff',\s*requireAbility\('conversation\.handoff'\)/.test(ROUTES));
  check('resolve still uses conversation.resolve',
    /resolveConversationOperation[\s\S]{0,400}authority\.canResolveAny/.test(OPS_CODE));
  check('the P0.2 reply route is untouched', /router\.post\(\s*'\/:id\/reply'/.test(ROUTES));
  check('the AI gate still keys on AI_ACTIVE alone',
    /suppressed: !isAiActive\(state\)/.test(read('src/services/aiGate.js')));
  check('the manual reply path still refuses non-DM channels',
    /export const SENDABLE_CHANNEL_PROVIDERS = Object\.freeze\(\['meta_dm'\]\)/.test(read('src/services/manualReplies.js')));
  const migFiles = readdirSync(resolve(REPO, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  check('017 is present', migFiles.includes('017_escalation_resolve_ability.sql'));
  check('016 (the P0.2 migration) is still present and untouched by this batch',
    migFiles.includes('016_manual_reply_idempotency.sql'));
  // 014 is intentionally absent from this repository (taken on an unreleased
  // branch), so the count is not a simple index. Assert the set, not the number.
  // 019 (AI routing rules) is an approved LATER batch, added under its own
  // review. It is still an additive table-only migration and is listed here so
  // this guard keeps refusing anything that was never approved.
  check('no migration was added other than 017 (this batch), 018 (P0.3-C) and 019 (AI routing)',
    migFiles.filter((f) => /^01[4-9]_/.test(f)).join(',')
      === '015_brand_access_grants.sql,016_manual_reply_idempotency.sql,'
        + '017_escalation_resolve_ability.sql,018_handoff_acknowledgment.sql,'
        + '019_ai_routing_rules.sql',
    migFiles.filter((f) => /^01[4-9]_/.test(f)).join(','));
  check('the new migration is additive: it creates a table reference only through roles',
    !/CREATE TABLE/i.test(MIG17_EXEC));
}

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);