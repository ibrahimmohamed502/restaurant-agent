'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from './app-shell';
import { authApi, type MeResponse } from '@/lib/api';
import { ErrorState, PageLoading } from '@/components/ui/states';

const COMPANY_ADMIN = 'Company Admin';

/**
 * Classify a failed /auth/me response:
 * - 'unauthenticated' → dead/expired session → clear it and go to /login
 * - 'error'           → transient API/server problem → retryable error state
 */
export function gateOutcome(err: unknown): 'unauthenticated' | 'error' {
  const code = (err as { code?: string })?.code;
  return code === 'UNAUTHENTICATED' ? 'unauthenticated' : 'error';
}

/** Resolves the session from the API; gates all (app) routes. */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const t = useTranslations('states');
  const [me, setMe] = React.useState<MeResponse | null>(null);
  const [outcome, setOutcome] = React.useState<'unauthenticated' | 'error' | null>(null);

  const load = React.useCallback(async () => {
    setOutcome(null);
    setMe(null);
    try {
      setMe(await authApi.me());
    } catch (err: unknown) {
      if (gateOutcome(err) === 'unauthenticated') {
        // Dead/expired session: clear the stale cookie first, otherwise the
        // /login route bounces straight back here (middleware checks cookie
        // presence). Hard-navigate so the browser drops all app state.
        await authApi.logout().catch(() => {});
        window.location.assign('/login');
        return;
      }
      setOutcome('error');
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  if (outcome === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md">
          <ErrorState
            title={t('errorTitle')}
            description={t('errorDescription')}
            actionLabel={t('retry')}
            onAction={() => { void load(); }}
          />
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md">
          <PageLoading />
        </div>
      </div>
    );
  }

  const isSuperAdmin = (me.roles ?? []).includes(COMPANY_ADMIN);
  return (
    <AppShell user={{ name: me.user.name, email: me.user.email }} isSuperAdmin={isSuperAdmin}>
      {children}
    </AppShell>
  );
}
