'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Inbox as InboxIcon, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils';

type Conversation = {
  id: string;
  customerName: string | null;
  provider: string | null;
  state: string | null;
  language: string | null;
  messageCount: number;
  lastText: string | null;
  lastMessageAt: string | null;
};
type Detail = {
  conversation: { id: string; customerName: string | null; provider: string | null; channelName: string | null; state: string | null; language: string | null; createdAt: string | null };
  messages: Array<{ direction: string; senderType: string; text: string | null; createdAt: string | null }>;
};

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

export function InboxView() {
  const t = useTranslations('inbox');
  const router = useRouter();
  const [items, setItems] = React.useState<Conversation[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/v1/conversations', { credentials: 'include' });
        if (r.status === 401) { router.replace('/login'); return; }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error?.message ?? 'failed');
        if (!alive) return;
        setItems(body.data ?? []);
        setError(null);
      } catch {
        if (alive) setError('failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [router]);

  React.useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let alive = true;
    setDetailLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/v1/conversations/${selected}`, { credentials: 'include' });
        const body = await r.json().catch(() => ({}));
        if (!alive) return;
        setDetail(r.ok ? body.data : null);
      } finally {
        if (alive) setDetailLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selected]);

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-72 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }
  if (error) {
    return <ErrorState title={t('loadError')} description={t('loadErrorDescription')} actionLabel={t('retry')} onAction={() => window.location.reload()} />;
  }
  if (!items || items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-6 py-16 text-center">
        <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-surface-2 text-muted-foreground">
          <InboxIcon className="h-5 w-5" aria-hidden />
        </span>
        <p className="mt-3 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('emptyDescription')}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        {items.map((c) => (
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
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">{detail.conversation.customerName ?? 'Customer'}</h2>
                <p className="text-xs text-muted-foreground">
                  {detail.conversation.provider === 'meta_dm' ? t('dm') : t('comment')} · {relTime(detail.conversation.createdAt)}
                </p>
              </div>
              <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground">{detail.conversation.state ?? ''}</span>
            </header>
            <ul className="max-h-[60vh] space-y-3 overflow-y-auto p-4">
              {detail.messages.map((m, i) => (
                <li key={i} className={cn('flex', m.direction === 'inbound' ? 'justify-start' : 'justify-end')}>
                  <div className={cn('max-w-[80%] rounded-lg px-3 py-2 text-[13px] shadow-sm', m.direction === 'inbound' ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground')}>
                    <p className="whitespace-pre-wrap">{m.text ?? ''}</p>
                    <p className="mt-1 text-2xs opacity-70">{relTime(m.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
