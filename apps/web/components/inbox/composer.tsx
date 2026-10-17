'use client';

/**
 * P0.2 — the employee reply composer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * It is NOT the security boundary. `reply.canReply` is server-authoritative and
 * is used here only to decide what to DRAW. The backend re-decides every part of
 * the question inside a single SQL statement, so disabling this button is a
 * courtesy to the employee, never a control.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IDEMPOTENCY KEY IS GENERATED HERE AND KEPT
 * ---------------------------------------------------------------------------
 * The Graph API send endpoint has no idempotency key of its own, so the database
 * is the only thing standing between a double-click and two copies of the same
 * message in a real customer's inbox. A key generated per render would defeat
 * that. A key is generated ONCE per draft and reused for every attempt to send
 * THAT draft, which means:
 *
 *   - a double click, an Enter key, a flaky connection and a manual retry all
 *     carry the same key, so only the first can ever create a message;
 *   - the key is replaced the moment the text changes, because that is a new
 *     message and must be allowed through.
 *
 * ---------------------------------------------------------------------------
 * WHY AN AMBIGUOUS FAILURE IS NOT AUTO-RETRIED
 * ---------------------------------------------------------------------------
 * A timeout does not tell us whether the customer received the reply. The server
 * records such a row as 'pending' — which is structurally not retryable — and the
 * UI says exactly that instead of offering a Send button that could duplicate a
 * message the customer already has.
 */

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, Clock, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { conversationsApi, type ConversationReplyPolicy } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Must match the backend's own vocabulary; unknown reasons fail safe. */
const REASON_KEYS = [
  'ok',
  'no_ability',
  'not_assigned',
  'ai_active',
  'closed',
  'invalid_state',
  'channel_unsupported',
  'channel_inactive',
  'channel_missing',
  'window_closed',
  'not_found'
] as const;
type ReplyReason = (typeof REASON_KEYS)[number];

const reasonKey = (reason: string): ReplyReason =>
  (REASON_KEYS as readonly string[]).includes(reason) ? (reason as ReplyReason) : 'invalid_state';

/** Crypto-random where available; a timestamped fallback that is still unique per draft. */
function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `ui-${c.randomUUID()}`;
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    return 'ui-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export type SendOutcome = {
  kind: 'sent' | 'pending' | 'failed' | 'duplicate' | 'refused';
  messageId: string | null;
  deliveryError: string | null;
  /** Machine code for a refusal, so the message can be specific. */
  code: string | null;
};

