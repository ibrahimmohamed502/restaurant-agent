/**
 * P0.2 — Inbox reply UI.
 *
 *   cd apps/web && npm test
 *
 * Runs in vitest's `node` environment (see vitest.config.ts), so there is no DOM.
 * These assertions are therefore about what the component SOURCE guarantees —
 * which is exactly the set of things that must not regress silently:
 *
 *   - the idempotency key is generated once per DRAFT and reused on retry
 *   - the send button is disabled while a request is in flight
 *   - no fake "sent" state is ever rendered without the server having said so
 *   - the composer is driven by the server's own policy, never by a client rule
 *   - every user-visible string comes from the translation catalogue
 *   - Arabic and English stay in parity
 *
 * Behavioural coverage of the send path itself lives in
 * scripts/test-manual-reply.mjs and scripts/test-manual-reply-race.mjs, which
 * exercise the real service with a real HTTP-shaped request.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const composer = readFileSync(new URL('../components/inbox/composer.tsx', import.meta.url), 'utf8');
const view = readFileSync(new URL('../components/inbox/view.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

/* ------------------------------------------------------------------ i18n */

describe('inbox reply copy', () => {
  it('keeps the inbox namespace in parity', () => {
    expect(Object.keys(en.inbox).sort().join(',')).toBe(Object.keys(ar.inbox).sort().join(','));
  });
  it('keeps every nested reply group in parity', () => {
    for (const k of ['states', 'reply'] as const) {
      expect(Object.keys(en.inbox[k]).sort().join(',')).toBe(Object.keys(ar.inbox[k]).sort().join(','));
    }
    for (const k of ['reasons', 'errors'] as const) {
      expect(Object.keys(en.inbox.reply[k]).sort().join(',')).toBe(
        Object.keys(ar.inbox.reply[k]).sort().join(',')
      );
    }
  });
  it('covers every reason the backend can return', () => {
    const reasons = [
      'ok', 'no_ability', 'not_assigned', 'ai_active', 'closed', 'invalid_state',
      'channel_unsupported', 'channel_inactive', 'channel_missing', 'window_closed', 'not_found'
    ];
    for (const r of reasons) {
      expect(en.inbox.reply.reasons, `en missing reason ${r}`).toHaveProperty(r);
      expect(ar.inbox.reply.reasons, `ar missing reason ${r}`).toHaveProperty(r);
    }
  });
  it('covers every error code the API can return', () => {
    for (const code of Object.keys(en.inbox.reply.errors)) {
      expect(ar.inbox.reply.errors).toHaveProperty(code);
    }
  });
  it('has real Arabic copy, never an English fallback', () => {
    const latin = (s: string) => {
      const stripped = s.replace(/\{[a-zA-Z0-9_]+\}/g, ' ').replace(/\b(Enter|Shift|Meta|AI)\b/g, ' ');
      return (stripped.match(/[A-Za-z]{4,}/g) ?? []).length;
    };
    for (const [k, v] of Object.entries(ar.inbox.reply.reasons)) {
      expect(latin(v as string), `ar.reasons.${k} looks like untranslated copy`).toBe(0);
    }
    for (const [k, v] of Object.entries(ar.inbox.reply.errors)) {
      expect(latin(v as string), `ar.errors.${k} looks like untranslated copy`).toBe(0);
    }
  });
});

/* ------------------------------------------------------ idempotency in UI */

