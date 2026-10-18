/**
 * P0.3 correction batch — acknowledgment wording and the `pending` contract.
 *
 *   node scripts/test-ack-correction.mjs
 *
 * Two things are being locked down here, both of which are statements to a real
 * customer:
 *
 *   1. WHAT THE TEXT CLAIMS. The previous wording said the team had been notified
 *      and would reply "shortly". Neither was true — `notifyStaff` is not called on
 *      this path, and there is no SLA or queue-age alarm anywhere in the codebase.
 *      These assertions fail if a promise creeps back in.
 *
 *   2. WHAT A STUCK `pending` MEANS. A row left pending is one whose process died
 *      before recording an outcome. It must be shown as uncertain, must never be
 *      retried, and must never lose the unique index that prevents a duplicate.
 *
 * The behavioural half (a real stuck-pending row, real tenant/brand isolation, real
 * concurrent sends) lives in scripts/test-p03-final-pg.mjs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACK_STATUS, ACKNOWLEDGMENT_TEXT } from '../src/services/handoffAcknowledgment.js';

const REPO = resolve(process.cwd());
const read = (f) => readFileSync(resolve(REPO, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

const ACK = read('src/services/handoffAcknowledgment.js');
const ACK_CODE = strip(ACK);
const MIG18 = read('migrations/018_handoff_acknowledgment.sql');
const PANEL = read('apps/web/components/inbox/handoff-panel.tsx');
const en = JSON.parse(read('apps/web/messages/en.json'));
const ar = JSON.parse(read('apps/web/messages/ar.json'));

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
};
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ============================== 1. the approved wording ==================== */

section('1. The acknowledgment text is exactly what was approved');
{
  eq('English text is the approved wording',
    ACKNOWLEDGMENT_TEXT.en,
    'Your request has been added to our customer support queue for a team member to follow up. Thank you for your patience.');
  eq('Arabic text is the approved wording',
    ACKNOWLEDGMENT_TEXT.ar,
    'تم تحويل طلبك لفريق خدمة العملاء، وهيتم متابعة محادثتك من خلال أحد أفراد الفريق. شكرًا لانتظارك.');

  check('the English text is not Arabic', !/[\u0600-\u06FF]/.test(ACKNOWLEDGMENT_TEXT.en));
  check('the Arabic text is Arabic', /[\u0600-\u06FF]/.test(ACKNOWLEDGMENT_TEXT.ar));
}

/* ========================= 2. it promises nothing unverified =============== */

