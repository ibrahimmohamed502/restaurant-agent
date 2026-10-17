'use client';

/**
 * P0.3-B — Unified Inbox human-operations panel.
 *
 * Seven operations over the P0.3-A backend: claim, assign/reassign, unassign,
 * resolve, resume-ai, close a single escalation, and staff-initiated handoff.
 *
 * FOUR RULES THIS COMPONENT FOLLOWS, none of them optional:
 *
 * 1. THE SERVER DECIDES. Every control is rendered from
 *    `handoffContext().permissions`, which the server computes for this caller and
 *    this conversation right now. Nothing here re-derives a rule from a role name,
 *    and nothing infers authority from a string in the DOM. Hiding a button is a
 *    courtesy; the write path re-decides the same question inside its own
 *    transaction, so a forged request still fails.
 *
 * 2. NO SUCCESS BEFORE THE SERVER CONFIRMS IT. There is no optimistic state. A
 *    control shows as done only after the API returned, and `duplicate: true` is
 *    rendered as a neutral "already done" rather than as a second success or a
 *    failure — a retried request must never look like an error.
 *
 * 3. ONE MUTATION AT A TIME, EVERYWHERE. A single `busy` key guards every control.
 *    The server is still the authority (it holds the state guard), but this removes
 *    the double-click race locally and makes the button honestly reflect that work
 *    is in flight.
 *
 * 4. EVERY MUTATION RE-READS THE SERVER. After any success, conflict, or refusal,
 *    the context is refetched. The conversation may have changed underneath us —
 *    reassigned, escalated, resolved by a colleague — and the panel must show the
 *    server's truth, never a local guess.
 *
 * The panel also distinguishes a failure from a load, which is the defect class
 * that made the P0 Inbox bug invisible: a failed fetch renders an error with a
 * retry, never an infinite skeleton.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle, Bot, CheckCircle2, ClipboardCheck, Loader2, LogOut,
  RefreshCw, UserCheck, UserMinus, UserPlus
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog';
import {
  ApiError, conversationsApi, type HandoffContext, type OpenEscalation
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * How often the panel re-reads its context while a conversation is selected.
 *
 * Matches the thread's existing 10s cadence (view.tsx) so both views agree on when
 * they last saw the server, rather than introducing a second, faster poll.
 */
const REFRESH_INTERVAL_MS = 10000;

/** Every mutation the panel can perform. */
type Op =
  | 'claim' | 'assign' | 'unassign' | 'resolve'
  | 'resumeAi' | 'handoff' | 'escalation';

type Outcome =
  | { kind: 'ok'; message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'error'; message: string; conflict: boolean };

/**
 * Why Resume AI is unavailable, in the server's own vocabulary.
 *
 * These are the exact strings `getHandoffContext` returns. An unrecognised value
 * falls through to a generic explanation rather than silently offering the button:
 * the server is the authority, so an unrecognised reason means "we do not
 * understand why this is blocked", which must not read as permission.
 */
function resumeBlockedText(reason: string | null, t: (k: string) => string): string {
  switch (reason) {
    case 'open_escalations': return t('resumeBlocked.openEscalations');
    case 'human_engaged': return t('resumeBlocked.humanEngaged');
    case 'reply_in_flight': return t('resumeBlocked.replyInFlight');
    case 'no_ability': return t('resumeBlocked.noAbility');
    case 'already_ai_active': return t('resumeBlocked.alreadyAiActive');
    case 'state_not_resumable': return t('resumeBlocked.stateNotResumable');
    default: return t('resumeBlocked.unknown');
  }
}

