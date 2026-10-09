'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from './app-shell';
import { authApi, type MeResponse } from '@/lib/api';
import { PageLoading } from '@/components/ui/states';

/** Resolves the authenticated user from the API; gates all (app) routes. */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = React.useState<MeResponse | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((data) => {
        if (!alive) return;
        setMe(data);
        setState('ready');
      })
      .catch(() => {
        if (!alive) return;
        router.replace('/login');
      });
    return () => {
      alive = false;
    };
  }, [router]);

  if (state !== 'ready' || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md">
          <PageLoading />
        </div>
      </div>
    );
  }

  const isSuperAdmin = (me.roles ?? []).includes('Company Admin');
  return (
    <AppShell user={{ name: me.user.name, email: me.user.email }} isSuperAdmin={isSuperAdmin}>
      {children}
    </AppShell>
  );
}