describe('duplicate-submission protection', () => {
  it('generates the idempotency key from a ref, not from render state', () => {
    expect(composer).toMatch(/keyRef\s*=\s*React\.useRef/);
    expect(composer).toContain('newIdempotencyKey()');
  });
  it('replaces the key ONLY when the text changes (a new draft is a new message)', () => {
    expect(composer).toContain('if (next !== textRef.current) keyRef.current = newIdempotencyKey();');
  });
  it('reuses the SAME key across retries of one draft', () => {
    // The key is captured once and passed to every attempt...
    expect(composer).toContain('const key = keyRef.current;');
    // ...and is deliberately NOT regenerated in the catch branch.
    const catchBlock = composer.slice(composer.indexOf('} catch (e) {'), composer.indexOf('} finally {'));
    expect(catchBlock).not.toContain('keyRef.current = newIdempotencyKey()');
    expect(catchBlock).toMatch(/intentionally NOT regenerated/);
  });
  it('rotates the key only after a settled send or an explicit clear', () => {
    expect(composer).toMatch(/if \(kind === 'sent' \|\| kind === 'duplicate'\) \{[\s\S]*keyRef\.current = newIdempotencyKey\(\)/);
  });
  it('sends through the API client with the key as a required argument', () => {
    expect(api).toMatch(/reply: \(id: string, text: string, idempotencyKey: string\)/);
    expect(composer).toContain('conversationsApi.reply(conversationId, body, key)');
  });
});

/* ------------------------------------------------------- loading + guards */

describe('send-state honesty', () => {
  it('disables the send button while a request is in flight', () => {
    expect(composer).toMatch(/const canSend = policy\.canReply && !sending/);
    expect(composer).toMatch(/disabled=\{!canSend\}/);
  });
  it('re-entrancy guard inside submit(), not only in the disabled prop', () => {
    expect(composer).toContain('if (sending) return;');
  });
  it('marks the control busy for assistive tech', () => {
    expect(composer).toContain('aria-busy={sending}');
  });
  it('never shows a sent state without the server having confirmed one', () => {
    // 'sent' is only reachable from deliveryStatus === 'sent' returned by the API.
    expect(composer).toMatch(/r\.deliveryStatus === 'sent'/);
    expect(composer).not.toMatch(/setOutcome\(\{ kind: 'sent'[^}]*\}\)(?![\s\S]{0,120}deliveryStatus)/);
  });
  it('does not offer a resend when the outcome is unknown', () => {
    expect(composer).toContain('outcomePending');
    const pending = composer.slice(composer.indexOf("kind === 'pending'"));
    expect(pending.slice(0, 400)).not.toContain('submit()');
  });
  it('keeps the draft text when a send is refused or ambiguous', () => {
    expect(composer).toMatch(/if \(kind === 'sent' \|\| kind === 'duplicate'\) \{\s*\n\s*setText\(''\)/);
  });
  it('shows delivery state on outbound messages in the thread', () => {
    expect(view).toContain('DeliveryBadge');
    expect(view).toMatch(/m\.direction === 'outbound'[\s\S]{0,120}DeliveryBadge/);
  });
});

/* --------------------------------------------------- permission plumbing */

describe('permissions come from the server', () => {
  it('reads the policy off the conversation detail response', () => {
    expect(view).toContain('<ReplyComposer');
    expect(view).toMatch(/policy=\{detail\.reply\}/);
  });
  it('renders the blocked state from the server reason, not from a local rule', () => {
    expect(composer).toContain('reasonKey(policy.reason)');
    expect(composer).toContain('policy.requiresHandoff');
    expect(composer).toContain('policy.canReplyOnlyAssigned');
  });
  it('re-reads the thread so a state change cannot leave a stale "you can reply"', () => {
    expect(view).toContain('refreshToken');
    expect(view).toMatch(/setInterval\([\s\S]{0,120}10000\)/);
  });
  it('never derives an identity from the browser', () => {
    // The pre-existing suite forbids the word in view.tsx; the composer must not
    // reintroduce it either.
    expect(view).not.toMatch(/tenant/i);
    expect(composer).not.toMatch(/tenant/i);
    expect(composer).not.toMatch(/brandId|channelId|senderUserId|providerId/);
  });
  it('shows the lifecycle state rather than a raw enum', () => {
    expect(view).toContain('stateLabel');
    expect(composer).not.toMatch(/AI_ACTIVE|QUEUED|HUMAN_ACTIVE/);
  });
});

/* ------------------------------------------------------------ a11y / i18n */

describe('accessibility and localisation', () => {
  it('marks message text as auto-direction so mixed Arabic/English reads correctly', () => {
    expect(composer).toContain('dir="auto"');
    expect(view).toContain('dir="auto"');
  });
  it('announces the composer state and the outcome politely', () => {
    expect(composer).toContain('aria-live="polite"');
    expect(composer).toContain('role="alert"');
    expect(composer).toContain('role="status"');
  });
  it('labels the textarea for screen readers', () => {
    expect(composer).toContain('<label className="sr-only"');
    expect(composer).toContain('htmlFor="reply-composer"');
  });
  it('uses translated copy for every visible string', () => {
    // No hard-coded English sentence may reach the user.
    expect(composer).not.toMatch(/>\s*(Send|Clear|Sending)/);
    expect(composer).toContain("useTranslations('inbox.reply')");
  });
  it('keeps the layout usable on a phone', () => {
    expect(view).toContain('lg:grid-cols-[20rem_1fr]');
    expect(composer).toContain('flex-wrap');
  });
});