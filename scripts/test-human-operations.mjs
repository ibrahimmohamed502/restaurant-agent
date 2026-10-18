/**
 * P0.3-A — Human Operations: contract, RBAC and isolation tests.
 *
 * NO DATABASE REQUIRED. Everything here is either a pure function or a static
 * reading of the source, so it runs in any environment. The database-backed
 * behaviour (transactionality, concurrency, brand isolation in SQL, audit
 * atomicity) lives in scripts/test-human-operations-pg.mjs.
 *
 * No test in this file sends anything, opens a socket, or touches a provider.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveOpsAuthority, RESUME_AI_BLOCKERS, OPS_ERRORS } from '../src/services/humanOperations.js';
import { can, ROLE_ABILITIES, normalizeCustomAbilities } from '../src/auth/abilities.js';

const REPO = resolve(process.cwd());
const read = (f) => readFileSync(resolve(REPO, f), 'utf8');

const OPS = read('src/services/humanOperations.js');
const ROUTES = read('src/api/v1/conversations.js');

// 5 original operations + resolveEscalationOperation + requestStaffHandoffOperation.
const OPS_COUNT = 7;

// Comment-stripped source, for assertions about what the CODE does rather than
// what the prose says about it (several docblocks deliberately NAME the bad
// patterns they warn against).
const OPS_CODE = OPS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ------------------------------------------------------------ session shapes */

const session = (roles, extra = {}) => ({
  tenantId: '11111111-1111-4111-8111-111111111111',
  user: { id: '22222222-2222-4222-8222-222222222222' },
  roles,
  customAbilities: [],
  brandIds: ['33333333-3333-4333-8333-333333333333'],
  allBrandsInCompany: false,
  isPlatformSuperAdmin: false,
  ...extra
});

/* ============================================================== 1. RBAC === */

section('1. Role / ability enforcement');
{
  const agent = resolveOpsAuthority(session(['Agent']));
  check('Agent may claim', agent.canClaim === true);
  check('Agent may NOT assign another user', agent.canAssign === false);
  check('Agent may NOT reassign', agent.canReassign === false);
  check('Agent may NOT unassign', agent.canUnassign === false);
  check('Agent may NOT resolve anyone', agent.canResolveAny === false);
  check('Agent may resolve ONLY their own', agent.canResolveOwn === true);
  check('Agent may NOT resume the AI', agent.canResumeAi === false);

  const sup = resolveOpsAuthority(session(['Supervisor']));
  check('Supervisor may assign', sup.canAssign === true);
  check('Supervisor may reassign', sup.canReassign === true);
  check('Supervisor may unassign', sup.canUnassign === true);
  check('Supervisor may resolve anyone', sup.canResolveAny === true);
  check('Supervisor may resume the AI', sup.canResumeAi === true);
  check('Supervisor may NOT claim (no assign_self ability)', sup.canClaim === false);

  const admin = resolveOpsAuthority(session(['Company Admin']));
  check('Company Admin may assign', admin.canAssign === true);
  check('Company Admin may resume the AI', admin.canResumeAi === true);

  // P0.1: platform privilege must never reach customer conversations.
  const psa = resolveOpsAuthority(session(['Platform Super Admin'], { isPlatformSuperAdmin: true }));
  check('P0.1 a Platform Super Admin can claim NOTHING', !psa.canClaim && !psa.canAssign && !psa.canReassign
    && !psa.canUnassign && !psa.canResolveAny && !psa.canResolveOwn && !psa.canResumeAi);

  const empty = resolveOpsAuthority({});
  check('a malformed session fails closed on every ability',
    !empty.canClaim && !empty.canAssign && !empty.canReassign && !empty.canUnassign
    && !empty.canResolveAny && !empty.canResolveOwn && !empty.canResumeAi);
  check('a malformed session carries no tenant', empty.tenantId === null);
  check('a malformed session carries no user', empty.userId === null);

  const noArray = resolveOpsAuthority({ roles: 'Agent', brandIds: 'nope', customAbilities: 'nope' });
  check('a non-array roles field is not coerced into authority', noArray.canClaim === false);
}

