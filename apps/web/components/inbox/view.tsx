'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Inbox as InboxIcon,
  MessageSquare,
  UserPlus,
  UserCheck,
  Users,
  Send,
  StickyNote,
  Bot,
  AlertCircle,
  Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/states';
import { ReplySources } from './reply-sources';
import { InternalNotesPanel } from './notes-panel';
import { authApi, conversationsApi, ensureCsrfToken } from '@/lib/api';
import type {
  ConversationListItem,
  ConversationDetail,
  InternalNote,
  EligibleMember,
  ConversationState
} from '@/lib/api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'timeline' | 'notes';

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

const FILTERS = ['all', 'needs_human', 'assigned_me', 'resolved'] as const;

export function InboxView() {
  const t = useTranslations('inbox');
  const tc = useTranslations('common');
  const router = useRouter();

  const [items, setItems] = React.useState<ConversationListItem[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ConversationDetail | null>(null);
  const [notes, setNotes] = React.useState<InternalNote[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]>('all');
  const [tab, setTab] = React.useState<Tab>('timeline');
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [isAdmin, setIsAdmin] = React.useState(false);

  const [assignOpen, setAssignOpen] = React.useState(false);
  const [members, setMembers] = React.useState<EligibleMember[]>([]);
  const [handoffOpen, setHandoffOpen] = React.useState(false);
  const [handoffReason, setHandoffReason] = React.useState('');
  const [resumeOpen, setResumeOpen] = React.useState(false);
  const [resumeReason, setResumeReason] = React.useState('');

  const [replyText, setReplyText] = React.useState('');
  const [replyBusy, setReplyBusy] = React.useState(false);
  const [replyError, setReplyError] = React.useState<string | null>(null);
  const [replyOk, setReplyOk] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await conversationsApi.list();
        if (!alive) return;
        setItems(rows);
        setError(null);
        authApi.me().then((me) => { if (alive) setIsAdmin((me?.roles ?? []).includes('Company Admin')); }).catch(() => {});
      } catch {
        if (alive) setError('failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const loadDetail = React.useCallback(async (id: string) => {
    setDetailLoading(true);
    setActionError(null);
    try {
      const [d, n] = await Promise.all([conversationsApi.detail(id), conversationsApi.notes(id).catch(() => [])]);
      setDetail(d);
      setNotes(n);
    } catch {
      setDetail(null);
      setNotes([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!selected) { setDetail(null); setNotes([]); return; }
    void loadDetail(selected);
  }, [selected, loadDetail]);

  /** Run a Stage 7 action, then refresh list + detail from the server. */
  const runAction = React.useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await ensureCsrfToken();
        await fn();
        const rows = await conversationsApi.list();
        setItems(rows);
        if (selected) await loadDetail(selected);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null;
        setActionError(
          code === 'HANDOFF_CONFLICT'
            ? t('conflict')
            : (e instanceof Error && e.message) || t('actionFailed')
        );
      } finally {
        setBusy(false);
      }
    },
    [selected, loadDetail, t]
  );

  const filtered = React.useMemo(() => {
    if (!items) return [];
    if (filter === 'needs_human') return items.filter((c) => c.needsHuman);
    if (filter === 'assigned_me') {
      // "Assigned to me" is a server-side concept; the list carries the assignee.
      return items.filter((c) => c.state === 'ASSIGNED' || c.state === 'HUMAN_ACTIVE');
    }
    if (filter === 'resolved') return items.filter((c) => c.state === 'RESOLVED');
    return items;
  }, [items, filter]);

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-72 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }
  if (error) {
    return (
      <ErrorState
        title={t('loadError')}
        description={t('loadErrorDescription')}
        actionLabel={t('retry')}
        onAction={() => window.location.reload()}
      />
    );
  }

  const perms = detail?.permissions;
  const conv = detail?.conversation;
  const canReply = Boolean(perms?.canReply) && Boolean(conv?.needsHuman);

  return (
    <div className="space-y-4">
      {/* ------------------------------- filters ------------------------------- */}
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={t('filters')}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
              filter === f
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-surface text-muted-foreground hover:bg-muted/60'
            )}
          >
            {t(`filter.${f}`)}
            {f === 'needs_human' && items?.some((c) => c.needsHuman)
              ? <span className="ms-1.5 rounded-full bg-destructive px-1.5 text-2xs text-destructive-foreground">
                  {items.filter((c) => c.needsHuman).length}
                </span>
              : null}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        {/* ----------------------------- conversation list ----------------------------- */}
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          {filtered.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted-foreground">{t('emptyFilter')}</li>
          ) : null}
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors',
                  selected === c.id ? 'bg-primary/10' : 'hover:bg-muted/60'
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-secondary-foreground">
                  {(c.customerName ?? '?').trim().charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">{c.customerName ?? 'Customer'}</p>
                  <p className="truncate text-xs text-muted-foreground">{c.lastText ?? ''}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <StateBadge state={c.state} label={t(`state.${c.state}`)} />
                    {c.needsHuman ? <NeedsHumanBadge label={t('needsHuman')} /> : null}
                    {c.assignedUserName ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground">
                        <UserCheck className="h-3 w-3" aria-hidden />
                        {c.assignedUserName}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-2xs text-muted-foreground">{relTime(c.lastMessageAt)}</span>
                  <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground">
                    {c.provider === 'meta_dm' ? t('dm') : t('comment')}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>

        {/* ------------------------------- detail ------------------------------- */}
        <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          {!selected ? (
            <div className="flex h-full min-h-64 items-center justify-center px-6 py-16 text-center">
              <div>
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-surface-2 text-muted-foreground">
                  <MessageSquare className="h-5 w-5" aria-hidden />
                </span>
                <p className="mt-3 text-sm text-muted-foreground">{t('selectConversation')}</p>
              </div>
            </div>
          ) : detailLoading || !detail ? (
            <div className="space-y-3 p-4" aria-busy="true">
              <div className="h-5 w-40 animate-pulse rounded bg-muted" />
              <div className="h-16 animate-pulse rounded bg-muted" />
              <div className="h-16 animate-pulse rounded bg-muted" />
            </div>
          ) : (
            <>
              <header className="space-y-3 border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {conv?.customerName ?? 'Customer'}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {conv?.provider === 'meta_dm' ? t('dm') : t('comment')}
                      {conv?.brandName ? ` · ${conv.brandName}` : ''}
                      {conv?.channelName ? ` · ${conv.channelName}` : ''}
                      {conv?.createdAt ? ` · ${relTime(conv.createdAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StateBadge state={conv?.state ?? 'AI_ACTIVE'} label={t(`state.${conv?.state}`)} />
                    {conv?.needsHuman ? <NeedsHumanBadge label={t('needsHuman')} /> : null}
                    {conv?.state === 'AI_ACTIVE' ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground">
                        <Bot className="h-3 w-3" aria-hidden />
                        {t('aiHandling')}
                      </span>
                    ) : null}
                  </div>
                </div>

                {actionError ? (
                  <p className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                    {actionError}
                  </p>
                ) : null}

                {/* ------------------------------ actions ------------------------------ */}
                <div className="flex flex-wrap items-center gap-2">
                  {perms?.canRequestHandoff && conv?.state === 'AI_ACTIVE' ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setHandoffOpen(true)}>
                      <UserPlus className="me-1.5 h-3.5 w-3.5" aria-hidden />
                      {t('requestHuman')}
                    </Button>
                  ) : null}

                  {perms?.canClaim && conv?.needsHuman && !conv?.assignedUserId ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => runAction(() => conversationsApi.claim(selected!, t('claimReason')))}
                    >
                      <UserCheck className="me-1.5 h-3.5 w-3.5" aria-hidden />
                      {t('assignToMe')}
                    </Button>
                  ) : null}

                  {perms?.canAssignOthers && conv?.needsHuman ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={async () => {
                        setAssignOpen(true);
                        setMembers(await conversationsApi.eligibleMembers().catch(() => []));
                      }}
                    >
                      <Users className="me-1.5 h-3.5 w-3.5" aria-hidden />
                      {t('assign')}
                    </Button>
                  ) : null}

                  {perms?.canUnassign && conv?.assignedUserId ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => runAction(() => conversationsApi.unassign(selected!, t('unassignReason')))}
                    >
                      {t('unassign')}
                    </Button>
                  ) : null}

                  {perms?.canResolve && conv?.needsHuman ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => runAction(() => conversationsApi.resolve(selected!))}
                    >
                      {t('markResolved')}
                    </Button>
                  ) : null}

                  {perms?.canResumeAi && conv?.needsHuman ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setResumeOpen(true)}>
                      <Bot className="me-1.5 h-3.5 w-3.5" aria-hidden />
                      {t('resumeAi')}
                    </Button>
                  ) : null}

                  {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
                </div>
              </header>

              {/* -------------------------------- tabs -------------------------------- */}
              <div className="flex items-center gap-1 border-b border-border px-4" role="tablist" aria-label={t('tabs')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'timeline'}
                  onClick={() => setTab('timeline')}
                  className={cn(
                    '-mb-px border-b-2 px-3 py-2 text-xs font-medium',
                    tab === 'timeline' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
                  )}
                >
                  {t('timeline')}
                </button>
                {perms?.canReadNotes ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'notes'}
                    onClick={() => setTab('notes')}
                    className={cn(
                      '-mb-px border-b-2 px-3 py-2 text-xs font-medium',
                      tab === 'notes' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
                    )}
                  >
                    <StickyNote className="me-1.5 inline-block h-3.5 w-3.5" aria-hidden />
                    {t('notes')}
                    {notes.length ? <span className="ms-1.5 text-2xs opacity-70">({notes.length})</span> : null}
                  </button>
                ) : null}
              </div>

              {tab === 'timeline' ? (
                <ul className="max-h-[46vh] space-y-3 overflow-y-auto p-4">
                  {detail.messages.map((m, i) => (
                    <li key={m.id ?? i} className={cn('flex', m.direction === 'inbound' ? 'justify-start' : 'justify-end')}>
                      <div
                        className={cn(
                          'max-w-[80%] rounded-lg px-3 py-2 text-[13px] shadow-sm',
                          m.direction === 'inbound' ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground'
                        )}
                      >
                        <p className="whitespace-pre-wrap">{m.text ?? ''}</p>
                        <p className="mt-1 flex items-center gap-2 text-2xs opacity-70">
                          <span>{relTime(m.createdAt)}</span>
                          {m.senderType === 'ai' ? <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" aria-hidden />{t('sender.ai')}</span> : null}
                          {m.senderType === 'employee' ? <span>{t('sender.employee')}</span> : null}
                          {m.deliveryStatus === 'failed' ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => runAction(() => conversationsApi.retryMessage(selected!, m.id))}
                              className="inline-flex items-center gap-1 underline decoration-destructive"
                            >
                              {t('failedRetry')}
                            </button>
                          ) : null}
                        </p>
                        {/* Stage 6: admin-only reply sources (outbound AI messages only) */}
                        {m.direction !== 'inbound' && m.senderType === 'ai' && m.id ? (
                          <ReplySources messageId={m.id} canView={isAdmin} />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <InternalNotesPanel
                  notes={notes}
                  canCreate={Boolean(perms?.canCreateNotes)}
                  busy={busy}
                  onCreate={async (body) => {
                    await ensureCsrfToken();
                    const created = await conversationsApi.addNote(selected!, body);
                    setNotes((prev) => [created, ...prev]);
                  }}
                  onDelete={async (noteId) => {
                    await ensureCsrfToken();
                    await conversationsApi.deleteNote(selected!, noteId);
                    setNotes((prev) => prev.filter((n) => n.id !== noteId));
                  }}
                />
              )}

              {/* ------------------------------ human composer ------------------------------ */}
              {canReply ? (
                <form
                  className="space-y-2 border-t border-border p-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const text = replyText.trim();
                    if (!text || replyBusy) return;
                    setReplyBusy(true);
                    setReplyError(null);
                    setReplyOk(null);
                    try {
                      await ensureCsrfToken();
                      const result = await conversationsApi.reply(
                        selected!,
                        text,
                        `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                      );
                      if (result.duplicate) {
                        setReplyOk(t('duplicateIgnored'));
                      } else if (result.deliveryStatus === 'sent') {
                        setReplyOk(t('replySent'));
                        setReplyText('');
                      } else {
                        setReplyError(t('replyFailed'));
                      }
                      const rows = await conversationsApi.list();
                      setItems(rows);
                      await loadDetail(selected!);
                    } catch (e2) {
                      setReplyError(e2 instanceof Error && e2.message ? e2.message : t('replyFailed'));
                    } finally {
                      setReplyBusy(false);
                    }
                  }}
                >
                  <label className="block text-2xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="human-reply">
                    {t('humanReply')}
                  </label>
                  <textarea
                    id="human-reply"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    rows={2}
                    maxLength={4000}
                    placeholder={t('humanReplyPlaceholder')}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {replyError ? (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                      {replyError}
                    </p>
                  ) : null}
                  {replyOk ? <p className="text-xs text-primary">{replyOk}</p> : null}
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-2xs text-muted-foreground">{t('humanReplyHint')}</p>
                    <Button type="submit" size="sm" disabled={replyBusy || !replyText.trim()}>
                      <Send className="me-1.5 h-3.5 w-3.5" aria-hidden />
                      {replyBusy ? t('sending') : t('send')}
                    </Button>
                  </div>
                </form>
              ) : null}
            </>
          )}
        </section>
      </div>

      {/* ------------------------------- dialogs ------------------------------- */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader title={t('assignTitle')} description={t('assignDescription')} />
          <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
            {members.length === 0 ? <li className="px-2 py-4 text-sm text-muted-foreground">{t('noEligibleMembers')}</li> : null}
            {members.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md px-2 py-2 text-start text-[13px] hover:bg-muted/60"
                  onClick={async () => {
                    setAssignOpen(false);
                    await runAction(() => conversationsApi.assign(selected!, m.id, t('assignReason')));
                  }}
                >
                  <span className="font-medium text-foreground">{m.name ?? m.email}</span>
                  <span className="text-2xs text-muted-foreground">{(m.roles ?? []).join(', ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={handoffOpen} onOpenChange={setHandoffOpen}>
        <DialogContent>
          <DialogHeader title={t('requestHumanTitle')} description={t('requestHumanDescription')} />
          <textarea
            value={handoffReason}
            onChange={(e) => setHandoffReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder={t('handoffReasonPlaceholder')}
            className="mt-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setHandoffOpen(false)}>{tc('cancel')}</Button>
            <Button
              size="sm"
              disabled={busy || handoffReason.trim().length < 2}
              onClick={async () => {
                setHandoffOpen(false);
                const reason = handoffReason.trim();
                setHandoffReason('');
                await runAction(() => conversationsApi.requestHandoff(selected!, reason));
              }}
            >
              {t('confirmHandoff')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={resumeOpen} onOpenChange={setResumeOpen}>
        <DialogContent>
          <DialogHeader title={t('resumeAiTitle')} description={t('resumeAiDescription')} />
          <textarea
            value={resumeReason}
            onChange={(e) => setResumeReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder={t('resumeReasonPlaceholder')}
            className="mt-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setResumeOpen(false)}>{tc('cancel')}</Button>
            <Button
              size="sm"
              disabled={busy || resumeReason.trim().length < 2}
              onClick={async () => {
                setResumeOpen(false);
                const reason = resumeReason.trim();
                setResumeReason('');
                await runAction(() => conversationsApi.resumeAi(selected!, reason));
              }}
            >
              {t('confirmResume')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* small presentational helpers                                       */
/* ------------------------------------------------------------------ */

export function StateBadge({ state, label }: { state: ConversationState; label: string }) {
  const tone =
    state === 'AI_ACTIVE'
      ? 'border-border bg-surface-2 text-muted-foreground'
      : state === 'RESOLVED'
        ? 'border-primary/30 bg-primary/10 text-primary'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return (
    <span className={cn('rounded-md border px-1.5 py-0.5 text-2xs font-medium', tone)}>
      {label}
    </span>
  );
}

export function NeedsHumanBadge({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-2xs font-medium text-destructive">
      {label}
    </span>
  );
}
