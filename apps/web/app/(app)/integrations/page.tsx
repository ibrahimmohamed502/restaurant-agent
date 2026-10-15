'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Cable, CheckCircle2, CircleAlert, Clock, Plug, ShieldAlert, Store, Unplug } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState, PageLoading } from '@/components/ui/states';
import { useToast } from '@/components/ui/toaster';
import {
  companiesApi,
  integrationsApi,
  metaOAuthApi,
  type IntegrationInfo,
  type MetaPageOption,
  type ProviderInfo
} from '@/lib/api';

/**
 * Stage 8 Batch 3 — integrations workspace.
 *
 * Read-only listing (Batch 2) + Facebook Page self-service (Batch 3).
 *
 * Connection status is whatever the SERVER derived — never inferred from the
 * presence of a token in the browser. A Page is "connected" only when the
 * server confirmed both the credential and the webhook subscription.
 *
 * The OAuth flow token is handed back by the server in the URL *fragment*
 * (never a query parameter), read once on mount and immediately stripped from
 * the address bar.
 *
 * Direction-aware: all spacing/alignment uses logical utilities so the same
 * markup reads correctly in Arabic (RTL) and English (LTR).
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

type FlowState = { flowId: string; flowToken: string };

export default function IntegrationsPage() {
  const t = useTranslations('integrations');
  const tc = useTranslations('common');
  const { push } = useToast();

  const [integrations, setIntegrations] = React.useState<IntegrationInfo[] | null>(null);
  const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
  const [brands, setBrands] = React.useState<Array<{ id: string; name: string }>>([]);
  const [brandId, setBrandId] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  // connect wizard
  const [connecting, setConnecting] = React.useState(false);
  const [oauthBlocked, setOauthBlocked] = React.useState(false);
  const [flow, setFlow] = React.useState<FlowState | null>(null);
  const [pages, setPages] = React.useState<MetaPageOption[]>([]);
  const [pagesLoading, setPagesLoading] = React.useState(false);
  const [selectedPage, setSelectedPage] = React.useState<string>('');
  const [connectingPage, setConnectingPage] = React.useState(false);
  const [rowBusy, setRowBusy] = React.useState<string>('');

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

  // Read the flow token from the fragment exactly once, then scrub the URL.
  React.useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const flowId = params.get('flow');
    const token = params.get('t');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (flowId && token) setFlow({ flowId, flowToken: token });
  }, []);

  React.useEffect(() => { void load(brandId); }, [load, brandId]);

  // Load the page list as soon as a flow exists.
  React.useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    setPagesLoading(true);
    metaOAuthApi
      .pages(flow.flowId, flow.flowToken)
      .then((res) => {
        if (cancelled) return;
        setPages(res.pages ?? []);
        if (!res.pages?.length) push({ title: t('wizard.noPages'), variant: 'destructive' });
      })
      .catch(() => {
        if (!cancelled) push({ title: t('wizard.flowInvalid'), variant: 'destructive' });
      })
      .finally(() => { if (!cancelled) setPagesLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const counts = React.useMemo(() => {
    const list = integrations ?? [];
    return {
      total: list.length,
      connected: list.filter((i) => i.connectionState === 'connected').length,
      attention: list.filter((i) => i.connectionState === 'subscription_failed' || i.connectionState === 'needs_attention' || i.connectionState === 'pending_subscription').length,
      disabled: list.filter((i) => i.status !== 'active').length
    };
  }, [integrations]);

  const stateMeta = (state: string): { label: string; variant: 'success' | 'warning' | 'destructive' | 'neutral'; icon: React.ReactNode } => {
    switch (state) {
      case 'connected':
        return { label: t('connection.connected'), variant: 'success', icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> };
      case 'pending_subscription':
        return { label: t('connection.pendingSubscription'), variant: 'warning', icon: <Clock className="h-3.5 w-3.5" aria-hidden /> };
      case 'subscription_failed':
        return { label: t('connection.subscriptionFailed'), variant: 'destructive', icon: <Unplug className="h-3.5 w-3.5" aria-hidden /> };
      case 'needs_attention':
        return { label: t('connection.needsAttention'), variant: 'destructive', icon: <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> };
      case 'not_connected':
        return { label: t('connection.notConnected'), variant: 'neutral', icon: <Plug className="h-3.5 w-3.5" aria-hidden /> };
      default:
        return { label: t('connection.unknown'), variant: 'neutral', icon: <CircleAlert className="h-3.5 w-3.5" aria-hidden /> };
    }
  };

  const startConnect = async () => {
    setConnecting(true);
    setOauthBlocked(false);
    try {
      const res = await metaOAuthApi.authorize(brandId || undefined);
      window.location.assign(res.authorizeUrl);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'OAUTH_NOT_CONFIGURED') {
        setOauthBlocked(true);
        push({ title: t('wizard.notConfigured'), variant: 'destructive' });
      } else {
        push({ title: t('wizard.startFailed'), variant: 'destructive' });
      }
      setConnecting(false);
    }
  };

  const doConnect = async () => {
    if (!flow || !selectedPage) return;
    setConnectingPage(true);
    try {
      const res = await metaOAuthApi.connect(flow.flowId, flow.flowToken, selectedPage, brandId || undefined);
      setFlow(null);
      setPages([]);
      setSelectedPage('');
      await load(brandId);
      push({
        title: res.connected
          ? (res.reconnected ? t('wizard.reconnected') : t('wizard.connected'))
          : t('wizard.connectedButSubscriptionFailed'),
        variant: res.connected ? 'default' : 'destructive'
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      push({ title: code === 'PAGE_ALREADY_CONNECTED' ? t('wizard.alreadyConnected') : t('wizard.connectFailed'), variant: 'destructive' });
    } finally {
      setConnectingPage(false);
    }
  };

  const resubscribe = async (row: IntegrationInfo, mode: 'resubscribe' | 'reverify') => {
    setRowBusy(row.id);
    try {
      const res = mode === 'resubscribe'
        ? await metaOAuthApi.resubscribe(row.id)
        : await metaOAuthApi.reverify(row.id);
      await load(brandId);
      push({
        title: res.subscriptionState === 'subscribed' ? t('connection.connected') : t('connection.subscriptionFailed'),
        variant: res.subscriptionState === 'subscribed' ? 'default' : 'destructive'
      });
    } catch {
      push({ title: t('wizard.retryFailed'), variant: 'destructive' });
    } finally {
      setRowBusy('');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('title')}
        description={t('description')}
        breadcrumb={<BackButton />}
        actions={
          <Button onClick={startConnect} disabled={connecting} className="gap-1.5">
            <Plug className="h-3.5 w-3.5" aria-hidden /> {connecting ? t('wizard.starting') : t('wizard.connect')}
          </Button>
        }
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
          {oauthBlocked ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-warning">
              {t('wizard.notConfiguredHint')}
            </div>
          ) : null}

          {/* page picker (only while a flow is active) */}
          {flow ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('wizard.pickPage')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {pagesLoading ? (
                  <p className="text-[13px] text-muted-foreground">{t('wizard.loadingPages')}</p>
                ) : pages.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t('wizard.noPages')}</p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {pages.map((p) => (
                        <li key={p.id}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-[13px] hover:bg-muted/50">
                            <input
                              type="radio"
                              name="meta-page"
                              value={p.id}
                              checked={selectedPage === p.id}
                              onChange={() => setSelectedPage(p.id)}
                              className="h-4 w-4"
                            />
                            <span className="min-w-0 flex-1 truncate">{p.name || p.id}</span>
                            {p.tasks?.length ? (
                              <Badge variant="neutral" className="text-xs">{p.tasks.join(' · ')}</Badge>
                            ) : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="secondary" size="sm" onClick={() => { setFlow(null); setPages([]); }}>
                        {tc('cancel')}
                      </Button>
                      <Button size="sm" disabled={!selectedPage || connectingPage} onClick={doConnect}>
                        {connectingPage ? t('wizard.connecting') : t('wizard.confirmConnect')}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}

          {/* summary + brand filter */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label={t('summary.total')} value={counts.total} icon={<Cable className="h-4 w-4" aria-hidden />} />
            <SummaryTile label={t('summary.connected')} value={counts.connected} icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} tone="success" />
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
              {integrations.map((i) => {
                const meta = stateMeta(i.connectionState);
                const canRetry = i.credentials.present && (i.connectionState === 'subscription_failed' || i.connectionState === 'unknown');
                return (
                  <Card key={i.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="truncate text-sm">{i.displayName || i.providerLabel}</CardTitle>
                          <p className="truncate text-xs text-muted-foreground">{i.providerLabel}</p>
                        </div>
                        <Badge variant={meta.variant}>
                          <span className="inline-flex items-center gap-1">{meta.icon}{meta.label}</span>
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2.5 text-[13px]">
                      <Row label={t('columns.brand')} value={i.brand?.name || t('noBrand')} />
                      <Row label={t('columns.health')} value={<Badge variant={i.health.status === 'ok' ? 'success' : 'neutral'}>{t(`healthLabels.${i.health.status}`)}</Badge>} />
                      <Row
                        label={t('columns.credentials')}
                        value={
                          <Badge variant={i.credentials.present ? 'success' : 'neutral'}>
                            {i.credentials.present ? t('credentialsLabels.present') : t('credentialsLabels.missing')}
                          </Badge>
                        }
                      />
                      <Row label={t('columns.subscription')} value={<Badge variant={meta.variant}>{t(`subscriptionLabels.${i.subscription.state}`)}</Badge>} />
                      <Row label={t('columns.lastEvent')} value={timeAgo(i.health.lastEventAt)} />
                      <Row label={t('columns.lastVerified')} value={i.subscription.verifiedAt ? formatDate(i.subscription.verifiedAt) : '—'} />
                      {canRetry ? (
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={rowBusy === i.id}
                            onClick={() => resubscribe(i, i.connectionState === 'unknown' ? 'reverify' : 'resubscribe')}
                          >
                            {i.connectionState === 'unknown' ? t('actions.reverify') : t('actions.retrySubscription')}
                          </Button>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

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