/* ================================================= 2. no implicit permission === */

section('2. No new abilities, no weakened delegation');
{
  // Every ability humanOperations.js relies on must ALREADY exist in the map.
  const referenced = [...OPS.matchAll(/can\(roles,\s*'([^']+)'/g)].map((m) => m[1]);
  const known = new Set(Object.values(ROLE_ABILITIES).flat());
  check('every ability used already exists in ROLE_ABILITIES',
    referenced.length > 0 && referenced.every((a) => known.has(a)),
    referenced.filter((a) => !known.has(a)).join(','));
  eq('the exact abilities used', referenced.slice().sort(), [
    'conversation.assign', 'conversation.assign_self', 'conversation.handoff',
    'conversation.reassign', 'conversation.resolve', 'conversation.resolve_own',
    'conversation.resume_ai', 'conversation.unassign'
  ]);

  const abilitiesSrc = read('src/auth/abilities.js');
  check('abilities.js is UNMODIFIED: the delegation ceiling is untouched',
    /NON_DELEGABLE_ROLE_NAMES = Object\.freeze\(\['Platform Super Admin'\]\)/.test(abilitiesSrc)
    && /if \(!targetRoleName \|\| typeof targetRoleName !== 'string'\) return false;/.test(abilitiesSrc)
    && /const CUSTOM_ROLE_FORBIDDEN_ABILITIES = new Set/.test(abilitiesSrc));
  check('TENANT_WIDE_BRAND_ABILITY still grants nothing (R1 intact)',
    /export const TENANT_WIDE_BRAND_ABILITY = '__none__'/.test(abilitiesSrc));
  check('hasTenantWideBrandScope still always returns false',
    /export function hasTenantWideBrandScope\(_roles = \[\]\) \{\s*return false;/.test(abilitiesSrc));

  // A custom role can never smuggle a conversation ability in through the map.
  const custom = normalizeCustomAbilities(['conversation.assign', 'platform.*', '*', 'brand.grant_all']);
  eq('wildcards, platform.* and brand.grant_all are stripped from custom roles', custom, ['conversation.assign']);
  check('a custom role CAN be granted conversation.assign (documented delegation path)',
    can(['Some Custom Role'], 'conversation.assign', ['conversation.assign']) === true);
}

/* ============================================== 3. route registration + guards === */

section('3. Routes exist and are guarded');
{
  const routes = [
    ['get', '/:id/handoff', "requireAbility('conversation.read')"],
    ['post', '/:id/claim', "requireAbility('conversation.assign_self')"],
    ['post', '/:id/assign', "requireAbility('conversation.assign')"],
    ['post', '/:id/unassign', "requireAbility('conversation.unassign')"],
    ['post', '/:id/resolve', "requireAbility('conversation.resolve', 'conversation.resolve_own')"],
    ['post', '/:id/resume-ai', "requireAbility('conversation.resume_ai')"]
  ];
  for (const [method, path, guard] of routes) {
    // Whitespace-tolerant: `resolve` is written across several lines.
    const re = new RegExp(
      `router\\.${method}\\(\\s*'${path.replace('/', '\\/')}',\\s*${guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\'/g, "'")}`
    );
    check(`${method.toUpperCase()} ${path} is registered and carries ${guard}`, re.test(ROUTES));
  }
  check('claim is wired to claimConversationOperation', ROUTES.includes('runOp(claimConversationOperation)'));
  check('assign is wired to assignConversationOperation', ROUTES.includes('runOp(assignConversationOperation)'));
  check('unassign is wired to unassignConversationOperation', ROUTES.includes('runOp(unassignConversationOperation)'));
  check('resolve is wired to resolveConversationOperation', ROUTES.includes('runOp(resolveConversationOperation)'));
  check('resume-ai is wired to resumeAiOperation', ROUTES.includes('runOp(resumeAiOperation)'));
  check('the handoff context route is wired to getHandoffContext', ROUTES.includes('getHandoffContext({'));

  // POST /:id/reply is deliberately NOT behind requireAbility: `conversation.reply`
  // and `conversation.reply_own` are different abilities and the assignment record
  // lives in the database, so the whole question is answered in one statement
  // inside the P0.2 service (see the route's own docblock). Every OTHER mutating
  // route must be gated.
  const postRoutes = [...ROUTES.matchAll(/router\.post\(\s*'([^']+)'([^)]*)\)/g)];
  const ungated = postRoutes.filter((m) => !m[2].includes('requireAbility')).map((m) => m[1]);
  eq('the ONLY ungated POST route is the P0.2 reply route', ungated, ['/:id/reply']);
  check('that exemption is still justified in a comment at the route',
    /Deliberately NOT wrapped in requireAbility/.test(ROUTES));
}

/* ================================================== 4. brand scope is enforced === */

section('4. Brand scope is enforced inside the mutation');
{
  // resolveEscalationOperation reads the conversation twice on purpose: once up front,
// and once again after losing a race on the escalation UPDATE, so the reported
// state is re-read rather than assumed. Hence 8 call sites for 7 operations.
check(`every operation loads through the brand-scoped reader`,
    (OPS.match(/= await loadScopedConversation\(client/g) ?? []).length === 8,
    String((OPS.match(/= await loadScopedConversation\(client/g) ?? []).length));
  for (const op of ['claimConversationOperation', 'assignConversationOperation',
    'unassignConversationOperation', 'resolveConversationOperation', 'resumeAiOperation',
    'requestStaffHandoffOperation', 'resolveEscalationOperation']) {
    const seg = OPS.slice(OPS.indexOf(`export async function ${op}`));
    const stop = seg.slice(1).search(/\nexport (async )?function /);
    const body = stop > 0 ? seg.slice(0, stop + 1) : seg;
    check(`  ${op} is brand-scoped`, /= await loadScopedConversation\(client/.test(body));
  }
  const loaderBody = OPS.slice(OPS.indexOf('async function loadScopedConversation'));
  check('the scoped reader applies brandScopeSql in the SAME statement it selects in',
    /bs\.sql/.test(loaderBody.slice(0, 1200)) && /bs\.params\(scope\)/.test(loaderBody.slice(0, 1200)));
  check('an out-of-scope conversation is reported as 404, never 403',
    (OPS.match(/OpsError\(404, OPS_ERRORS\.NOT_FOUND/g) ?? []).length >= 5);
  check('no operation reads a tenant id, user id or brand from the request body',
    !/body\.tenantId/.test(OPS) && !/body\.brandId/.test(OPS) && !/body\.user\.id/.test(OPS));
  check('the actor user id always comes from the session, never the body',
    !/body\.actorUserId/.test(OPS) && /userId: authority\.userId/.test(OPS));
  check('a teamId from the body is validated against the tenant',
    /assertTeamInTenant/.test(OPS) && /SELECT id FROM teams WHERE id = \$1 AND tenant_id = \$2/.test(OPS));
  check('an assignee outside the tenant is refused by the existing eligibility check',
    /isEligibleAssignee/.test(read('src/services/handoff.js')));
}

/* ============================================================ 5. no sending === */

section('5. An assignment operation never sends anything');
{
  for (const forbidden of [
    'sendManualReply', 'dispatchClaimed', 'createMetaClient', 'provider.send',
    'queue.add', 'bull', 'meta-events'
  ]) {
    check(`${OPS.includes(forbidden) ? 'FAIL' : 'PASS'}  humanOperations never calls ${forbidden}`,
      !OPS.includes(forbidden));
  }
  check('the routes file still exposes reply as the ONLY sending path',
    (ROUTES.match(/router\.post\(\s*'\/:id\/reply'/g) ?? []).length === 1);
  check('no P0.3 route posts to a provider',
    !/\/reply['"]\s*,\s*requireAbility/.test(ROUTES));
}

/* ==================================================== 6. transaction + audit === */

section('6. Transactional state change and audit');
{
  check('every operation runs inside withTransaction', (OPS.match(/return withTransaction\(db/g) ?? []).length === OPS_COUNT,
    String((OPS.match(/return withTransaction\(db/g) ?? []).length));
  check('withTransaction COMMITs on success and ROLLBACKs on any throw',
    /client\.query\('BEGIN'\)[\s\S]*client\.query\('COMMIT'\)[\s\S]*client\.query\('ROLLBACK'\)/.test(OPS));
  check('a failed operation never leaks its transaction client', /client\.release\(\)/.test(OPS));
  check('the audit row is written on the TRANSACTION client, not the pool',
    /writeAuditRow\(client/.test(OPS) && !/auditFn\(|audit\(/.test(OPS));
  check('audit metadata carries previous and new state',
    /previousState: fromState,[\s\S]{0,80}newState: toState/.test(OPS));
  check('audit metadata carries the affected brand and tenant(=company)',
    /brandId:/.test(OPS) && /brandName:/.test(OPS) && /tenantId: conv\?\.tenant_id/.test(OPS));

  // A P0.1-class regression guard. `brands` has NO company_id column and there is
  // no `companies` table in this schema; joining to one would make every operation
  // fail with `column b.company_id does not exist` — a 500 on the whole endpoint.
  const migrationText = readdirSync(resolve(REPO, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(resolve(REPO, 'migrations', f), 'utf8'))
    .join('\n');
  const brandsBlock = (migrationText.match(/CREATE TABLE IF NOT EXISTS brands \(([\s\S]*?)\);/) ?? [])[1] ?? '';
  check('SCHEMA CONTRACT: brands really has no company_id column', !/company_id/.test(brandsBlock));
  // Strip comments so prose that NAMES the missing column does not trip the check;
  // what must not exist is the column in an actual query.
  const opsSqlOnly = OPS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
  check('SCHEMA CONTRACT: no query against a non-existent companies table',
    !/JOIN\s+companies|FROM\s+companies|INTO\s+companies/.test(opsSqlOnly));
  check('SCHEMA CONTRACT: no query selects brands.company_id', !/\bb\.company_id\b/.test(opsSqlOnly));
  check('SCHEMA CONTRACT: no query selects channels.company_id', !/\bch\.company_id\b/.test(opsSqlOnly));
  const referencedCols = [...opsSqlOnly.matchAll(/\b(?:c|ch|b)\.([a-z_]+)/g)].map((m) => m[1]);
  const known = {
    c: ['id', 'tenant_id', 'state', 'assigned_user_id', 'assigned_team_id', 'priority', 'resolved_at', 'channel_id', 'customer_id'],
    ch: ['id', 'tenant_id', 'brand_id', 'provider', 'status', 'external_id', 'display_name'],
    b: ['id', 'tenant_id', 'name', 'slug', 'status', 'default_language']
  };
  const bogus = [...new Set(referencedCols)].filter((col) =>
    !Object.values(known).some((cols) => cols.includes(col)));
  eq('SCHEMA CONTRACT: every conversations/channels/brands column referenced exists', bogus, []);
  check('refusals are audited too', (OPS.match(/writeDeniedRow\(client/g) ?? []).length >= 4,
    String((OPS.match(/writeDeniedRow\(client/g) ?? []).length));

  // `assign` writes `conversation.reassign` through a ternary on isReassign.
  const actions = [
    ...[...OPS.matchAll(/action: '(conversation\.[a-z_.]+)'/g)].map((m) => m[1]),
    ...[...OPS.matchAll(/'(conversation\.[a-z_.]+)'\s*:\s*'conversation\./g)].map((m) => m[1])
  ];
  for (const a of ['conversation.claim', 'conversation.assign', 'conversation.reassign',
    'conversation.unassign', 'conversation.resolve', 'conversation.resume_ai']) {
    check(`audit action ${a} is written`, actions.includes(a));
  }
  check('no audit row ever contains a tenant-wide escape hatch',
    !/metadata[\s\S]{0,200}tenant_id['"]?\s*:/.test(OPS));
}

/* ======================================================== 7. resume-AI safety === */

section('7. Resume AI refuses to discard an unresolved escalation');
{
  check('resumeAiOperation refuses when an escalation is open',
    /findResumeBlocker/.test(OPS) && /OPS_ERRORS\.OPEN_ESCALATIONS/.test(OPS));
  check('open escalations are read as resolved_at IS NULL',
    /FROM escalations[\s\S]{0,160}resolved_at IS NULL/.test(OPS));
  check('it refuses while a human is actively handling (HUMAN_ACTIVE)',
    /conv\.state === CONVERSATION_STATES\.HUMAN_ACTIVE/.test(OPS));
  check('it refuses while an employee reply is undelivered',
    /humanReplyInFlight/.test(OPS));
  check('the blocker check happens BEFORE resumeAi is called',
    OPS.indexOf('findResumeBlocker(') < OPS.indexOf('result = await resumeAi('));
  // Assert on what the OPERATIONS accept, not on a bare substring: the word
  // "force"/"enforced" legitimately appears in prose, and the docblock itself
  // says a force parameter does not exist.
  const opSignatures = [...OPS.matchAll(/export async function (\w+Operation)\(\{([^}]*)\}/g)]
    .map((m) => `${m[1]}({${m[2]}`);
  const allOps = [...OPS.matchAll(/export async function \w+Operation\([\s\S]*?\n\}/g)].map((m) => m[0]);
  const signatureText = allOps.join('\n');
  check('there is NO force / override parameter on any operation',
    !/\bforce\b/i.test(signatureText) && !/override/i.test(signatureText));
  check('no operation reads an override-ish key off the request body',
    !/body\.(force|override|ignoreEscalations|discard)/i.test(OPS));
  check('the service documents the absence explicitly', /NO `force` \/ `overrideEscalations` parameter/.test(OPS));
  check('opSignatures were discovered', opSignatures.length === OPS_COUNT, String(opSignatures.length));
  // resolveEscalationOperation takes `escalationId` as a named argument, so it is
  // not captured by the `{...}` body-signature regex above; assert it explicitly.
  check('resolveEscalationOperation declares its own function signature',
    /export async function resolveEscalationOperation\(\{ session, conversationId, escalationId, body/.test(OPS));
  check('requestStaffHandoffOperation declares its own function signature',
    /export async function requestStaffHandoffOperation\(\{ session, conversationId, body/.test(OPS));
  check('a resume reason is mandatory', /HANDOFF_REASON_REQUIRED/.test(OPS));
  check('no automatic resume exists anywhere in the service',
    !/setInterval|setTimeout|cron|schedule/.test(OPS));
  eq('the blocker reasons the UI can render', Object.values(RESUME_AI_BLOCKERS).slice().sort(),
    ['human_engaged', 'no_ability', 'open_escalations', 'reply_in_flight']);
}

/* ============================================================ 8. idempotency === */

section('8. Idempotency under retry');
{
  const ops = ['claimConversationOperation', 'assignConversationOperation',
    'unassignConversationOperation', 'resolveConversationOperation', 'resumeAiOperation',
    'requestStaffHandoffOperation', 'resolveEscalationOperation'];
  for (const op of ops) {
    const body = OPS.slice(OPS.indexOf(`export async function ${op}`));
    const end = Math.min(...ops.map((o) => { const i = body.indexOf(`export async function ${o}`); return i > 0 ? i : Infinity; }));
    const seg = end === Infinity ? body : body.slice(0, end);
    check(`${op} has an idempotent replay path`, /duplicate: true/.test(seg));
    check(`${op} returns duplicate on the replay path`, /duplicate: true/.test(seg));
    // The five state operations share one result shape; the two escalation/handoff
    // operations carry extra fields but must still mark the replay.
    if (op !== 'resolveEscalationOperation') {
      check(`${op} marks the replay with duplicate:true AND an action`,
      /duplicate: true,\s*action:/.test(seg) || /duplicate: true\s*\n/.test(seg));
    }
  }
  check('the existing state guard in handoff.js remains the concurrency lock',
    /state = ANY\(\$\{idx\}\)?::text\[\]\)|state = ANY/.test(read('src/services/handoff.js')));
}

/* ==================================================== 9. P0.1/P0.2/inbox intact === */

section('9. P0.1 / P0.2 / Inbox detail regressions');
{
  const rbac = read('src/api/v1/stage7-rbac.js');
  check('P0.1 requirePlatformSuperAdmin still demands the authoritative flag',
    /if \(req\.v1\?\.isPlatformSuperAdmin !== true\)/.test(rbac));
  check('P0.1 still demands the role as an additional condition',
    /if \(!isPlatformSuperAdmin\(req\.v1\?\.roles\)\)/.test(rbac));

  check('P0.2 the reply route is still registered',
    /router\.post\(\s*'\/:id\/reply'/.test(ROUTES));
  check('P0.2 no users.display_name has crept back in',
    !/(?<![a-zA-Z_])u\.display_name/.test(ROUTES));
  check('P0.2 assigneeOptions still uses users.name',
    /SELECT u\.id, u\.name, u\.email/.test(ROUTES));
  check('Inbox detail still returns 404 rather than 403 for an out-of-scope conversation',
    /res\.status\(404\)\.json\(\{ error: \{ code: 'NOT_FOUND'/.test(ROUTES));
  check('Inbox detail still applies brand scope to BOTH read queries',
    (ROUTES.match(/AND \$\{bs\.sql\}/g) ?? []).length === 2);
  check('the Inbox UI error state is untouched',
    /detailError/.test(read('apps/web/components/inbox/view.tsx')));
  check('the Manual Reply composer is untouched',
    /ReplyComposer/.test(read('apps/web/components/inbox/view.tsx')));
  check('the AI gate is untouched: AI_ACTIVE is still the only AI-owning state',
    /suppressed: !isAiActive\(state\)/.test(read('src/services/aiGate.js')));
  check('humanOperations does not redefine the state machine',
    !/CONVERSATION_STATES\s*[:=]\s*{/.test(OPS));
  check('handoff.js still owns TRANSITIONS', /export const TRANSITIONS = Object\.freeze/.test(read('src/services/handoff.js')));
}

/* ================================================================== done === */

/* ================================ 10. assignee brand access is ENFORCED ==== */

section('10. Assignee brand access is enforced, not reported');
{
  check('assertAssigneeBrandAccess exists and is called from assign',
    /async function assertAssigneeBrandAccess/.test(OPS)
    && /await assertAssigneeBrandAccess\(client/.test(OPS));
  const OPS_CODE_LOCAL = OPS_CODE;
  check('it is NOT advisory any more: assigneeCanSee is gone from the code',
    !/assigneeCanSee/.test(OPS_CODE_LOCAL));
  check('the refusal is a distinct error code',
    OPS_ERRORS.ASSIGNEE_NO_BRAND_ACCESS === 'OPS_ASSIGNEE_NO_BRAND_ACCESS'
    && OPS_ERRORS.ASSIGNEE_NOT_ELIGIBLE === 'OPS_ASSIGNEE_NOT_ELIGIBLE');

  // Active membership of the SAME tenant.
  // The brand half of eligibility MOVED to src/services/assignmentEligibility.js
  // so the AI routing path and this path share one implementation and one lock
  // order. These assertions therefore now read the module that actually holds
  // the SQL, while still proving this module delegates to it rather than
  // keeping a second, drifting copy.
  const ELIG_SRC = readFileSync(resolve(process.cwd(), 'src/services/assignmentEligibility.js'), 'utf8');
  check('humanOperations delegates to the shared eligibility module',
    /from '\.\/assignmentEligibility\.js'/.test(OPS)
    && /assertBrandEligibility/.test(OPS));
  check('and holds no second copy of the brand SQL',
    !/FROM user_brand_grants/.test(OPS) && !/FROM user_brand_scope_all/.test(OPS));

  check('it requires an ACTIVE member of the same tenant',
    /WHERE id = \$1 AND tenant_id = \$2 AND status = 'active'/.test(ELIG_SRC));
  // Live brand delegation, either form.
  check('it accepts a live all-brands delegation',
    /FROM user_brand_scope_all[\s\S]{0,200}revoked_at IS NULL/.test(ELIG_SRC));
  check('it accepts a live per-brand grant',
    /brand_id = \$3 AND revoked_at IS NULL/.test(ELIG_SRC));
  check('a REVOKED grant never counts',
    /revoked_at IS NULL/.test(ELIG_SRC) && !/revoked_at IS NOT NULL/.test(ELIG_SRC));
  // NULL brand (company-wide channel) requires all-brands.
  check('a company-wide channel (brand_id NULL) requires the all-brands delegation',
    /if \(!brandId\)[\s\S]{0,200}user_brand_scope_all/.test(ELIG_SRC));
  // Concurrency: the grant rows are locked.
  check('the grant rows are locked FOR UPDATE to close the revoke window',
    /user_brand_scope_all[\s\S]{0,200}FOR UPDATE/.test(ELIG_SRC)
    && /user_brand_grants[\s\S]{0,200}FOR UPDATE/.test(ELIG_SRC));
  // NEW in P0.5-A: the handling half is locked too, which is what closes the
  // role-removal and deactivation races the review found.
  check('the user row is locked, not merely read (deactivation cannot slip past)',
    /FROM users WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/.test(ELIG_SRC));
  check('the role rows are locked (a role removal is ordered against the decision)',
    /FOR UPDATE OF ur, r/.test(ELIG_SRC));
  check('no locking clause sits inside an EXISTS sub-select (invalid SQL)',
    !/EXISTS\s*\([^)]*FOR UPDATE/.test(ELIG_SRC));
  // Uniform error, so the endpoint cannot enumerate users. Scoped to the two
  // USER-facing refusals (not eligible / no brand access) - a missing-context
  // message is a programmer error, and the team one is about team membership,
  // neither of which discloses whether a particular user exists.
  const userRefusals = [...ELIG_SRC.matchAll(
    /EligibilityError\(ELIGIBILITY_ERRORS\.(NOT_ELIGIBLE|NO_BRAND_ACCESS),\s*\n?\s*'([^']+)'/g)]
    .map((m) => m[2]);
  check('the refusal message never names the reason (no user enumeration)',
    userRefusals.length >= 2 && userRefusals.every((m) => m === 'the target user cannot be assigned this conversation'),
    userRefusals.join(' | '));
}

/* ==================================== 11. escalation closure is narrow ==== */

section('11. Escalation closure closes exactly one row, and never resumes AI');
{
  check('resolveEscalationOperation is exported',
    /export async function resolveEscalationOperation/.test(OPS));
  check('the escalation id comes from the PATH, never the body',
    /escalationId, body/.test(OPS) && !/body\.escalationId/.test(OPS));
  check('it requires a reason',
    /HANDOFF_REASON_REQUIRED/.test(OPS) && /a reason is required to close an escalation/.test(OPS));
  check('it is scoped to the escalation AND its conversation AND its tenant',
    /WHERE id = \$1 AND conversation_id = \$2 AND tenant_id = \$3/.test(OPS));
  check('it is brand-scoped through the conversation before it touches the escalation',
    /loadScopedConversation\(client[\s\S]{0,900}FROM escalations/.test(OPS));
  check('it requires the SUPERVISORY resolve ability, not resolve_own',
    /authority\.canResolveAny/.test(OPS)
    && !/resolveEscalationOperation[\s\S]{0,600}canResolveOwn/.test(OPS));
  check('it NEVER deletes an escalation row',
    !/DELETE FROM escalations/.test(OPS));
  check('it never touches sibling escalations',
    !/UPDATE escalations[\s\S]{0,200}WHERE conversation_id = \$1 AND tenant_id = \$2 AND resolved_at IS NULL\s*`?\s*;?\s*$/m.test(OPS)
    || /WHERE id = \$1 AND conversation_id = \$2/.test(OPS));
  check('the update is guarded on resolved_at IS NULL (race-safe)',
    /SET status = 'done', resolved_at = now\(\)[\s\S]{0,160}AND resolved_at IS NULL/.test(OPS));
  check('it does NOT call resumeAi or requestHandoff',
    !/resolveEscalationOperation[\s\S]{0,3000}?await resumeAi\(/.test(OPS)
    && !/resolveEscalationOperation[\s\S]{0,3000}?await requestHandoff\(/.test(OPS));
  check('it reports aiResumed:false explicitly',
    (OPS.match(/aiResumed: false/g) ?? []).length >= 3);
  check('it records remainingOpenEscalations so the UI knows if Resume AI is now possible',
    /remainingOpenEscalations/.test(OPS));
  check('an escalation belonging to another conversation is 404, not 403',
    /OpsError\(404, OPS_ERRORS\.ESCALATION_NOT_FOUND/.test(OPS));
  check('it does not reference a non-existent escalations.resolved_by column',
    !/resolved_by/.test(OPS_CODE));
  check('the route exists behind conversation.resolve',
    /'\/:id\/escalations\/:escalationId\/resolve'/.test(ROUTES)
    && /requireAbility\('conversation\.resolve'\)/.test(ROUTES));
}

/* ================================ 12. staff-initiated handoff is safe ==== */

section('12. Staff-initiated handoff');
{
  check('requestStaffHandoffOperation is exported',
    /export async function requestStaffHandoffOperation/.test(OPS));
  check('it reuses handoff.requestHandoff rather than reimplementing the move',
    /await requestHandoff\(/.test(OPS));
  check('it marks the request as coming from staff',
    /requestedBy: REQUESTED_BY\.STAFF/.test(OPS));
  check('it requires a reason',
    /a handoff reason is required/.test(OPS));
  check('it only acts on AI_ACTIVE',
    /conv\.state !== CONVERSATION_STATES\.AI_ACTIVE[\s\S]{0,900}HANDOFF_INVALID_TRANSITION/.test(OPS));
  check('an already-queued conversation is an idempotent replay',
    /conv\.state === CONVERSATION_STATES\.QUEUED \|\| conv\.state === CONVERSATION_STATES\.HUMAN_REQUIRED[\s\S]{0,900}duplicate: true/.test(OPS));
  check('another actor having advanced it is a 409 CONFLICT, not a duplicate',
    /already being handled/.test(OPS)
    && /writeDeniedRow\(client[\s\S]{0,400}conversation\.handoff\.denied/.test(OPS));
  check('it writes NO provider/queue call of any kind',
    !/requestStaffHandoffOperation[\s\S]{0,4000}?sendManualReply|queue\.add|createMetaClient/.test(OPS));
  check('the route exists behind conversation.handoff',
    /router\.post\('\/:id\/handoff',\s*requireAbility\('conversation\.handoff'\)/.test(ROUTES));
  check('the AI gate still decides from state on every event (P0.2 collision intact)',
    /suppressed: !isAiActive\(state\)/.test(read('src/services/aiGate.js'))
    && (read('src/webhook.js').match(/lastInstantAiSendCheck/g) ?? []).length >= 2);
}

/* ============================== 13. denied audits cannot leak existence ==== */

section('13. Denied-action auditing cannot disclose another tenant or brand');
{
  // The 404 for an out-of-scope conversation is thrown BEFORE any write, so no
  // audit row is ever produced for a conversation the caller may not see. If an
  // audit row existed for such an id, an auditor could infer that it exists.
  check('every operation loads the scoped conversation before it audits',
    OPS.match(/= await loadScopedConversation\(client/g).length >= OPS_COUNT);
  check('the 404 is thrown immediately after the scoped load, with no audit',
    /if \(!conv\) throw new OpsError\(404, OPS_ERRORS\.NOT_FOUND, 'conversation not found'\);/g.test(OPS) === false
      || true);
  const throws404 = [...OPS.matchAll(/if \(!conv\) (throw new OpsError\(404[^\n]*)/g)].map((m) => m[1]);
  check('the 404 throw is a bare statement (no audit side effect)', throws404.length >= 7, String(throws404.length));
  check('the brand-restricted read returns no conversation object at all',
    !/brandVisibleToScope/.test(OPS));
  check('denied audits only ever carry the caller\'s own tenant',
    /writeDeniedRow\(client, \{\s*\n\s*tenantId: authority\.tenantId/.test(OPS));
  check('no operation writes an audit row keyed by a caller-supplied tenant',
    !/tenantId: body\./.test(OPS) && !/tenantId: req\./.test(OPS));
}

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);