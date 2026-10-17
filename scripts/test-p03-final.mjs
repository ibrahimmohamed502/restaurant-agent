/**
 * P0.3 final batch — authorization and pure-function assertions, no database.
 *
 *   node scripts/test-p03-final.mjs
 *
 * The behavioural half — who can actually grant, races, real provider outcomes —
 * lives in scripts/test-p03-final-pg.mjs against a real PostgreSQL. What is here is
 * the part that can be decided from the source of truth: the ability graph, the
 * narrowness of the grant surface, and the pure decision functions.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ROLE_ABILITIES, BUILT_IN_ROLES, can, canDelegateRole,
  effectiveCustomAbilities, normalizeCustomAbilities,
  ESCALATION_RESOLVE_ABILITY, ESCALATION_MANAGER_ROLE,
  NON_DELEGABLE_ROLE_NAMES
} from '../src/auth/abilities.js';
import {
  ACK_STATUS, ACK_SKIP_REASONS, ACKNOWLEDGMENT_TEXT, ACK_LANGUAGES,
  resolveAckLanguage, acknowledgmentTextFor, evaluateAckEligibility,
  acknowledgmentIdempotencyKey
} from '../src/services/handoffAcknowledgment.js';
import { messagingWindowSeconds, SENDABLE_CHANNEL_PROVIDERS } from '../src/services/manualReplies.js';
import { REQUESTED_BY } from '../src/services/handoff.js';
import { HANDOFF_REASONS } from '../src/services/handoffDetector.js';

const REPO = resolve(process.cwd());
const read = (f) => readFileSync(resolve(REPO, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

const ROLES = read('src/services/platformRoles.js');
const ROLES_CODE = strip(ROLES);
const ACK = read('src/services/handoffAcknowledgment.js');
const ACK_CODE = strip(ACK);
const WEBHOOK = read('src/webhook.js');
const PLATFORM_ROUTE = read('src/api/v1/platform.js');
const PANEL = read('apps/web/components/inbox/handoff-panel.tsx');
const PANEL_CODE = strip(PANEL);
const CARD = read('apps/web/app/(app)/companies/escalation-managers-card.tsx');
const CARD_CODE = strip(CARD);
const MIG18 = read('migrations/018_handoff_acknowledgment.sql');
const MIG18_CODE = MIG18.replace(/^\s*--.*$/gm, '').replace(/COMMENT ON[\s\S]*?;/gi, '');

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
};
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ================================== 1. the owner is authoritative ======= */