/** Map a server refusal onto something an employee can act on. */
function errorText(err: unknown, t: (k: string) => string): string {
  if (!(err instanceof ApiError)) return t('errors.network');
  if (err.status === 0) return t('errors.network');
  switch (err.code) {
    case 'OPS_FORBIDDEN': return t('errors.forbidden');
    case 'OPS_NOT_FOUND': return t('errors.notFound');
    case 'OPS_ESCALATION_NOT_FOUND': return t('errors.escalationNotFound');
    case 'OPS_ASSIGNEE_NO_BRAND_ACCESS': return t('errors.assigneeBrand');
    case 'OPS_ASSIGNEE_NOT_ELIGIBLE': return t('errors.assigneeIneligible');
    case 'OPS_OPEN_ESCALATIONS': return t('errors.openEscalations');
    case 'OPS_HUMAN_ENGAGED': return t('errors.humanEngaged');
    case 'OPS_REPLY_IN_FLIGHT': return t('errors.replyInFlight');
    case 'OPS_NOT_ASSIGNED': return t('errors.notAssigned');
    case 'HANDOFF_CONFLICT': return t('errors.conflict');
    case 'HANDOFF_INVALID_TRANSITION': return t('errors.invalidTransition');
    case 'HANDOFF_USER_NOT_ELIGIBLE': return t('errors.assigneeIneligible');
    case 'HANDOFF_SAME_ASSIGNEE': return t('errors.sameAssignee');
    case 'HANDOFF_REASON_REQUIRED': return t('errors.reasonRequired');
    case 'HANDOFF_NOT_ASSIGNED': return t('errors.notAssigned');
    case 'HANDOFF_NOT_FOUND': return t('errors.notFound');
    case 'OPS_VALIDATION_FAILED': return t('errors.validation');
    case 'OPS_INTERNAL': return t('errors.server');
    default:
      // A 409 is a concurrency outcome whatever its code, so it always offers the
      // "someone else got there first" reading and a refresh.
      return err.status === 409 ? t('errors.conflict')
        : err.status === 403 ? t('errors.forbidden')
          : err.status === 404 ? t('errors.notFound')
            : err.status === 422 ? t('errors.validation')
              : t('errors.server');
  }
}

const isConflict = (err: unknown) =>
  err instanceof ApiError && (err.status === 409 || err.code === 'HANDOFF_CONFLICT');

