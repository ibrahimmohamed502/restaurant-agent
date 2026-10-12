'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Activity,
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
  // never let an unsettled request pin the UI forever — guaranteed terminal state
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let r: Response;
  try {
    r = await fetch('/api/v1/dashboard', { credentials: 'include', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

/** Counts a real value up to its target once it arrives (no fabricated data). */
function useCountUp(target: number, durationMs = 650): number {
  const [value, setValue] = React.useState(0);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  React.useEffect(() => {
    if (reduced || !Number.isFinite(target)) { setValue(target); return; }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, reduced]);
  return value;
}

/* -------------------------------------------------------------- KPI cards */

function KpiCard({ icon: Icon, label, value, hint, accent, index }: { icon: typeof Inbox; label: string; value: number; hint?: string; accent?: boolean; index?: number }) {
  const shown = useCountUp(value);
  return (
    <div className={cn(
      'group relative overflow-hidden rounded-lg border border-border bg-surface p-4 shadow-sm transition-[box-shadow,transform] duration-[--dur-base] ease-[--ease-out] hover:-translate-y-px hover:shadow-md enter-up',
      index ? `stagger-${index}` : undefined
    )}>
      {accent ? <span className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-e from-transparent via-primary to-transparent" aria-hidden /> : null}
      <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.03] to-transparent opacity-0 transition-opacity duration-[--dur-base] group-hover:opacity-100" aria-hidden />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{shown}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-secondary-foreground transition-colors duration-[--dur-base] group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="h-4 w-4 transition-transform duration-[--dur-base] group-hover:scale-110" aria-hidden />
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
  const t = useTranslations('dashboard');
  const tone = unavailable ? 'off' : attention || !ok ? 'warn' : 'ok';
  const text = unavailable ? t('statusUnavailable') : tone === 'ok' ? t('statusHealthy') : t('statusAttention');
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

function ExecutiveHeader({ data, greeting, welcome }: { data: DashboardData; greeting: string; welcome: string }) {
  const t = useTranslations('dashboard');
  return (
    <section className="enter-up shine-sweep relative overflow-hidden rounded-lg border border-border bg-gradient-to-b from-surface-2 to-surface p-5 shadow-sm">
      {/* subtle local cacao-arcs motif (no external artwork, decoration only) */}
      <svg className="pointer-events-none absolute inset-y-0 end-0 hidden h-full w-1/3 text-primary/[0.07] lg:block" viewBox="0 0 200 120" fill="none" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <circle key={i} cx={170 - i * 26} cy={100 - i * 14} r={70 + i * 8} stroke="currentColor" strokeWidth="1" />
        ))}
        <path d="M120 96c-8-10-13-20-13-31 0-16 10-27 22-27 5 0 9 2 11 4 2-2 6-4 11-4 12 0 22 11 22 27 0 11-5 21-13 31l-20 12z" fill="currentColor" opacity="0.5" />
      </svg>
      <div className="absolute inset-y-0 end-0 hidden w-1/3 bg-gradient-to-l from-primary/5 to-transparent lg:block" aria-hidden />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('overview')}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{greeting}</h1>
          <p className="mt-1 max-w-xl text-[13px] text-secondary-foreground">{welcome}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            {t('knowledgeVersion', { version: data.knowledge.version ?? '—' })}
          </span>
          <Button size="sm" variant="secondary" className="gap-1.5" asChild>
            <Link href="/inbox"><Inbox className="h-3.5 w-3.5" aria-hidden /> {t('openInbox')}</Link>
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
          <span className="ring-brand flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-secondary-foreground">
            {(c.customerName ?? '?').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground">{c.customerName ?? t('overview')}</p>
            <p className="truncate text-xs text-muted-foreground">{c.lastText ?? ''}</p>
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-2xs text-muted-foreground">
              {c.provider === 'meta_dm' ? t('dm') : t('comment')}
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
      <ExecutiveHeader data={data} greeting={greeting} welcome={t('welcome')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={MessageSquare} label={t('conversations')} value={data.kpis.conversations} hint={t('allTime')} accent index={1} />
        <KpiCard icon={Inbox} label={t('messages')} value={data.kpis.messages} hint={t('inboundOutbound')} index={2} />
        <KpiCard icon={Radio} label={t('activeChannels')} value={data.kpis.active_channels} hint={t('routedChannels')} index={3} />
        <KpiCard icon={Activity} label={t('escalations')} value={data.kpis.escalations} hint={t('needsAttention')} index={4} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="enter-up stagger-2 lg:col-span-2"
          title={t('recentConversations')}
          subtitle={t('latestActivity')}
          action={<Link href="/inbox" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t('viewAll')}<ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden /></Link>}
        >
          <RecentConversations rows={data.conversations} />
        </Panel>

        <div className="space-y-4">
          <Panel className="enter-up stagger-3" title={t('platformStatus')} subtitle={t('verifiedState')}>
            <ul className="divide-y divide-border">
              <StatusRow label={t('routedChannels')} ok detail={t('dbScoped')} />
              <StatusRow label={t('aiAgent')} ok={Boolean(data.aiAgent?.is_active)} detail={data.aiAgent?.name ?? t('notConfigured')} />
              <StatusRow label={t('knowledge')} ok={Boolean(data.knowledge.version)} detail={data.knowledge.version ? t('knowledgeVersion', { version: data.knowledge.version }) : t('none')} />
              {data.queue.available ? (
                <StatusRow label={t('queueWorker')} ok={!data.queue.failed} detail={t('queueFailed', { count: data.queue.failed ?? 0 })} attention={Boolean(data.queue.failed)} />
              ) : (
                <StatusRow label={t('queueWorker')} unavailable />
              )}
            </ul>
          </Panel>

          <Panel className="enter-up stagger-4" title={t('knowledge')} subtitle={t('currentBrand')} action={<Link href="/knowledge" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t('manage')}</Link>}>
            <div className="flex items-center gap-3 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <BookOpen className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t('knowledgeVersion', { version: data.knowledge.version ?? '—' })}</p>
                <p className="text-xs text-muted-foreground">{data.knowledge.publishedAt ? `${t('published')} ${timeAgo(data.knowledge.publishedAt)}` : t('notPublished')}</p>
              </div>
            </div>
          </Panel>

          <Panel className="enter-up stagger-5" title={t('quickActions')}>
            <QuickActions />
          </Panel>
        </div>
      </div>

      {data.aiAgent ? (
        <Panel className="enter-up stagger-5" title={t('aiAgent')} subtitle={data.aiAgent.name}>
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
