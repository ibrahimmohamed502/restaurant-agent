'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Cable, Plug, ShieldAlert, Store } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState, PageLoading } from '@/components/ui/states';
import { companiesApi, integrationsApi, type IntegrationInfo, type ProviderInfo } from '@/lib/api';

/**
 * Stage 8 Batch 2 — integrations overview (read-only).
 *
 * Lists the channels connected to the signed-in company through
 * GET /api/v1/integrations. The server scopes the result to the session
 * tenant; the brand select is only a narrowing filter. No credential value
 * is ever received by the browser (presence + expiry only).
 *
 * Direction-aware: the document direction comes from the locale (see
 * app/layout.tsx) and all spacing/alignment uses logical utilities, so the
 * same markup reads correctly in Arabic (RTL) and English (LTR).
 */

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

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

export default function IntegrationsPage() {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');

  const [integrations, setIntegrations] = React.useState<IntegrationInfo[] | null>(null);
  const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
  const [brands, setBrands] = React.useState<Array<{ id: string; name: string }>>([]);
  const [brandId, setBrandId] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async (brand: string) => {
    setLoading(true);
    setError(false);
    try {
      const [data, brandList] = await Promise.all([
        integrationsApi.list(brand || undefined),
        companiesApi.listBrands().catch(() => [])
      ]);
      setIntegrations(data.integrations);
      setProviders(data.providers ?? []);
      setBrands(brandList.map((b) => ({ id: b.id, name: b.name })));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(brandId); }, [load, brandId]);

  const counts = React.useMemo(() => {
    const list = integrations ?? [];
    return {
      total: list.length,
      active: list.filter((i) => i.status === 'active').length,
      attention: list.filter((i) => i.health.status === 'degraded' || i.health.status === 'down' || !i.credentials.present).length,
      disabled: list.filter((i) => i.status !== 'active').length
    };
  }, [integrations]);

  const healthVariant = (status: string): 'success' | 'warning' | 'destructive' | 'neutral' => {
    if (status === 'ok') return 'success';
    if (status === 'degraded') return 'warning';
    if (status === 'down') return 'destructive';
    return 'neutral';
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('title')}
        description={t('description')}
        breadcrumb={<BackButton />}
      />

      {loading ? (
        <PageLoading />
      ) : error ? (
        <ErrorState
          title={t('loadFailedTitle')}
          description={t('loadFailedDescription')}
          actionLabel={tc('retry')}
          onAction={() => { void load(brandId); }}
        />
      ) : (
        <>
          {/* summary + brand filter */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label={t('summary.total')} value={counts.total} icon={<Cable className="h-4 w-4" aria-hidden />} />
            <SummaryTile label={t('summary.active')} value={counts.active} icon={<Plug className="h-4 w-4" aria-hidden />} tone="success" />
            <SummaryTile label={t('summary.attention')} value={counts.attention} icon={<ShieldAlert className="h-4 w-4" aria-hidden />} tone={counts.attention > 0 ? 'warning' : undefined} />
            <SummaryTile label={t('summary.disabled')} value={counts.disabled} icon={<Store className="h-4 w-4" aria-hidden />} />
          </div>

          {brands.length > 0 ? (
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="brand-filter">{t('filterByBrand')}</Label>
              <select
                id="brand-filter"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">{t('allBrands')}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          {integrations === null || integrations.length === 0 ? (
            <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {integrations.map((i) => (
                <Card key={i.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-sm">{i.displayName || i.providerLabel}</CardTitle>
                        <p className="truncate text-xs text-muted-foreground">{i.providerLabel}</p>
                      </div>
                      <Badge variant={i.status === 'active' ? 'success' : 'destructive'}>
                        {t(`statusLabels.${i.status === 'active' ? 'active' : 'disabled'}`)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2.5 text-[13px]">
                    <Row label={t('columns.brand')} value={i.brand?.name || t('noBrand')} />
                    <Row label={t('columns.health')} value={<Badge variant={healthVariant(i.health.status)}>{t(`healthLabels.${i.health.status}`)}</Badge>} />
                    <Row
                      label={t('columns.credentials')}
                      value={
                        <span className="inline-flex items-center gap-2">
                          <Badge variant={i.credentials.present ? 'success' : 'neutral'}>
                            {t(i.credentials.present ? 'credentialsLabels.present' : 'credentialsLabels.missing')}
                          </Badge>
                          {i.credentials.expiresAt ? (
                            <span className="text-xs text-muted-foreground">
                              {t('credentialsLabels.expires')} {formatDate(i.credentials.expiresAt)}
                            </span>
                          ) : null}
                        </span>
                      }
                    />
                    <Row label={t('columns.lastEvent')} value={timeAgo(i.health.lastEventAt)} />
                    {i.health.lastError ? (
                      <Row label={t('columns.lastError')} value={<span className="text-destructive">{i.health.lastError}</span>} />
                    ) : null}
                    {i.externalId ? (
                      <Row label={t('columns.externalId')} value={<span className="font-mono text-xs">{i.externalId}</span>} />
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t('readOnlyNotice')}</p>

          {providers.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('providersTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {providers.map((p) => (
                  <span key={p.key} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px]">
                    <span className="font-medium">{p.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.capabilities.comments ? t('capabilities.comments') : null}
                      {p.capabilities.comments && p.capabilities.directMessages ? ' · ' : null}
                      {p.capabilities.directMessages ? t('capabilities.directMessages') : null}
                    </span>
                  </span>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone?: 'success' | 'warning' }) {
  const toneClass = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-foreground';
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className={`inline-flex items-center gap-2 text-lg font-semibold ${toneClass}`}>
        <span className="text-muted-foreground">{icon}</span>
        {value}
      </span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-end">{value}</span>
    </div>
  );
}