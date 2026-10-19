'use client';

/**
 * B1 - Facebook Page connection page.
 *
 * The whole OAuth dance happens across three places: this page starts it, Meta
 * owns the middle, and the API callback hands back here. So this component has
 * to render seven genuinely different states and be honest about each one:
 *
 *   1. idle           - nothing connected, offer to connect
 *   2. starting       - state is being minted, button is busy
 *   3. waitingOnMeta  - browser is at Facebook; show that and offer a way back
 *   4. picking        - pages discovered, choose one (some may be refused)
 *   5. connected      - listed, with reconnect and disconnect
 *   6. needsReconnect - the row exists but the credential is gone or disabled
 *   7. error          - refused at Meta, no pages, wrong permissions, conflict,
 *                       expired authorization, or the network
 *
 * WHAT THIS PAGE NEVER DOES:
 *   - hold a token of any kind. There is none to hold: the server parks the
 *     grant and the browser only ever sees a state id.
 *   - decide whether a Page may be connected. `connectable` comes from the
 *     server, which derived it from Meta's task list. A client-side guess would
 *     let a user pick something that fails later.
 *   - navigate anywhere it did not receive. The authorize URL is server-built
 *     from a server-side allowlist.
 *
 * Direction: the document direction comes from the locale (app/layout.tsx) and
 * everything below uses logical utilities, so this renders correctly in Arabic
 * (RTL) and English (LTR) without a second layout.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Facebook, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState, PageLoading } from '@/components/ui/states';
import {
  facebookApi,
  type DiscoverablePage,
  type FacebookConnection
} from '@/lib/api';

type Phase =
  | 'loading'
  | 'idle'
  | 'starting'
  | 'waitingOnMeta'
  | 'picking'
  | 'confirming'
  | 'connected'
  | 'needsReconnect';

/** Error codes the server can return that this page can explain specifically. */
type KnownError =
  | 'META_ACCESS_DENIED'
  | 'META_NO_MANAGED_PAGES'
  | 'CONNECTION_UPSTREAM_ERROR'
  | 'PAGE_NOT_CONNECTABLE'
  | 'PAGE_OWNED_BY_ANOTHER_TENANT'
  | 'PAGE_NOT_IN_ACCOUNT'
  | 'BRAND_NOT_ACCESSIBLE'
  | 'AUTHORIZATION_EXPIRED'
  | 'OAUTH_STATE_EXPIRED'
  | 'OAUTH_STATE_ALREADY_USED'
  | 'OAUTH_STATE_NOT_FOUND'
  | 'OAUTH_STATE_MISMATCH'
  | 'META_UPSTREAM_UNAVAILABLE'
  | 'META_CODE_EXCHANGE_FAILED'
  | 'NETWORK_ERROR';

function isKnownError(code: string): code is KnownError {
  return [
    'META_ACCESS_DENIED', 'META_NO_MANAGED_PAGES', 'CONNECTION_UPSTREAM_ERROR',
    'PAGE_NOT_CONNECTABLE', 'PAGE_OWNED_BY_ANOTHER_TENANT', 'PAGE_NOT_IN_ACCOUNT',
    'BRAND_NOT_ACCESSIBLE', 'AUTHORIZATION_EXPIRED', 'OAUTH_STATE_EXPIRED',
    'OAUTH_STATE_ALREADY_USED', 'OAUTH_STATE_NOT_FOUND', 'OAUTH_STATE_MISMATCH',
    'META_UPSTREAM_UNAVAILABLE', 'META_CODE_EXCHANGE_FAILED', 'NETWORK_ERROR'
  ].includes(code);
}

