'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bot,
  Inbox,
  MessageSquare,
  Radio,
  Sparkles,
  Users
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ types */

export type DashboardData = {
  kpis: { conversations: number; messages: number; active_channels: number; escalations: number };
  conversations: Array<{
    id: string;
    customerName: string | null;
    provider: string | null;
    state: string | null;
    language: string | null;
    lastText: string | null;
    lastMessageAt: string | null;
  }>;
  knowledge: { brandId: string | null; version: number | null; publishedAt: string | null };
  aiAgent: { id: string; name: string; is_active: boolean } | null;
  queue: { available: boolean; failed?: number; active?: number; waiting?: number };
};

/* --------------------------------------------------------------- fetchers */

async function fetchDashboard(): Promise<DashboardData> {
  const r = await fetch('/api/v1/dashboard', { credentials: 'include' });
  if (r.status === 401) throw new Error('unauthenticated');
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ?? 'request failed');
  return body.data as DashboardData;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/* -------------------------------------------------------------- KPI cards */

function KpiCard({ icon: Icon, label, value, hint, accent }: { icon: typeof Inbox; label: string; value: string | number; hint?: string; accent?: boolean }) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-surface p-4 shadow-sm transition-[box-shadow,transform] duration-[--dur-base] ease-[--ease-out] hover:-translate-y-px hover:shadow-md">
      {accent ? <span className="absolute inset-x-0 top-0 h-0.5 bg-primary/60" aria-hidden /> : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-secondary-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ section shell */

function Panel({ title, subtitle, action, children, className }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-lg border border-border bg-surface shadow-sm', className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'off' }) {
  const cls = { ok: 'bg-success', warn: 'bg-warning', off: 'bg-muted-foreground/40' }[tone];
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', cls)} aria-hidden />;
}

function StatusRow({ label, ok, detail, attention, unavailable }: { label: string; ok?: boolean; detail?: string; attention?: boolean; unavailable?: boolean }) {
  const tone = unavailable ? 'off' : attention || !ok ? 'warn' : 'ok';
  const text = unavailable ? 'Unavailable' : ok ? 'Healthy' : 'Attention';
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
      <span className="flex items-center gap-2.5">
        <StatusDot tone={tone} />
        <span className="text-foreground">{label}</span>
      </span>
      <span className="flex items-center gap-2 text-muted-foreground">
        {detail ? <span className="hidden sm:inline">{detail}</span> : null}
        <span className={cn('rounded-md px-1.5 py-0.5 text-2xs font-medium', tone === 'ok' ? 'bg-success/10 text-success' : tone === 'warn' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground')}>{text}</span>
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ blocks */

function ExecutiveHeader({ data, greeting }: { data: DashboardData; greeting: string }) {
  const t = useTranslations('dashboard');
  return (
    <section className="enter-up relative overflow-hidden rounded-lg border border-border bg-gradient-to-b from-surface-2 to-surface p-5 shadow-sm">
      <div className="absolute inset-y-0 end-0 hidden w-1/3 bg-gradient-to-l from-primary/5 to-transparent lg:block" aria-hidden />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('overview')}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{greeting}</h1>
          <p className="mt-1 max-w-xl text-[13px] text-secondary-foreground">
            {data.kpis.conversations} conversations · {data.kpis.messages} messages · {data.kpis.active_channels} active channels
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-secondary-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
            Knowledge v{data.knowledge.version ?? '—'}
          </span>
          <Button size="sm" variant="secondary" className="gap-1.5" asChild>
            <Link href="/inbox"><Inbox className="h-3.5 w-3.5" aria-hidden /> Inbox</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function RecentConversations({ rows }: { rows: DashboardData['conversations'] }) {
  const t = useTranslations('dashboard');
  if (!rows.length) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">{t('noConversations')}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((c) => (
        <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-secondary-foreground">
            {(c.customerName ?? '?').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground">{c.customerName ?? 'Customer'}</p>
            <p className="truncate text-xs text-muted-foreground">{c.lastText ?? ''}</p>
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground">
              {c.provider === 'meta_dm' ? 'DM' : 'Comment'}
            </span>
            <span className="text-2xs text-muted-foreground">{timeAgo(c.lastMessageAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function QuickActions() {
  const t = useTranslations('dashboard');
  const items = [
    { label: t('openInbox'), href: '/inbox', icon: Inbox },
    { label: t('manageKnowledge'), href: '/knowledge', icon: BookOpen },
    { label: t('viewChannels'), href: '/channels', icon: Radio },
    { label: t('manageTeam'), href: '/team', icon: Users }
  ];
  return (
    <ul className="grid grid-cols-2 gap-2 p-3">
      {items.map((it) => (
        <li key={it.href}>
          <Link
            href={it.href}
            className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-[13px] font-medium text-secondary-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
          >
            <it.icon className="h-4 w-4" aria-hidden />
            <span className="truncate">{it.label}</span>
            <ArrowRight className="ms-auto h-3.5 w-3.5 text-muted-foreground rtl:rotate-180" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- page */

export function DashboardView() {
  const t = useTranslations('dashboard');
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDashboard());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'failed';
      setError(message === 'unauthenticated' ? 'unauthenticated' : 'failed');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-64 lg:col-span-2" /><Skeleton className="h-64" /></div>
      </div>
    );
  }

  if (error || !data) {
    if (error === 'unauthenticated') {
      return <ErrorState title={t('signInRequired')} description={t('signInDescription')} actionLabel={t('retry')} onAction={load} />;
    }
    return <ErrorState title={t('loadError')} description={t('loadErrorDescription')} actionLabel={t('retry')} onAction={load} />;
  }

  const greeting = t('greeting');

  return (
    <div className="space-y-5">
      <ExecutiveHeader data={data} greeting={greeting} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={MessageSquare} label={t('conversations')} value={data.kpis.conversations} hint={t('allTime')} accent />
        <KpiCard icon={Inbox} label={t('messages')} value={data.kpis.messages} hint={t('inboundOutbound')} />
        <KpiCard icon={Radio} label={t('activeChannels')} value={data.kpis.active_channels} hint={t('routedChannels')} />
        <KpiCard icon={Activity} label={t('escalations')} value={data.kpis.escalations} hint={t('needsAttention')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title={t('recentConversations')}
          subtitle={t('latestActivity')}
          action={<Link href="/inbox" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t('viewAll')}<ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden /></Link>}
        >
          <RecentConversations rows={data.conversations} />
        </Panel>

        <div className="space-y-4">
          <Panel title={t('platformStatus')} subtitle={t('verifiedState')}>
            <ul className="divide-y divide-border">
              <StatusRow label="Meta routing" ok detail="DB-scoped channel" />
              <StatusRow label="AI agent" ok={Boolean(data.aiAgent?.is_active)} detail={data.aiAgent?.name ?? 'Not configured'} />
              <StatusRow label="Knowledge published" ok={Boolean(data.knowledge.version)} detail={data.knowledge.version ? `v${data.knowledge.version}` : 'None'} />
              {data.queue.available ? (
                <StatusRow label="Queue worker" ok={!data.queue.failed} detail={`${data.queue.failed ?? 0} failed`} attention={Boolean(data.queue.failed)} />
              ) : (
                <StatusRow label="Queue worker" unavailable />
              )}
            </ul>
          </Panel>

          <Panel title={t('knowledge')} subtitle={t('currentBrand')} action={<Link href="/knowledge" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t('manage')}<ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden /></Link>}>
            <div className="flex items-center gap-3 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <BookOpen className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Version v{data.knowledge.version ?? '—'}</p>
                <p className="text-xs text-muted-foreground">{data.knowledge.publishedAt ? `${t('published')} ${timeAgo(data.knowledge.publishedAt)}` : t('notPublished')}</p>
              </div>
            </div>
          </Panel>

          <Panel title={t('quickActions')}>
            <QuickActions />
          </Panel>
        </div>
      </div>

      {data.aiAgent ? (
        <Panel title={t('aiAgent')} subtitle={data.aiAgent.name}>
          <div className="flex items-center gap-3 p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-2 text-secondary-foreground">
              <Bot className="h-4 w-4" aria-hidden />
            </span>
            <p className="text-[13px] text-secondary-foreground">{t('aiAgentActive')}</p>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
