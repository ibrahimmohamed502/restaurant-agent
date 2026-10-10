'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Radio, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, PageLoading } from '@/components/ui/states';
import { channelsApi, type ChannelInfo } from '@/lib/api';
import { cn } from '@/lib/utils';

const HEALTH_TONE: Record<string, string> = {
  ok: 'border-success/30 bg-success/10 text-success',
  degraded: 'border-warning/30 bg-warning/10 text-warning',
  down: 'border-destructive/30 bg-destructive/10 text-destructive'
};

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export default function ChannelsPage() {
  const t = useTranslations('channels');
  const tc = useTranslations('common');

  const [items, setItems] = React.useState<ChannelInfo[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setItems(await channelsApi.list());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav')} breadcrumb={<BackButton />} />
        <PageLoading />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav')} breadcrumb={<BackButton />} />
        <ErrorState title={t('errors.title')} description={t('errors.description')} actionLabel={tc('retry')} onAction={load} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav')}
        description={t('description')}
        breadcrumb={<BackButton />}
        actions={
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {tc('retry')}
          </Button>
        }
      />

      {(items ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <Radio className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium text-foreground">{t('empty.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('empty.description')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-start font-medium">{t('table.channel')}</th>
                <th className="hidden px-4 py-2.5 text-start font-medium sm:table-cell">{t('table.provider')}</th>
                <th className="hidden px-4 py-2.5 text-start font-medium md:table-cell">{t('table.brand')}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t('table.status')}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t('table.health')}</th>
                <th className="hidden px-4 py-2.5 text-end font-medium sm:table-cell">{t('table.lastEvent')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(items ?? []).map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Radio className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">{c.displayName ?? c.provider}</span>
                        {c.externalId ? <span className="block truncate text-2xs text-muted-foreground" dir="ltr">{c.externalId}</span> : null}
                      </span>
                    </span>
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell" dir="ltr">{c.provider}</td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">{c.brandName ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn(
                      'inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-medium',
                      c.status === 'active' ? 'border-success/30 bg-success/10 text-success' : 'border-border bg-surface-2 text-muted-foreground'
                    )}>
                      {c.status === 'active' ? t('statusActive') : c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {c.health ? (
                      <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-medium', HEALTH_TONE[c.health] ?? 'border-border bg-surface-2 text-muted-foreground')}>
                        {t(`health.${c.health}` as 'health.ok')}
                      </span>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="hidden px-4 py-2.5 text-end text-xs text-muted-foreground sm:table-cell">{timeAgo(c.lastEventAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Radio className="h-3.5 w-3.5" aria-hidden /> {t('readonlyNote')}
      </p>
    </div>
  );
}
