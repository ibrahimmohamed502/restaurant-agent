'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { authApi, type MeResponse } from '@/lib/api';
import { PageLoading } from '@/components/ui/states';
import { setThemeCookie, directionFor, type Locale } from '@/lib/preferences';

const COMPANY_ADMIN = 'Company Admin';

function resolveInitialTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  if (document.documentElement.classList.contains('dark')) return 'dark';
  return 'light';
}

/** Resolves the authenticated user from the API; gates all (app) routes. */
export function AppShell({
  children,
  user,
  isSuperAdmin
}: {
  children: React.ReactNode;
  user: { name: string | null; email: string };
  isSuperAdmin: boolean;
}) {
  const router = useRouter();
  const activeLocale = useLocale() as Locale;
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [theme, setTheme] = React.useState<'light' | 'dark'>(resolveInitialTheme);
  const [context, setContext] = React.useState<{ company: string; brand: string } | null>(null);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    setThemeCookie(theme);
  }, [theme]);

  React.useEffect(() => {
    let alive = true;
    fetch('/api/v1/tenants/current', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.data) return;
        const t = d.data;
        setContext({ company: t.name ?? t.slug ?? '—', brand: t.slug === 'ufc' ? 'Life with Cacao' : t.slug ?? '—' });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        collapsed={collapsed}
        isSuperAdmin={isSuperAdmin}
        mobileOpen={mobileOpen}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          context={context}
          locale={activeLocale}
          theme={theme}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
          onOpenMobile={() => setMobileOpen(true)}
          onLocaleChange={(l) => {
            document.documentElement.dir = directionFor(l);
            document.documentElement.lang = l;
            router.refresh();
          }}
          onThemeChange={setTheme}
          onLogout={async () => {
            await authApi.logout().catch(() => undefined);
            router.replace('/login');
          }}
        />
        <main className="flex-1">
          <div className="page-shell">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** Resolves the session from the API; gates all (app) routes. */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = React.useState<MeResponse | null>(null);

  React.useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((data) => { if (alive) setMe(data); })
      .catch(() => { router.replace('/login'); });
    return () => { alive = false; };
  }, [router]);

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
