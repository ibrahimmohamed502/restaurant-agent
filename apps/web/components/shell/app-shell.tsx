'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { cn } from '@/lib/utils';
import { directionFor, type Locale } from '@/i18n/routing';
import { setLocaleCookie } from '@/lib/preferences';

const SUPER_ADMIN_ROLE = 'Company Admin';

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
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light');
  const [context, setContext] = React.useState<{ company: string; brand: string } | null>(null);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
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
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar collapsed={collapsed} isSuperAdmin={isSuperAdmin} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          context={context}
          locale={activeLocale}
          theme={theme}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
          onOpenMobile={() => setMobileOpen(true)}
          onLocaleChange={(l) => {
            setLocaleCookie(l);
            document.documentElement.dir = directionFor(l);
            document.documentElement.lang = l;
            router.refresh();
          }}
          onThemeChange={setTheme}
          onLogout={async () => {
            await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
            router.replace('/login');
          }}
        />
        <main className="flex-1 space-y-6 p-4 lg:p-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