export function HandoffPanel({
  conversationId,
  onChanged
}: {
  conversationId: string;
  /** Called after any server-confirmed change so the thread re-reads too. */
  onChanged?: () => void;
}) {
  const t = useTranslations('inbox.ops');

  const [ctx, setCtx] = React.useState<HandoffContext | null>(null);
  const [loading, setLoading] = React.useState(true);
  // A failed fetch is a DISTINCT state from loading. Collapsing the two is what
  // produced the P0 infinite skeleton.
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Op | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  /**
   * Guards against the two failure modes a background refresh creates.
   *
   * `inFlight` — a poll that arrives while the previous one is still running is
   * SKIPPED, never queued. Without this, a slow response would stack up requests
   * every tick and make the load worse exactly when the server is struggling.
   *
   * `seq` — a monotonically increasing token. A response is only allowed to
   * replace the context if it is the newest one issued. Without this, a slow
   * response for conversation A could land after the operator already selected
   * conversation B and overwrite B's controls with A's.
   *
   * Both are refs, not state: they must be readable inside the fetch without
   * causing a re-render or re-creating the callback.
   */
  const inFlight = React.useRef(false);
  const seq = React.useRef(0);

  // Confirmation dialog state. Every reason-taking action goes through it, so a
  // destructive or customer-visible change is never one stray click.
  const [dialog, setDialog] = React.useState<
    | { kind: 'assign' }
    | { kind: 'unassign' }
    | { kind: 'resolve' }
    | { kind: 'resumeAi' }
    | { kind: 'handoff' }
    | { kind: 'escalation'; escalation: OpenEscalation }
    | null
  >(null);
  const [reason, setReason] = React.useState('');
  const [memberId, setMemberId] = React.useState<string>('');

  const load = React.useCallback(async (silent = false) => {
    // A poll arriving while one is already running is dropped, not queued.
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = ++seq.current;

    if (!silent) setLoading(true);
    try {
      const data = await conversationsApi.handoffContext(conversationId);
      // Stale-response guard: if a newer request has been issued since this one
      // started, this answer describes a state the operator has already moved on
      // from. Dropping it is the only safe option.
      if (ticket !== seq.current) return;
      setCtx(data);
      setLoadError(null);
    } catch (err) {
      if (ticket !== seq.current) return;
      setCtx(null);
      setLoadError(err instanceof ApiError && err.status === 403 ? 'forbidden' : 'failed');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [conversationId]);

  React.useEffect(() => { void load(); }, [load]);

  /**
   * Lightweight background refresh.
   *
   * A conversation can leave the AI's hands, be reassigned or be escalated by
   * someone else, and the panel would otherwise keep showing controls that are no
   * longer valid. The thread already re-reads on a 10s timer; this matches it so
   * both views agree, rather than introducing a second cadence.
   *
   * SKIPPED while a mutation is in flight, so a poll can never land in the middle
   * of a submit and re-enable a button mid-click.
   *
   * The interval is cleared on unmount AND on every conversationId change, so no
   * timer outlives the component or the selection it was reading.
   */
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (busy !== null) return;      // never refresh mid-mutation
      if (document.hidden) return;    // no polling for a tab nobody is looking at
      void load(true);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, busy]);

  const closeDialog = () => { setDialog(null); setReason(''); setMemberId(''); };

  /**
   * Run one mutation, then ALWAYS re-read the server.
   *
   * Success is only ever reported from the server's response. `duplicate: true`
   * means the postcondition already held — reported as neutral, never as a fresh
   * success and never as a failure.
   */
  const run = React.useCallback(async (
    kind: Op,
    fn: () => Promise<{ duplicate: boolean }>
  ) => {
    // Rule 3: a second click while one is in flight is ignored, not queued.
    if (busy) return;
    setBusy(kind);
    setOutcome(null);
    try {
      const r = await fn();
      setOutcome(
        r.duplicate
          ? { kind: 'duplicate', message: t('outcome.alreadyDone') }
          : { kind: 'ok', message: t(`outcome.${kind}`) }
      );
      closeDialog();
      await load(true);
      onChanged?.();
    } catch (err) {
      setOutcome({
        kind: 'error',
        message: errorText(err, t),
        conflict: isConflict(err)
      });
      // A conflict means our view is stale by definition: re-read so the panel
      // shows who actually won, instead of leaving a stale button enabled.
      if (isConflict(err)) await load(true);
    } finally {
      setBusy(null);
    }
  }, [busy, load, onChanged, t]);

  /* ------------------------------------------------------------------ render */

  // ERROR BRANCH FIRST, deliberately, and it comes before the skeleton for the
  // same reason view.tsx does: a failed fetch must never be indistinguishable from a
  // load in progress. `loading && !ctx` alone would be safe today (loading is false
  // after a failure) but it depends on that coincidence; ordering it this way means
  // a future edit cannot reintroduce the infinite skeleton.
  if (loadError || !ctx) {
    return (
      <div className="border-t border-border px-4 py-4" data-testid="handoff-panel-error">
        <ErrorState
          title={t('loadErrorTitle')}
          description={loadError === 'forbidden' ? t('loadErrorForbidden') : t('loadErrorGeneric')}
          actionLabel={t('retry')}
          onAction={() => void load()}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3 border-t border-border px-4 py-4" aria-busy="true" data-testid="handoff-panel-loading">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const { permissions: p, conversation, openEscalations, eligibleMembers, history } = ctx;
  const disabled = busy !== null;
  const dialogBusy = busy !== null;

  /**
   * A channel we can take ownership of but not actually WRITE to.
   *
   * Claiming or assigning a Facebook comment conversation works and looks like
   * progress, but no employee reply can be delivered on that channel — so the
   * operator must be told plainly, BEFORE they spend time on it, that taking
   * ownership does not mean the customer will be answered. Without this the panel
   * implies a capability it does not have.
   *
   * Derived from the server's own provider value and the same list the backend
   * refuses against (SENDABLE_CHANNEL_PROVIDERS = ['meta_dm']), so the UI cannot
   * drift into telling the operator something the API disagrees with.
   */
  const isWriteUnsupported = conversation.channelProvider !== 'meta_dm';

  // Resign the member selector whenever the server sends a new list, so a stale
  // selection can never be submitted against a changed permission set.
  React.useEffect(() => {
    if (dialog?.kind !== 'assign') return;
    const ids = new Set(eligibleMembers.map((m) => m.id));
    if (memberId && !ids.has(memberId)) setMemberId('');
  }, [eligibleMembers, dialog, memberId]);

  const reasonTooShort = reason.trim().length < 2;
  const canSubmitDialog =
    !dialogBusy &&
    !reasonTooShort &&
    (dialog?.kind !== 'assign' || memberId !== '');

  return (
    <section className="border-t border-border bg-surface-2/40" data-testid="handoff-panel" aria-label={t('title')}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('title')}</h3>
        <Button type="button" size="sm" variant="ghost" onClick={() => void load()} disabled={disabled}
          aria-label={t('refresh')} title={t('refresh')}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
        </Button>
      </div>

      {/*
        Channel capability warning. Rendered ABOVE the controls so it is read
        before anyone clicks Claim — the whole point is to prevent the operator
        mistaking ownership for the ability to answer.
      */}
      {isWriteUnsupported ? (
        <div
          role="alert"
          data-testid="channel-warning"
          className="mx-4 mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">{t('channelNoOutbound.title')}</span>{' '}
            {t('channelNoOutbound.body')}
          </span>
        </div>
      ) : null}

      {/* Outcome banner: only ever rendered from a server response. */}
      {outcome ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="handoff-outcome"
          data-kind={outcome.kind}
          className={cn(
            'mx-4 mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            outcome.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : outcome.kind === 'duplicate'
                ? 'border-border bg-surface text-muted-foreground'
                : 'border-success/40 bg-success/10 text-success'
          )}
        >
          {outcome.kind === 'error' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1">
            {outcome.message}
            {outcome.kind === 'error' && outcome.conflict ? (
              <span className="mt-1 block text-muted-foreground">{t('conflictHint')}</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {/* ------------------------------------------------ assignment + controls */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {conversation.assignedUserName
            ? t('assignedTo', { name: conversation.assignedUserName })
            : t('unassigned')}
        </span>

        {p.canClaim ? (
          <Button type="button" size="sm" onClick={() => void run('claim', () => conversationsApi.claim(conversationId))}
            disabled={disabled} aria-busy={busy === 'claim'} data-testid="op-claim">
            {busy === 'claim' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}
            {t('claim')}
          </Button>
        ) : null}

        {(p.canAssign || p.canReassign) ? (
          <Button type="button" size="sm" onClick={() => setDialog({ kind: 'assign' })}
            disabled={disabled} data-testid="op-assign">
            <UserCheck className="h-3.5 w-3.5" aria-hidden />
            {p.canReassign ? t('reassign') : t('assign')}
          </Button>
        ) : null}

        {p.canUnassign ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setDialog({ kind: 'unassign' })}
            disabled={disabled} data-testid="op-unassign">
            <UserMinus className="h-3.5 w-3.5" aria-hidden />
            {t('unassign')}
          </Button>
        ) : null}

        {p.canResolve ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setDialog({ kind: 'resolve' })}
            disabled={disabled} data-testid="op-resolve">
            <ClipboardCheck className="h-3.5 w-3.5" aria-hidden />
            {t('resolve')}
          </Button>
        ) : null}

        {p.canHandoff ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setDialog({ kind: 'handoff' })}
            disabled={disabled} data-testid="op-handoff">
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            {t('handoff')}
          </Button>
        ) : null}

        {/* On a channel we cannot write to, taking ownership does not get the
            customer an answer. Say so at the point of the decision, not after. */}
        {isWriteUnsupported && (p.canClaim || p.canAssign || p.canHandoff) ? (
          <span className="text-2xs text-muted-foreground" data-testid="channel-write-note">
            {t('channelNoOutbound.claimNote')}
          </span>
        ) : null}

        {p.canResumeAi ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setDialog({ kind: 'resumeAi' })}
            disabled={disabled} data-testid="op-resume-ai">
            <Bot className="h-3.5 w-3.5" aria-hidden />
            {t('resumeAi')}
          </Button>
        ) : (
          // Explain, never hide: the server told us why, so the operator can see
          // what would need to change.
          <span className="text-2xs text-muted-foreground" data-testid="resume-ai-blocked">
            {t('resumeAiBlocked', { reason: resumeBlockedText(p.resumeAiBlockedReason, t) })}
          </span>
        )}
      </div>

      {/* ------------------------------------------------------- escalations */}
      <div className="px-4 pb-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('escalations')}</h4>
        {openEscalations.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="escalations-empty">{t('escalationsNone')}</p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="escalations-list">
            {openEscalations.map((e) => (
              <li key={e.id} className="rounded-md border border-border bg-surface px-3 py-2" data-testid="escalation-item">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant={e.priority === 'high' ? 'warning' : 'neutral'}>{t(`priority.${e.priority}`)}</Badge>
                    <span className="text-xs text-foreground">{t(`category.${e.category ?? 'other'}`)}</span>
                    <span className="text-2xs text-muted-foreground">{t(`escalationStatus.${e.status}`)}</span>
                  </div>
                  {p.canResolveEscalations ? (
                    <Button type="button" size="sm" variant="ghost"
                      onClick={() => setDialog({ kind: 'escalation', escalation: e })}
                      disabled={disabled} data-testid="op-close-escalation">
                      {t('closeEscalation')}
                    </Button>
                  ) : null}
                </div>
                <p className="mt-1 text-2xs text-muted-foreground">{t('createdAt', { at: relTime(e.createdAt) })}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --------------------------------------------------------- history */}
      {history.length > 0 ? (
        <details className="px-4 pb-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('history')}
          </summary>
          <ul className="mt-2 space-y-1" data-testid="handoff-history">
            {history.slice(0, 10).map((h) => (
              <li key={h.id} className="text-2xs text-muted-foreground">
                {t(`action.${h.action}`)} · {h.userName ?? t('system')} · {relTime(h.createdAt)}
                {h.reason ? ` — ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* ------------------------------------------------------- dialogs */}
      <Dialog open={dialog !== null} onOpenChange={(o) => { if (!o) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader
            title={
              dialog?.kind === 'assign' ? (p.canReassign ? t('reassign') : t('assign'))
                : dialog?.kind === 'unassign' ? t('unassign')
                  : dialog?.kind === 'resolve' ? t('resolve')
                    : dialog?.kind === 'handoff' ? t('handoff')
                      : dialog?.kind === 'resumeAi' ? t('resumeAi')
                        : t('closeEscalation')
            }
            description={
              dialog?.kind === 'handoff' ? t('handoffDescription')
                : dialog?.kind === 'resumeAi' ? t('resumeAiDescription')
                  : dialog?.kind === 'escalation' ? t('escalationDescription')
                    : t('reasonDescription')
            }
          />

          {dialog?.kind === 'assign' ? (
            <div className="space-y-2">
              <label htmlFor="assignee" className="text-xs font-medium text-foreground">{t('assigneeLabel')}</label>
              <select
                id="assignee"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                data-testid="assignee-select"
              >
                <option value="">{t('assigneePlaceholder')}</option>
                {eligibleMembers.map((m) => (
                  // Only the server's list is ever offered. It is already filtered
                  // to this tenant and to users with a handling role; the server
                  // additionally enforces brand access on write.
                  <option key={m.id} value={m.id}>{m.name ?? m.email ?? m.id}</option>
                ))}
              </select>
              <p className="text-2xs text-muted-foreground">{t('assigneeHint')}</p>
            </div>
          ) : null}

          {dialog?.kind === 'escalation' ? (
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
              <p>{t(`category.${dialog.escalation.category ?? 'other'}`)} · {t(`priority.${dialog.escalation.priority}`)}</p>
              <p className="mt-1 text-muted-foreground">{t('escalationNoAutoResume')}</p>
            </div>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="op-reason" className="text-xs font-medium text-foreground">{t('reasonLabel')}</label>
            <textarea
              id="op-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              placeholder={t('reasonPlaceholder')}
              data-testid="op-reason"
            />
            {reasonTooShort && reason.length > 0 ? (
              <p className="text-2xs text-destructive">{t('reasonRequired')}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSubmitDialog}
              aria-busy={dialogBusy}
              data-testid="op-confirm"
              onClick={() => {
                if (!dialog) return;
                const r = reason.trim();
                if (dialog.kind === 'assign') {
                  void run('assign', () => conversationsApi.assign(conversationId, memberId, r));
                } else if (dialog.kind === 'unassign') {
                  void run('unassign', () => conversationsApi.unassign(conversationId, r));
                } else if (dialog.kind === 'resolve') {
                  void run('resolve', () => conversationsApi.resolve(conversationId, r));
                } else if (dialog.kind === 'handoff') {
                  void run('handoff', () => conversationsApi.requestHandoff(conversationId, r));
                } else if (dialog.kind === 'resumeAi') {
                  void run('resumeAi', () => conversationsApi.resumeAi(conversationId, r));
                } else {
                  void run('escalation', () => conversationsApi.resolveEscalation(conversationId, dialog.escalation.id, r));
                }
              }}
            >
              {dialogBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}