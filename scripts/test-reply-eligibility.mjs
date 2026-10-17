/**
 * Regression test for the manual reply field-name mismatch.
 *
 *   node scripts/test-reply-eligibility.mjs
 *
 * ROOT CAUSE: describeReply() passed a conversation object with 'provider' field
 * to evaluateReplyEligibility(), which checked 'channelProvider'. Since the field
 * was always undefined, SENDABLE_CHANNEL_PROVIDERS.includes(undefined) was false,
 * so every reply was reported as channel_unsupported regardless of the actual
 * channel provider.
 *
 * FIX: Added channelProvider/channelStatus/lastInboundAt aliases to the conversation
 * object in the detail endpoint, and made evaluateReplyEligibility check both
 * channelProvider and provider as fallback.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO = dirname(fileURLToPath(import.meta.url)) + '/..';
const M = await import('../src/services/manualReplies.js');
const C = await import('../src/services/conversations.js').catch(() => null);

let pass = 0;
const failures = [];
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
};
const eq = (name, a, b) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

section('1. evaluateReplyEligibility works with channelProvider field');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  const conv = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r = M.evaluateReplyEligibility({ authority: auth, conversation: conv });
  eq('meta_dm channel is eligible', r, { allowed: true, reason: 'ok' });
}

section('2. evaluateReplyEligibility works with provider field (fallback)');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  // This is what the detail endpoint returns: 'provider' instead of 'channelProvider'
  const conv = { state: 'ASSIGNED', provider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r = M.evaluateReplyEligibility({ authority: auth, conversation: conv });
  eq('meta_dm via provider field is eligible', r, { allowed: true, reason: 'ok' });
}

section('3. Facebook Comment is always blocked');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  for (const field of ['channelProvider', 'provider']) {
    const conv = { state: 'ASSIGNED', [field]: 'meta_comment', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
    const r = M.evaluateReplyEligibility({ authority: auth, conversation: conv });
    eq(`meta_comment via ${field} is blocked`, r.reason, 'channel_unsupported');
  }
}

section('4. Channel status check (fail-closed)');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  // Missing channelStatus should be blocked (fail-closed)
  const conv1 = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: null, lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r1 = M.evaluateReplyEligibility({ authority: auth, conversation: conv1 });
  eq('missing channelStatus is blocked', r1.reason, 'channel_inactive');
  // Disabled channel should be blocked
  const conv2 = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'disabled', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r2 = M.evaluateReplyEligibility({ authority: auth, conversation: conv2 });
  eq('disabled channel is blocked', r2.reason, 'channel_inactive');
  // Active channel should be allowed
  const conv3 = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r3 = M.evaluateReplyEligibility({ authority: auth, conversation: conv3 });
  eq('active channel is allowed', r3, { allowed: true, reason: 'ok' });
}

section('5. Messaging window check');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  // Missing lastInboundAt should be blocked
  const conv1 = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: null, assignedUserId: 'u1' };
  const r1 = M.evaluateReplyEligibility({ authority: auth, conversation: conv1 });
  eq('missing lastInboundAt is blocked', r1.reason, 'window_closed');
  // Expired window should be blocked
  const stale = new Date(Date.now() - (M.messagingWindowSeconds() + 60) * 1000);
  const conv2 = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: stale, assignedUserId: 'u1' };
  const r2 = M.evaluateReplyEligibility({ authority: auth, conversation: conv2 });
  eq('expired window is blocked', r2.reason, 'window_closed');
}

section('6. RBAC check');
{
  const noAuth = { canReplyAny: false, canReplyOwn: false, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  const conv = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r = M.evaluateReplyEligibility({ authority: noAuth, conversation: conv });
  eq('no reply ability is blocked', r.reason, 'no_ability');
}

section('7. State check');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  // AI_ACTIVE should be blocked
  const conv1 = { state: 'AI_ACTIVE', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r1 = M.evaluateReplyEligibility({ authority: auth, conversation: conv1 });
  eq('AI_ACTIVE is blocked', r1.reason, 'ai_active');
  // RESOLVED should be blocked
  const conv2 = { state: 'RESOLVED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r2 = M.evaluateReplyEligibility({ authority: auth, conversation: conv2 });
  eq('RESOLVED is blocked', r2.reason, 'closed');
}

section('8. Both field names work (provider and channelProvider)');
{
  const auth = { canReplyAny: true, canReplyOwn: true, userId: 'u1', tenantId: 't1', allBrandsInCompany: true, brandIds: null, isPlatformSuperAdmin: false };
  // channelProvider only
  const conv1 = { state: 'ASSIGNED', channelProvider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r1 = M.evaluateReplyEligibility({ authority: auth, conversation: conv1 });
  eq('channelProvider field works', r1, { allowed: true, reason: 'ok' });
  // provider only (what detail endpoint returns)
  const conv2 = { state: 'ASSIGNED', provider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r2 = M.evaluateReplyEligibility({ authority: auth, conversation: conv2 });
  eq('provider field works (fallback)', r2, { allowed: true, reason: 'ok' });
  // both fields
  const conv3 = { state: 'ASSIGNED', channelProvider: 'meta_dm', provider: 'meta_dm', channelStatus: 'active', lastInboundAt: new Date(), assignedUserId: 'u1' };
  const r3 = M.evaluateReplyEligibility({ authority: auth, conversation: conv3 });
  eq('both fields work', r3, { allowed: true, reason: 'ok' });
}

console.log(`\n${'='.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\n  FAILURES:'); for (const f of failures) console.log(`   - ${f}`); }
console.log('='.repeat(66));
process.exit(failures.length ? 1 : 0);