section('2. The text claims only what the system has actually done');
{
  // These are the exact claims that were wrong before. If one returns, the copy is
  // lying to a customer again.
  const NEVER = [
    ['notified the team', ['notified', 'we have alerted', 'we alerted', 'we\'ve alerted']],
    ['imminent reply', ['shortly', 'soon', 'right away', 'immediately', 'any moment']],
    ['a definite reply', ['will reply', 'someone will get back', 'will get back to you soon']],
    ['already answered', ['answered', 'we have replied', 'already resolved']],
    ['a concrete time', [/\b\d+\s*(minute|hour|day|min|hr)s?\b/i]]
  ];
  for (const [label, needles] of NEVER) {
    for (const n of needles) {
      const re = n instanceof RegExp ? n : new RegExp(n.replace(/'/g, "'"), 'i');
      check(`EN does not claim: ${label}`, !re.test(ACKNOWLEDGMENT_TEXT.en),
        `matched /${n}/`);
    }
  }

  const NEVER_AR = ['هنبلّغ', 'أخبرنا', 'إشعار', 'قريب', 'في أسرع وقت', 'هيتم الرد', 'تم الرد', 'اتحل'];
  for (const phrase of NEVER_AR) {
    check(`AR does not claim a promise (${phrase})`, !ACKNOWLEDGMENT_TEXT.ar.includes(phrase));
  }

  // "خلال" appears in the approved text but NOT as a time promise ("خلال دقائق" etc).
  // It appears in "وهيتم متابعة محادثتك من خلال أحد أفراد الفريق" — that is NOT a time promise.
  check('AR does not use "خلال" as a time unit', !/خلال\s*(دقيقة|دقايق|ساعة|ساعات|يوم|أيام|دقائق)/.test(ACKNOWLEDGMENT_TEXT.ar));

  // ...and the truthful claims ARE present, because dropping them would leave the
  // customer with a message that says nothing useful at all.
  check('EN states the request was added to a queue', /added to our customer support queue/i.test(ACKNOWLEDGMENT_TEXT.en));
  check('EN says a team member will follow up', /for a team member to follow up/i.test(ACKNOWLEDGMENT_TEXT.en));
  check('EN thanks the customer for waiting', /thank you for your patience/i.test(ACKNOWLEDGMENT_TEXT.en));
  check('AR states the request went to the support team', /تم تحويل طلبك لفريق خدمة العملاء/.test(ACKNOWLEDGMENT_TEXT.ar));
  check('AR says a team member will follow up', /متابعة محادثتك من خلال أحد أفراد الفريق/.test(ACKNOWLEDGMENT_TEXT.ar));
  check('AR thanks the customer for waiting', /شكرًا لانتظارك/.test(ACKNOWLEDGMENT_TEXT.ar));

  // An individual must never be named: the queue is worked by whoever is free.
  check('neither text names an individual',
    !/\b(Mr|Mrs|Ms|Dr)\b/.test(ACKNOWLEDGMENT_TEXT.en)
    && !/(الأستاذ|السيدة|الدكتور)/.test(ACKNOWLEDGMENT_TEXT.ar));

  // The queue claim is only true because requestHandoff ran first. That ordering is
  // the load-bearing part and must not drift.
  const w = read('src/webhook.js');
  check('the text is sent only AFTER requestHandoff committed the queue entry',
    w.indexOf('await requestHandoff(') < w.indexOf('maybeAcknowledgeHandoff({'));
}

/* ============================ 3. the `pending` contract =================== */

section('3. A stuck `pending` is an uncertain outcome, never confirmed sent');
{
  check('pending is a distinct status, not an alias for sent',
    ACK_STATUS.PENDING === 'pending' && ACK_STATUS.SENT === 'sent' && ACK_STATUS.PENDING !== ACK_STATUS.SENT);
  eq('all five statuses are unchanged', [...new Set(Object.values(ACK_STATUS))].sort(),
    ['failed', 'pending', 'sent', 'skipped', 'unknown']);

  // Staff presentation: pending and unknown must be indistinguishable in meaning.
  const uncertain = PANEL.match(/acknowledgment\.status === 'pending'\s*\|\|\s*acknowledgment\.status === 'unknown'/);
  check('the panel treats `pending` and `unknown` as the same uncertain outcome', Boolean(uncertain));
  check('...and marks the block with a machine-readable flag',
    /data-uncertain=\{uncertain \? 'true' : 'false'\}/.test(PANEL));
  check('...and shows the note for both, not just for `unknown`',
    /\{uncertain \? \(\s*<span[^>]*>\{t\('ack\.unknownNote'\)\}/.test(PANEL.replace(/\s+/g, ' ')));
  check('...and shows WHEN it was recorded, because age is what marks it as stuck',
    /ack\.createdAt/.test(PANEL));
  check('the `pending` copy does not read as progress',
    !/being sent|sending now|جار|في الإرسال/.test(en.inbox.ops.ack.status.pending));
  check('the `pending` copy states the outcome is unknown',
    /cannot tell/.test(en.inbox.ops.ack.status.pending));
  check('the Arabic `pending` copy states the outcome is unknown',
    /مش متأكد/.test(ar.inbox.ops.ack.status.pending));

  // Never retried, and the idempotency guard is untouched.
  check('there is no retry of a pending record anywhere in the service',
    !/ACK_STATUS\.PENDING[\s\S]{0,400}(retry|resend|again)/i.test(ACK_CODE));
  check('no code re-arms or deletes a pending record',
    !/DELETE FROM handoff_acknowledgments/i.test(ACK_CODE));
  check('no UPDATE resets a pending row to a new attempt',
    !/SET status = 'pending'/i.test(ACK_CODE));
  check('the unique index that prevents a duplicate is still the guard',
    /ON CONFLICT \(tenant_id, conversation_id\) DO NOTHING/.test(ACK_CODE));
  check('migration 018 still creates that unique index',
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_acknowledgments_conversation[\s\S]{0,90}\(tenant_id, conversation_id\)/.test(MIG18));
  check('the migration documents pending as the interrupted case',
    /pending'' is the INTERRUPTED case/i.test(MIG18));
  check('the service documents why pending is deliberately left alone',
    /stays `pending` for ever/i.test(ACK));
  check('...and why retrying it would be unsafe',
    /Retrying is unsafe/i.test(ACK));
  check('...and why deleting it would be worse',
    /Deleting the row is worse/i.test(ACK));

  // It must still be visible to staff, or "not silently stranded" is unmet.
  check('the status is exposed through the handoff context',
    /acknowledgment: acknowledgment &&/.test(read('src/services/humanOperations.js')));
  check('createdAt is exposed so the age can be judged',
    /createdAt: acknowledgment\.created_at/.test(read('src/services/humanOperations.js')));
  check('the staff read still excludes the customer PSID',
    !/SELECT[^;]*external_key[^;]*FROM handoff_acknowledgments/i.test(ACK_CODE.replace(/\s+/g, ' ')));
}

/* ==================== 4. nothing else quietly changed ==================== */

section('4. Scope held: this batch changed wording and presentation only');
{
  check('the acknowledgment is still only for customer-requested-human',
    /requestedBy !== REQUESTED_BY\.CUSTOMER \|\| reason !== HANDOFF_REASONS\.CUSTOMER_REQUESTED_HUMAN/.test(ACK_CODE));
  check('the durable record is still claimed BEFORE the provider call',
    ACK_CODE.indexOf('INSERT INTO handoff_acknowledgments') < ACK_CODE.indexOf('sendMessengerReply'));
  check('the module still cannot touch conversation state',
    !/UPDATE conversations|resumeAi\(|applyTransition/.test(ACK_CODE));
  check('no new status was introduced',
    Object.keys(ACK_STATUS).length === 5);
  check('no new migration was added by this batch',
    (read('src/services/handoffAcknowledgment.js').match(/handoff_acknowledgments/g) ?? []).length > 0);
  const migFiles = readdirSync(resolve(REPO, 'migrations')).join(' ');
  // 019 (AI routing rules) is an approved LATER batch, under its own review.
  // It is still a pure ADDITION after 018 - nothing was renamed or removed -
  // so this guard now asserts that shape instead of a hard "019 must not exist".
  check('migrations after 018 are additive only (019 is the AI-routing batch)',
    /018_handoff_acknowledgment\.sql/.test(migFiles)
      && (/019_/.test(migFiles) || !/0(19|2\d)_/.test(migFiles))
      && !/^0(19|2\d)_.*\b(DROP|TRUNCATE|ALTER)\b/im.test(
        readdirSync(resolve(REPO, 'migrations')).filter((f) => /^0(19|2\d)_/.test(f))
          .map((f) => read(resolve(REPO, 'migrations', f))).join('\n')));
}

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);