export function ReplyComposer({
  conversationId,
  policy,
  onSent,
  className
}: {
  conversationId: string;
  policy: ConversationReplyPolicy;
  /** Lets the thread refresh so the new message appears in place. */
  onSent?: (outcome: SendOutcome) => void;
  className?: string;
}) {
  const t = useTranslations('inbox.reply');
  const locale = useLocale();

  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<SendOutcome | null>(null);
  // One key per DRAFT. Replacing the text replaces the key, because that is a
  // genuinely different message.
  const keyRef = React.useRef<string>(newIdempotencyKey());
  const textRef = React.useRef(text);
  textRef.current = text;

  const max = policy.maxLength;
  const trimmedLength = [...text.trim()].length;
  const overLimit = trimmedLength > max;
  const canSend = policy.canReply && !sending && trimmedLength > 0 && !overLimit;
  const rtl = locale === 'ar';

  const onChange = (next: string) => {
    if (next !== textRef.current) keyRef.current = newIdempotencyKey();
    setText(next);
    if (outcome) setOutcome(null);
  };

  async function submit() {
    if (!canSend) return;
    // Guard against Enter + click landing in the same tick.
    if (sending) return;
    const body = text.trim();
    if (body.length === 0) return;

    const key = keyRef.current;
    setSending(true);
    setOutcome(null);
    try {
      const r = await conversationsApi.reply(conversationId, body, key);
      const kind = r.duplicate
        ? 'duplicate'
        : r.deliveryStatus === 'sent'
          ? 'sent'
          : r.deliveryStatus === 'pending'
            ? 'pending'
            : 'failed';
      setOutcome({ kind, messageId: r.messageId, deliveryError: r.deliveryError ?? null, code: null });
      // Only clear the draft on a settled outcome. A refused or ambiguous send
      // keeps the text so the employee can read what they wrote.
      if (kind === 'sent' || kind === 'duplicate') {
        setText('');
        keyRef.current = newIdempotencyKey();
      }
      onSent?.({ kind, messageId: r.messageId, deliveryError: r.deliveryError ?? null, code: null });
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setOutcome({
        kind: 'refused',
        messageId: null,
        deliveryError: null,
        code: err?.code ?? 'NETWORK_ERROR'
      });
      // The key is intentionally NOT regenerated: if the request actually reached
      // the server, retrying with the same key returns the original result
      // instead of delivering a second copy.
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={cn('border-t border-border bg-surface px-3 py-3 sm:px-4', className)}>
      {policy.canReply ? (
        <>
          <label className="sr-only" htmlFor="reply-composer">
            {t('label')}
          </label>
          <textarea
            id="reply-composer"
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline. Never submits twice: the
              // button is disabled while `sending` and submit() re-checks it.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            maxLength={max * 2}
            dir="auto"
            aria-describedby="reply-composer-status"
            placeholder={t('placeholder')}
            className={cn(
              'w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground',
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-60',
              overLimit && 'border-destructive focus-visible:ring-destructive'
            )}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p id="reply-composer-status" className="text-2xs text-muted-foreground" aria-live="polite">
              {overLimit ? (
                <span className="text-destructive">{t('overLimit', { count: max })}</span>
              ) : (
                t('counter', { current: trimmedLength, max })
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setText('');
                  keyRef.current = newIdempotencyKey();
                  setOutcome(null);
                }}
                disabled={sending || text.length === 0}
              >
                {t('clear')}
              </Button>
              <Button type="button" size="sm" onClick={() => void submit()} disabled={!canSend} aria-busy={sending}>
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
                {sending ? t('sending') : t('send')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <ComposerBlocked policy={policy} rtl={rtl} />
      )}

      {outcome ? <OutcomeBanner outcome={outcome} /> : null}
    </div>
  );
}

/**
 * Why the composer is not available.
 *
 * Explains the real reason instead of hiding the control — an employee who is
 * refused with no explanation files a support ticket. The server may still refuse
 * at send time; this is the fast, honest answer.
 */
function ComposerBlocked({ policy, rtl }: { policy: ConversationReplyPolicy; rtl: boolean }) {
  const t = useTranslations('inbox.reply');
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-2xs text-muted-foreground"
    >
      <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <p className="space-y-1">
        <span className="block font-medium text-secondary-foreground">{t('blockedTitle')}</span>
        <span className="block">{t(`reasons.${reasonKey(policy.reason)}`)}</span>
        {policy.requiresHandoff ? <span className="block">{t('handoffHint')}</span> : null}
        {policy.canReplyOnlyAssigned ? (
          <span className="block" dir={rtl ? 'rtl' : 'ltr'}>
            {t('assignedHint')}
          </span>
        ) : null}
      </p>
    </div>
  );
}

function OutcomeBanner({ outcome }: { outcome: SendOutcome }) {
  const t = useTranslations('inbox.reply');

  // An unknown delivery outcome must never read as a failure the employee can fix
  // by pressing Send again — the customer may already have the message.
  if (outcome.kind === 'pending') {
    return (
      <p
        role="status"
        className="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-2xs text-warning"
      >
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('outcomePending')}</span>
      </p>
    );
  }
  if (outcome.kind === 'sent' || outcome.kind === 'duplicate') {
    return (
      <p
        role="status"
        className="mt-2 flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-2xs text-success"
      >
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{outcome.kind === 'duplicate' ? t('outcomeDuplicate') : t('outcomeSent')}</span>
      </p>
    );
  }
  return (
    <p
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-2xs text-destructive"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {outcome.code && outcome.code.startsWith('REPLY_') || outcome.code === 'MESSAGING_WINDOW_CLOSED'
          ? t(`errors.${outcome.code}`)
          : t('outcomeFailed')}
      </span>
    </p>
  );
}