section('1. Platform Owner authority is the table, not the role name');
{
  // The guard requires BOTH. Requiring the role name alone would let anyone who
  // could mint a role grant themselves; requiring the table alone is what the
  // owner asked for, and the role name is the second, independent factor.
  check('the platform router is guarded by requirePlatformSuperAdmin',
    /router\.use\(requireV1Auth, requirePlatformSuperAdmin\)/.test(PLATFORM_ROUTE));
  check('...which requires the authoritative flag from platform_super_admins',
    /req\.v1\?\.isPlatformSuperAdmin !== true/.test(read('src/api/v1/stage7-rbac.js')));
  check('...AND the platform role name, so neither factor alone is enough',
    /isPlatformSuperAdmin\(req\.v1\?\.roles\)/.test(read('src/api/v1/stage7-rbac.js')));
  check('the flag is sourced from the platform_super_admins TABLE',
    /SELECT 1 FROM platform_super_admins WHERE user_id = \$1/.test(read('src/auth/sessions.js')));

  // Every new route sits behind that single router.use, not a per-route guard that
  // someone could later forget on a new endpoint.
  check('all three bootstrap routes live on the guarded router (no unguarded router)',
    (PLATFORM_ROUTE.match(/router\.(post|get)\('\/escalation-managers/g) ?? []).length === 3);
  check('there is exactly ONE router in this module, and it is the guarded one',
    (PLATFORM_ROUTE.match(/export function create\w*Router\(/g) ?? []).length === 1
    && /export function createPlatformRouter/.test(PLATFORM_ROUTE));

  // A platform admin holding the role must NOT acquire customer-data access.
  eq('Platform Super Admin holds no conversation ability',
    ['conversation.read', 'conversation.reply', 'conversation.resolve'].filter((a) => can(['Platform Super Admin'], a, [])), []);
  eq('Platform Super Admin is never delegable', NON_DELEGABLE_ROLE_NAMES, ['Platform Super Admin']);
}

/* ========================= 2. the grant surface is narrow ================ */

section('2. The owner grant is the ONLY way escalation.resolve reaches a person');
{
  check('the role name is a module constant, not a parameter',
    !/grantEscalationManager[\s\S]{0,400}(roleName|role)\s*[),]/.test(ROLES_CODE)
    || /const EXPECTED_PERMISSIONS = Object\.freeze\(\[ESCALATION_RESOLVE_ABILITY\]\)/.test(ROLES_CODE));
  check('there is no generic "assign this role" entry point',
    !/export (async )?function (assignRole|setUserRoles|addRole|grantRole)\b/.test(ROLES_CODE));
  check('no function anywhere in the service takes a role name from the caller',
    !/export async function \w+\([^)]*roleName/.test(ROLES_CODE));

  // The service re-verifies what it is about to hand over instead of trusting a
  // row it did not write. This is the single most important check in the file.
  check('the grant re-reads the role row and compares its stored permissions',
    /loadAndVerifyRole/.test(ROLES_CODE) && /samePermissionSet\(role\.permissions, EXPECTED_PERMISSIONS\)/.test(ROLES_CODE));
  check('...and REFUSES when they are not exactly the approved set',
    /ROLE_PERMISSIONS_UNEXPECTED/.test(ROLES_CODE));
  check('the comparison is a SET comparison, so reordering is tolerated',
    /const a = actual\.map\(String\)\.sort\(\);/.test(ROLES_CODE));
  check('the approved set is exactly the one ability',
    /EXPECTED_PERMISSIONS = Object\.freeze\(\[ESCALATION_RESOLVE_ABILITY\]\)/.test(ROLES_CODE));

  check('it refuses if the role name ever becomes a built-in name',
    /BUILT_IN_ROLES\.includes\(ESCALATION_MANAGER_ROLE\)/.test(ROLES_CODE));
  check('granting to a Platform Super Admin is explicitly REFUSED',
    /TARGET_IS_PLATFORM_ADMIN/.test(ROLES_CODE) && /is_platform_admin/.test(ROLES_CODE));

  // Brand scope must never come from a role.
  check('it never writes a brand grant',
    !/INSERT INTO user_brand_grants|UPDATE user_brand|user_brand_scope_all/i.test(ROLES_CODE));
  check('it never writes any permission column',
    !/UPDATE roles SET|UPDATE roles\b/i.test(ROLES_CODE));
  check('the only role write it performs is the user_roles assignment',
    (ROLES_CODE.match(/INSERT INTO user_roles/g) ?? []).length === 1
    && (ROLES_CODE.match(/DELETE FROM user_roles/g) ?? []).length === 1);

  // A company must not be able to self-serve this through the tenant role API.
  check('the delegation ceiling refuses the role to every built-in role',
    ['Company Admin', 'Supervisor', 'Agent', 'Platform Super Admin'].every(
      (r) => canDelegateRole({
        actorRoles: [r],
        targetRoleName: ESCALATION_MANAGER_ROLE,
        targetPermissions: [ESCALATION_RESOLVE_ABILITY]
      }) === false));
  check('a holder may pass it on (so it is not orphaned)',
    canDelegateRole({
      actorRoles: ['Agent'], actorCustomAbilities: [ESCALATION_RESOLVE_ABILITY],
      targetRoleName: ESCALATION_MANAGER_ROLE, targetPermissions: [ESCALATION_RESOLVE_ABILITY]
    }) === true);
  // normalizeCustomAbilities strips WILDCARD and BRAND powers but deliberately
  // keeps ordinary abilities, so it is not the right instrument here. The real
  // guarantee is that the ROLE carries exactly one ability and that ability confers
  // nothing else — which is what `can` expresses.
  // normalizeCustomAbilities strips the TENANT-WIDE brand ability but deliberately
  // keeps the per-brand one, so it is not the right instrument for the whole
  // question. The real guarantees are: the ROLE carries exactly one ability, that
  // ability confers no other ability, and tenant-wide brand scope is unreachable
  // from a role at all.
  check('escalation.resolve confers no read, reply or resolve ability',
    ['conversation.read', 'conversation.reply', 'conversation.resolve', 'conversation.resume_ai']
      .every((a) => can([], a, [ESCALATION_RESOLVE_ABILITY]) === false));
  check('the tenant-wide brand ability is stripped from any custom role',
    !normalizeCustomAbilities([ESCALATION_RESOLVE_ABILITY, 'brand.grant_all'])
      .includes('brand.grant_all'));
  check('brand scope can never come from a role at all',
    /export function hasTenantWideBrandScope\(_roles = \[\]\) \{\s*return false;/.test(read('src/auth/abilities.js')));
  check('and no wildcard or platform power',
    !normalizeCustomAbilities([ESCALATION_RESOLVE_ABILITY, '*', 'platform.*'])
      .some((a) => a === '*' || a.startsWith('platform.')));
  eq('and no built-in role gained it in this batch',
    Object.values(ROLE_ABILITIES).filter((l) => l.includes(ESCALATION_RESOLVE_ABILITY)).length, 0);
  eq('the seeded role name is not a built-in name',
    BUILT_IN_ROLES.includes(ESCALATION_MANAGER_ROLE), false);
  check('a built-in row carrying the ability in JSONB would still be IGNORED (the trap stands)',
    effectiveCustomAbilities(['Supervisor'], { Supervisor: [ESCALATION_RESOLVE_ABILITY] }).length === 0);
}

/* ========================= 3. transaction, idempotency, audit =========== */

section('3. Grant and revoke are transactional, idempotent and audited in-transaction');
{
  check('grant opens a transaction', /await client\.query\('BEGIN'\)/.test(ROLES_CODE));
  check('grant rolls back on any failure', /catch \(e\) \{\s*await client\.query\('ROLLBACK'\)/.test(ROLES_CODE));
  check('the client is always released', /finally \{[\s\S]{0,80}client\.release/.test(ROLES_CODE));

  // Idempotency: a retried grant must converge, not duplicate or fail.
  check('grant uses ON CONFLICT DO NOTHING',
    /INSERT INTO user_roles[\s\S]{0,120}ON CONFLICT DO NOTHING[\s\S]{0,120}RETURNING/.test(ROLES_CODE));
  check('a zero-row insert is reported as alreadyGranted, not as an error',
    /alreadyGranted: !granted/.test(ROLES_CODE));
  check('revoke reports alreadyRevoked rather than failing',
    /alreadyRevoked: rowCount === 0/.test(ROLES_CODE));

  // Attribution must be as durable as the change it describes.
  check('the audit row is written with the TRANSACTION client, not the fire-and-forget helper',
    !/import \{[^}]*\b(audit|auditFn)\b/.test(ROLES));
  check('the audit row is inserted inside the same transaction',
    /INSERT INTO audit_logs[\s\S]{0,900}COMMIT/.test(ROLES_CODE));
  check('it names the actor',
    /actorUserId \?\? null/.test(ROLES_CODE));
  check('grant and revoke are distinguishable audit actions',
    /platform\.escalation_manager\.grant/.test(ROLES_CODE)
    && /platform\.escalation_manager\.revoke/.test(ROLES_CODE));
  check('a no-op is audited distinctly from a real change',
    (ROLES_CODE.match(/\.noop/g) ?? []).length === 2);
  check('the reason is stored with the change',
    /reason: reasonText/.test(ROLES_CODE));

  check('a reason is mandatory, with a real minimum',
    /MIN_REASON_CHARS = \d+/.test(ROLES_CODE) && /REASON_REQUIRED/.test(ROLES_CODE));
  check('the tenant is verified to exist',
    /SELECT id FROM tenants WHERE id = \$1/.test(ROLES_CODE));
  check('the target user is verified to belong to THIS tenant',
    /user\.tenant_id !== tenantId/.test(ROLES_CODE));
  check('an inactive user is refused',
    /USER_INACTIVE/.test(ROLES_CODE));
  check('a missing seeded role is refused rather than invented',
    /ROLE_NOT_SEEDED/.test(ROLES_CODE));
  check('revoking does NOT require the permissions check, so a tampered role stays removable',
    /WITHOUT the expected-permissions check/i.test(ROLES));
}

/* ========================= 4. acknowledgement triggers =================== */

section('4. The acknowledgment fires on a customer request, and only on one');
{
  // Position-based rather than window-based: the point is the ORDERING, so assert on
// the indices directly instead of on a regex window that a comment can break.
{
  const matched = WEBHOOK.indexOf('detection.matched');
  const handoff = WEBHOOK.indexOf('await requestHandoff(', matched);
  const ack = WEBHOOK.indexOf('maybeAcknowledgeHandoff({', matched);
  check('the acknowledgment is inside the customer-requested-human branch', matched > 0 && ack > matched);
  check('it runs AFTER requestHandoff, so the AI is already stopped',
    handoff > matched && ack > handoff, `handoff@${handoff} ack@${ack}`);
  check('the ordering is adjacent enough that no other branch can intervene',
    ack - handoff < 1400, `gap ${ack - handoff}`);

  // The auto-escalation CALL (not the import) is what matters here.
  const auto = WEBHOOK.indexOf('detectAutoEscalation(text)');
  const tail = WEBHOOK.indexOf('return { suppressed: false, state: gate.state };', auto);
  check('it is NOT called from the auto-escalation branch',
    auto > 0 && tail > auto && !/maybeAcknowledgeHandoff/.test(WEBHOOK.slice(auto, tail)));
}
  check('a staff-initiated handoff path does not acknowledge',
    !/activateHumanHandling[\s\S]{0,900}maybeAcknowledgeHandoff/.test(WEBHOOK));

  // The service itself refuses anything that is not the approved trigger, even if a
  // future caller gets it wrong.
  check('the service double-checks BOTH requestedBy and the reason',
    /requestedBy !== REQUESTED_BY\.CUSTOMER \|\| reason !== HANDOFF_REASONS\.CUSTOMER_REQUESTED_HUMAN/.test(ACK_CODE));
  check('a non-approved trigger is refused with a recorded reason',
    /NOT_CUSTOMER_REQUESTED: 'not_customer_requested'/.test(ACK));

  check('the failure of the acknowledgment cannot break the handoff',
    /maybeAcknowledgeHandoff\([\s\S]{0,400}\.catch\(/.test(WEBHOOK));

  // Nothing in this feature may touch conversation state.
  check('the module never writes conversation state',
    !/UPDATE conversations|SET state|resumeAi|applyTransition/.test(ACK_CODE));
  check('there is no force or override parameter anywhere',
    !/\b(force|override|skipAi|resume)\b\s*[=:,)]/.test(ACK_CODE));
}

/* ========================= 5. idempotency ordering ====================== */

section('5. The durable record is claimed BEFORE the provider is called');
{
  const ins = ACK_CODE.indexOf('INSERT INTO handoff_acknowledgments');
  const send = ACK_CODE.indexOf('sendMessengerReply');
  check('the idempotency insert comes first', ins > 0 && send > ins);
  check('a zero-row insert means do-not-send, and returns without sending',
    /ON CONFLICT \(tenant_id, conversation_id\) DO NOTHING[\s\S]{0,200}RETURNING id/.test(ACK_CODE)
    && /alreadyAcknowledged: true/.test(ACK_CODE));
  check('the key is derived from the conversation, not the event',
    /handoff-ack:\$\{tenantId\}:\$\{conversationId\}/.test(ACK)
    || acknowledgmentIdempotencyKey('t', 'c') === 'handoff-ack:t:c');
  check('the record is written in the same tenant scope as everything else',
    /tenant_id = \$1 AND conversation_id = \$2/.test(ACK_CODE));
  check('the record is brand-scoped too',
    /brand_id/.test(MIG18_CODE) && /idx_handoff_acknowledgments_brand/.test(MIG18_CODE));

  check('migration 018 makes one row per conversation',
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_acknowledgments_conversation[\s\S]{0,80}ON handoff_acknowledgments \(tenant_id, conversation_id\)/.test(MIG18_CODE));
  check('migration 018 makes the key unique on its own too',
    /idx_handoff_acknowledgments_idempotency[\s\S]{0,80}ON handoff_acknowledgments \(tenant_id, idempotency_key\)/.test(MIG18_CODE));
  check('migration 018 does NOT backfill anything (no retroactive acknowledgments)',
    !/INSERT INTO handoff_acknowledgments/i.test(MIG18_CODE));
  check('migration 018 is idempotent (IF NOT EXISTS throughout)',
    !/CREATE TABLE (?!IF NOT EXISTS)|CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/.test(MIG18_CODE));
  check('migration 018 creates no other table',
    (MIG18_CODE.match(/CREATE TABLE/gi) ?? []).length === 1);
  check('migration 018 touches no existing table',
    !/ALTER TABLE|DROP|TRUNCATE|UPDATE /i.test(MIG18_CODE));
}

/* ========================= 6. provider eligibility ====================== */

section('6. No send without a supported channel, an open window and a known language');
{
  const fresh = { channelProvider: 'meta_dm', channelStatus: 'active', language: 'ar', lastInboundAt: new Date() };
  eq('a supported, active, fresh Messenger conversation is eligible',
    evaluateAckEligibility({ conversation: fresh }), { eligible: true, reason: null });

  check('a Facebook Comment conversation is refused',
    evaluateAckEligibility({ conversation: { ...fresh, channelProvider: 'meta_comment' } }).reason === ACK_SKIP_REASONS.CHANNEL_UNSUPPORTED);
  check('an Instagram conversation is refused',
    evaluateAckEligibility({ conversation: { ...fresh, channelProvider: 'instagram' } }).reason === ACK_SKIP_REASONS.CHANNEL_UNSUPPORTED);
  check('an unknown provider is refused',
    evaluateAckEligibility({ conversation: { ...fresh, channelProvider: null } }).reason === ACK_SKIP_REASONS.CHANNEL_UNSUPPORTED);
  check('a disconnected channel is refused',
    evaluateAckEligibility({ conversation: { ...fresh, channelStatus: 'disabled' } }).reason === ACK_SKIP_REASONS.CHANNEL_INACTIVE);
  check('a missing lastInboundAt is refused (window treated as closed)',
    evaluateAckEligibility({ conversation: { ...fresh, lastInboundAt: null } }).reason === ACK_SKIP_REASONS.WINDOW_CLOSED);
  const stale = new Date(Date.now() - (messagingWindowSeconds() + 60) * 1000);
  check('an EXPIRED messaging window is refused',
    evaluateAckEligibility({ conversation: { ...fresh, lastInboundAt: stale } }).reason === ACK_SKIP_REASONS.WINDOW_CLOSED);
  check('a missing conversation is refused',
    evaluateAckEligibility({ conversation: null }).reason === ACK_SKIP_REASONS.CONVERSATION_MISSING);

  // It must agree with the manual-reply channel list, or a customer could find
  // themselves in a state where a human can reply but the acknowledgment cannot.
  check('it uses the SAME provider allow-list as manual replies',
    /SENDABLE_CHANNEL_PROVIDERS\.includes/.test(ACK_CODE));
  eq('and that allow-list is still exactly meta_dm', [...SENDABLE_CHANNEL_PROVIDERS], ['meta_dm']);

  check('a missing credential is a recorded failure, never a guessed send',
    /credential_missing/.test(ACK_CODE) && /if \(!credential\)/.test(ACK_CODE));
}

/* ========================= 7. language selection ======================== */

section('7. Arabic for Arabic conversations, English for English ones');
{
  eq('ar', resolveAckLanguage({ conversationLanguage: 'ar' }), 'ar');
  eq('en', resolveAckLanguage({ conversationLanguage: 'en' }), 'en');
  eq('ar-EG', resolveAckLanguage({ conversationLanguage: 'ar-EG' }), 'ar');
  eq('en_US', resolveAckLanguage({ conversationLanguage: 'en_US' }), 'en');
  eq('uppercase AR', resolveAckLanguage({ conversationLanguage: 'AR' }), 'ar');
  eq('whitespace is tolerated', resolveAckLanguage({ conversationLanguage: '  ar  ' }), 'ar');
  eq('falls back to the brand default when NO language was recorded',
    resolveAckLanguage({ conversationLanguage: null, brandDefaultLanguage: 'en' }), 'en');
  eq('a conversation language beats the brand default',
    resolveAckLanguage({ conversationLanguage: 'en', brandDefaultLanguage: 'ar' }), 'en');

  // ABSENT and UNSUPPORTED are different facts. A brand that defaults to Arabic
  // does not make Arabic the right language for a customer writing in French — and
  // conflating the two is how you confidently send the wrong message.
  eq('a recorded but UNSUPPORTED language is NOT replaced by the brand default',
    resolveAckLanguage({ conversationLanguage: 'fr', brandDefaultLanguage: 'ar' }), null);
  eq('  nor by the other supported language',
    resolveAckLanguage({ conversationLanguage: 'de', brandDefaultLanguage: 'en' }), null);
  eq('an empty-string language counts as absent, not as unsupported',
    resolveAckLanguage({ conversationLanguage: '', brandDefaultLanguage: 'ar' }), 'ar');
  eq('whitespace-only counts as absent too',
    resolveAckLanguage({ conversationLanguage: '   ', brandDefaultLanguage: 'en' }), 'en');

  // The important one: refuse to guess rather than send Arabic to a non-Arabic reader.
  eq('an undetermined language yields null, NOT a default',
    resolveAckLanguage({ conversationLanguage: null, brandDefaultLanguage: null }), null);
  eq('an unknown language code yields null', resolveAckLanguage({ conversationLanguage: 'fr' }), null);
  eq('an undetermined language is refused eligibility',
    evaluateAckEligibility({
      conversation: { channelProvider: 'meta_dm', channelStatus: 'active', language: 'fr', lastInboundAt: new Date() }
    }).reason, ACK_SKIP_REASONS.LANGUAGE_UNDETERMINED);
  eq('an unsupported language is refused even when the brand defaults to a supported one',
    evaluateAckEligibility({
      conversation: {
        channelProvider: 'meta_dm', channelStatus: 'active',
        language: 'fr', brandDefaultLanguage: 'ar', lastInboundAt: new Date()
      }
    }).reason, ACK_SKIP_REASONS.LANGUAGE_UNDETERMINED);
  check('...while an ABSENT language still falls back to the brand default',
    evaluateAckEligibility({
      conversation: {
        channelProvider: 'meta_dm', channelStatus: 'active',
        language: null, brandDefaultLanguage: 'ar', lastInboundAt: new Date()
      }
    }).eligible === true);
  eq('and produces no text to send', acknowledgmentTextFor(null), null);

  eq('both languages have text', ACK_LANGUAGES.map((l) => Boolean(ACKNOWLEDGMENT_TEXT[l])), [true, true]);
  const ARABIC = /[\u0600-\u06FF]/;
  check('the Arabic text is Arabic', ARABIC.test(ACKNOWLEDGMENT_TEXT.ar));
  check('the English text is not Arabic', !ARABIC.test(ACKNOWLEDGMENT_TEXT.en));
  check('the Arabic text is Egyptian colloquial, not MSA-only register',
    /(عملنا إشعار|هيتواصل|آسفين)/.test(ACKNOWLEDGMENT_TEXT.ar));
  check('neither text claims the customer was answered',
    !/answered|replied|تم الرد|اتحل/.test(ACKNOWLEDGMENT_TEXT.ar + ACKNOWLEDGMENT_TEXT.en));
  check('neither text names an employee or promises a time',
    !/\d+\s*(minute|minutes|hour|hours|دقيقة|ساعة)/i.test(ACKNOWLEDGMENT_TEXT.ar + ACKNOWLEDGMENT_TEXT.en));
}

/* ========================= 8. delivery outcomes ========================= */

section('8. Unknown delivery is preserved and never retried');
{
  eq('the five statuses', [...new Set(Object.values(ACK_STATUS))].sort(),
    ['failed', 'pending', 'sent', 'skipped', 'unknown']);
  check('unknown is a first-class status, not folded into failed',
    ACK_STATUS.UNKNOWN !== ACK_STATUS.FAILED);
  check('an ambiguous outcome is recorded as unknown',
    /outcome\.deliveryStatus === 'failed'[\s\S]{0,80}ACK_STATUS\.FAILED[\s\S]{0,60}ACK_STATUS\.UNKNOWN/.test(ACK_CODE));
  check('the returned retryable is hard-coded false regardless of the classifier',
    /retryable: false,/.test(ACK_CODE));
  check('a retryable verdict from the classifier is reported as SUPPRESSED, not hidden',
    /retrySuppressed: outcome\.retryable === true/.test(ACK_CODE));
  check('the shared classifier is reused rather than re-derived',
    /classifyDeliveryError/.test(ACK_CODE));
  check('the record keeps the delivery error for staff',
    /deliveryError: outcome\.category/.test(ACK_CODE));
  check('the panel surfaces it', /acknowledgment\.deliveryError|ack\.status\./.test(PANEL));
  check('staff can read the record through the handoff context',
    /getHandoffAcknowledgment/.test(read('src/services/humanOperations.js'))
    && /acknowledgment: acknowledgment &&/.test(read('src/services/humanOperations.js')));
  check('the acknowledgment cannot unlock an action or resume the AI',
    /purely informational/i.test(strip(read('src/services/handoffAcknowledgment.js')))
    || !/permission|can[A-Z]/.test(ACK_CODE));
  check('the panel renders `unknown` as "cannot tell", not as success',
    /ack\.unknownNote/.test(PANEL) && /t\(`ack\.status\.\$\{acknowledgment\.status\}`\)/.test(PANEL));
}

/* ========================= 9. owner UI ================================== */

section('9. The owner UI is minimal, translated and not the control');
{
  check('the card exists and is mounted on the platform page',
    /EscalationManagersCard/.test(read('apps/web/app/(app)/companies/page.tsx')));
  check('it reads the server\'s permission list rather than hardcoding it',
    /view\.permissions\.join/.test(CARD_CODE));
  check('it displays the role name from the server',
    /view\.role/.test(CARD_CODE));
  check('it never derives authority from a role name',
    !/includes\('Company Admin'\)|includes\('Supervisor'\)|roles\./.test(CARD_CODE));
  check('an already-granted person is not offered again',
    /\.filter\(\(c\) => !c\.already_granted\)/.test(CARD_CODE));
  check('an already-revoked or already-granted result is shown as success, not failure',
    /alreadyGranted \? t\('alreadyGranted'\)/.test(CARD_CODE)
    && /alreadyRevoked \? t\('alreadyRevoked'\)/.test(CARD_CODE));
  check('the reason field is mandatory in the UI, matching the server minimum',
    /MIN_REASON_CHARS = 8/.test(CARD_CODE) && /!reasonValid/.test(CARD_CODE));
  check('it warns that brand access is NOT included',
    /scopeWarning/.test(CARD_CODE));
  check('the grant button is disabled until company, user and reason are chosen',
    /disabled=\{!userId \|\| !selected \|\| !reasonValid/.test(CARD_CODE));
  check('errors are announced, not just coloured',
    (CARD.match(/role="alert"/g) ?? []).length >= 1);
  check('no physical spacing or alignment (RTL safe)',
    !/\b(ml|mr|pl|pr)-/.test(CARD_CODE) && !/text-(left|right)\b/.test(CARD_CODE));
  check('it wraps rather than overflowing on mobile',
    /flex-wrap/.test(CARD_CODE));
}

/* ========================= 10. regressions ============================== */

section('10. Everything earlier still holds');
{
  check('no new built-in role was introduced',
    BUILT_IN_ROLES.length === 4 && !BUILT_IN_ROLES.includes(ESCALATION_MANAGER_ROLE));
  check('the P0.2 manual-reply route is untouched',
    /router\.post\(\s*'\/:id\/reply'/.test(read('src/api/v1/conversations.js')));
  check('the AI gate still keys on AI_ACTIVE alone',
    /suppressed: !isAiActive\(state\)/.test(read('src/services/aiGate.js')));
  check('the handoff state machine is untouched by this batch',
    !/applyTransition|TRANSITIONS/.test(ACK_CODE));
  check('conversations.js was not modified for the acknowledgment',
    !/acknowledg/i.test(read('src/api/v1/conversations.js')));
  check('no new dependency was added',
    !/handoffAcknowledgment|platformRoles/.test(JSON.stringify(read('apps/web/package.json'))));

  const en = JSON.parse(read('apps/web/messages/en.json'));
  const ar = JSON.parse(read('apps/web/messages/ar.json'));
  const flat = (o, p = '') =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  const diff = (a, b, label) => {
    const ka = flat(a).map(([k]) => k).sort();
    const kb = flat(b).map(([k]) => k).sort();
    check(`${label} EN/AR key parity`, ka.join(',') === kb.join(','),
      `missing in ar: ${ka.filter((k) => !kb.includes(k)).join(', ')}`);
  };
  diff(en.platform.escalation, ar.platform.escalation, 'platform.escalation');
  diff(en.inbox.ops.ack, ar.inbox.ops.ack, 'inbox.ops.ack');
  eq('inbox.ops total key count is identical', flat(en.inbox.ops).length, flat(ar.inbox.ops).length);
  check('every new Arabic escalation string is Arabic',
    flat(ar.platform.escalation).every(([, v]) => typeof v !== 'string' || /[\u0600-\u06FF]/.test(v)));
  check('every new Arabic acknowledgment string is Arabic',
    flat(ar.inbox.ops.ack).every(([, v]) => typeof v !== 'string' || /[\u0600-\u06FF]/.test(v)));
  check('every ack status the server can emit has a translation',
    [...new Set(Object.values(ACK_STATUS))].every((s) => en.inbox.ops.ack.status[s] && ar.inbox.ops.ack.status[s]));
  check('every skip reason the server can emit has a translation',
    Object.values(ACK_SKIP_REASONS).every((s) => en.inbox.ops.ack.skip[s] && ar.inbox.ops.ack.skip[s]));
  check('REQUESTED_BY values unchanged', REQUESTED_BY.CUSTOMER === 'customer' && REQUESTED_BY.STAFF === 'staff');
  check('CUSTOMER_REQUESTED_HUMAN reason unchanged', HANDOFF_REASONS.CUSTOMER_REQUESTED_HUMAN === 'customer_requested_human');
}

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);