export default function FacebookConnectPage() {
  const t = useTranslations('facebook');
  const tc = useTranslations('common');
  const router = useRouter();
  const params = useSearchParams();

  const [phase, setPhase] = React.useState<Phase>('loading');
  const [connections, setConnections] = React.useState<FacebookConnection[]>([]);
  const [brands, setBrands] = React.useState<Array<{ id: string; name: string }>>([]);
  const [brandId, setBrandId] = React.useState('');
  const [pages, setPages] = React.useState<DiscoverablePage[]>([]);
  const [stateId, setStateId] = React.useState<string | null>(null);
  const [grantBrandId, setGrantBrandId] = React.useState<string | null>(null);
  const [selectedPage, setSelectedPage] = React.useState<string>('');
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  /** Server error codes map to a translated explanation; unknown ones do not. */
  const errorKey = errorCode && isKnownError(errorCode) ? `errors.${errorCode}` : null;

  const loadConnections = React.useCallback(async () => {
    try {
      const data = await facebookApi.connections();
      setConnections(data.connections);
      return data.connections;
    } catch {
      // Listing failed but the page can still render its own error state.
      setConnections([]);
      return [];
    }
  }, []);

  // Landing on this page can mean three different things: a fresh visit, a
  // return from Meta's consent screen, or a refusal handed back by the callback.
  React.useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const list = await loadConnections();
      if (cancelled) return;

      const returnedState = params.get('stateId');
      const returnedError = params.get('error');

      if (returnedError) {
        setErrorCode(returnedError);
        setPhase('idle');
        return;
      }

      if (returnedState) {
        setStateId(returnedState);
        setErrorCode(null);
        try {
          const { pages: found, brandId: grantBrand } = await facebookApi.pages(returnedState);
          if (cancelled) return;
          setPages(found);
          setGrantBrandId(grantBrand);
          setBrandId(grantBrand ?? '');
          setSelectedPage(found.find((p) => p.connectable)?.pageId ?? '');
          setPhase(found.length === 0 ? 'idle' : 'picking');
          if (found.length === 0) setErrorCode('META_NO_MANAGED_PAGES');
        } catch (e) {
          if (cancelled) return;
          setErrorCode((e as { code?: string })?.code ?? 'NETWORK_ERROR');
          setPhase('idle');
        }
        return;
      }

      // Fresh visit: show what is already connected, and offer to add more.
      const needsWork = list.some((c) => !c.credentialPresent || c.status !== 'active');
      setPhase(needsWork && list.length > 0 ? 'needsReconnect' : 'idle');
    };

    void boot();
    return () => { cancelled = true; };
  }, [params, loadConnections]);

  // The brand list drives the connect target. A brand-less session cannot start
  // a connect at all, and the server would refuse it anyway.
  React.useEffect(() => {
    let cancelled = false;
    fetchBrands()
      .then((list) => {
        if (cancelled) return;
        setBrands(list);
        setBrandId((current) => current || list[0]?.id || '');
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const start = async () => {
    if (!brandId) return;
    setErrorCode(null);
    setNotice(null);
    setPhase('starting');
    try {
      const { authorizeUrl } = await facebookApi.start(brandId);
      // Only a URL this server produced is ever navigated to.
      window.location.href = authorizeUrl;
      setPhase('waitingOnMeta');
    } catch (e) {
      setErrorCode((e as { code?: string })?.code ?? 'NETWORK_ERROR');
      setPhase('idle');
    }
  };

  const confirm = async () => {
    if (!stateId || !selectedPage) return;
    const targetBrand = grantBrandId || brandId;
    if (!targetBrand) return;
    setErrorCode(null);
    setPhase('confirming');
    try {
      const existing = connections.find((c) => c.pageId === selectedPage);
      await facebookApi.confirm({
        brandId: targetBrand,
        pageId: selectedPage,
        stateId,
        mode: existing ? 'reconnect' : 'connect'
      });
      // Drop the spent grant from the URL so a refresh cannot replay it.
      router.replace('/integrations/facebook');
      setStateId(null);
      setPages([]);
      setSelectedPage('');
      await loadConnections();
      setPhase('connected');
    } catch (e) {
      setErrorCode((e as { code?: string })?.code ?? 'NETWORK_ERROR');
      setPhase(connections.length > 0 ? 'connected' : 'idle');
    }
  };

  const disconnect = async (channelId: string) => {
    setErrorCode(null);
    setNotice(null);
    try {
      await facebookApi.disconnect(channelId);
      const list = await loadConnections();
      setPhase(list.length > 0 ? 'needsReconnect' : 'idle');
    } catch (e) {
      setErrorCode((e as { code?: string })?.code ?? 'NETWORK_ERROR');
      setPhase('connected');
    }
  };

  if (phase === 'loading') {
    return (
      <div className="space-y-5">
        <PageHeader title={t('title')} description={t('description')} breadcrumb={<BackButton />} />
        <PageLoading />
      </div>
    );
  }

  const busy = phase === 'starting' || phase === 'confirming';
  const connectedCount = connections.filter((c) => c.credentialPresent && c.status === 'active').length;
  // Rendered as its own card so a confirm-in-flight keeps its button label stable
  // while still telling the user something is happening.
  const confirmLabel = phase === 'confirming' ? 'states.picking.confirming' : 'states.picking.confirm';

  return (
    <div className="space-y-5">
      <PageHeader title={t('title')} description={t('description')} breadcrumb={<BackButton />} />

      {errorKey ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
        >
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
            {t('errorTitle')}
          </p>
          <p className="mt-1 text-muted-foreground">{t(errorKey)}</p>
        </div>
      ) : null}

      {notice ? (
        <div role="status" className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
          {t(notice)}
        </div>
      ) : null}

      {phase === 'waitingOnMeta' ? (
        <Card>
          <CardContent className="space-y-3 py-8 text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-surface-2">
              <Facebook className="h-5 w-5" aria-hidden />
            </span>
            <p className="text-sm font-semibold text-foreground">{t('states.waiting.title')}</p>
            <p className="text-sm text-muted-foreground">{t('states.waiting.description')}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { router.replace('/integrations/facebook'); setPhase('idle'); }}
            >
              {t('states.waiting.cancel')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {phase === 'picking' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('states.picking.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] text-muted-foreground">{t('states.picking.description')}</p>
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="sr-only">{t('states.picking.title')}</legend>
              {pages.map((p) => (
                <label
                  key={p.pageId}
                  className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm ${
                    p.connectable
                      ? 'cursor-pointer border-border hover:bg-surface-2'
                      : 'cursor-not-allowed border-border/60 bg-surface-2/40 opacity-70'
                  }`}
                >
                  <input
                    type="radio"
                    name="facebook-page"
                    value={p.pageId}
                    checked={selectedPage === p.pageId}
                    disabled={!p.connectable || busy}
                    onChange={() => setSelectedPage(p.pageId)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">
                      {p.name || p.pageId}
                    </span>
                    <span className="block text-xs text-muted-foreground">{p.category || '-'}</span>
                    {p.connectable ? null : (
                      <span className="mt-1 block text-xs text-warning">
                        {t('states.picking.missingTasks', { tasks: p.missingTasks.join(', ') })}
                      </span>
                    )}
                  </span>
                  <Badge variant={p.connectable ? 'success' : 'neutral'}>
                    {t(p.connectable ? 'states.picking.connectable' : 'states.picking.notConnectable')}
                  </Badge>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void confirm()} disabled={!selectedPage || busy}>
                {t(confirmLabel)}
              </Button>
              <Button
                variant="secondary"
                onClick={() => { router.replace('/integrations/facebook'); setPhase('idle'); }}
                disabled={busy}
              >
                {tc('cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {phase === 'idle' || phase === 'starting' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('connect.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[13px] text-muted-foreground">{t('connect.description')}</p>
            {brands.length === 0 ? (
              <EmptyState
                title={t('connect.noBrandsTitle')}
                description={t('connect.noBrandsDescription')}
              />
            ) : (
              <div className="space-y-3">
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="facebook-brand">{t('connect.brandLabel')}</Label>
                  <select
                    id="facebook-brand"
                    value={brandId}
                    onChange={(e) => setBrandId(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
                <Button onClick={() => void start()} disabled={!brandId || busy}>
                  <Facebook className="me-2 h-4 w-4" aria-hidden />
                  {t(phase === 'starting' ? 'connect.starting' : 'connect.start')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {connections.length > 0 && phase !== 'picking' && phase !== 'waitingOnMeta' ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-sm">{t('connections.title')}</CardTitle>
              <Badge variant={connectedCount > 0 ? 'success' : 'warning'}>
                {t('connections.count', { count: connectedCount })}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {connections.map((c) => {
              const live = c.credentialPresent && c.status === 'active';
              return (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {c.pageName || c.pageId}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.brand?.name || t('noBrand')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={live ? 'success' : 'warning'}>
                      {t(live ? 'status.connected' : 'status.needsReconnect')}
                    </Badge>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void disconnect(c.id)}
                      aria-label={t('connections.disconnect')}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{t('connections.reconnectHint')}</p>
          </CardContent>
        </Card>
      ) : null}

      {phase === 'connected' ? (
        <EmptyState
          title={t('states.connected.title')}
          description={t('states.connected.description')}
          actionLabel={t('connect.addAnother')}
          onAction={() => { setNotice('states.connected.description'); setPhase('idle'); }}
        />
      ) : null}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <RefreshCw className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        {t('tokenNotice')}
      </p>
    </div>
  );
}

/** Brand list, fetched through the existing companies API. */
async function fetchBrands(): Promise<Array<{ id: string; name: string }>> {
  const { companiesApi } = await import('@/lib/api');
  const list = await companiesApi.listBrands();
  return list.map((b) => ({ id: b.id, name: b.name }));
}