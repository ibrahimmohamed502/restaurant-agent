'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  LayoutDashboard,
  Menu as MenuIcon,
  Plug,
  Radio,
  ScrollText,
  Settings,
  Shield,
  Tags,
  Users,
  X
} from 'lucide-react';
import { NAV_ITEMS } from '@/lib/navigation';
import { BrandMark } from '@/components/brand/brand-mark';
import { cn } from '@/lib/utils';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'layout-dashboard': LayoutDashboard,
  inbox: Inbox,
  users: Users,
  'building-2': Building2,
  tags: Tags,
  radio: Radio,
  sparkles: LayoutDashboard,
  'book-open': BookOpen,
  shield: Shield,
  plug: Plug,
  'scroll-text': ScrollText,
  settings: Settings
};

export function Sidebar({
  collapsed,
  isSuperAdmin,
  mobileOpen,
  onToggleCollapsed,
  onCloseMobile
}: {
  collapsed: boolean;
  isSuperAdmin: boolean;
  /** drawer state — also hides the persistent sidebar on desktop when false */
  mobileOpen: boolean;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
}) {
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const tShell = useTranslations('shell');
  const pathname = usePathname();
  // RBAC: super-admin-only entries are hidden from non-super-admins
  const items = NAV_ITEMS.filter((i) => !i.superAdminOnly || isSuperAdmin);

  // Escape closes the drawer (drawer width only — desktop keeps its sidebar)
  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && typeof window !== 'undefined' && window.innerWidth < 1024) onCloseMobile();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  const brand = (
    <Link href="/dashboard" onClick={onCloseMobile} className="relative flex h-topbar items-center gap-2.5 overflow-hidden px-3" title={tCommon('platformName')}>
      <span className="absolute inset-0 bg-gradient-to-e from-primary/15 via-primary/5 to-transparent" aria-hidden />
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary-hover text-primary-foreground shadow-sm">
        <BrandMark size={18} />
      </span>
      {!collapsed ? (
        <span className="relative min-w-0">
          <span className="block truncate text-sm font-semibold leading-tight text-foreground">{tCommon('platformName')}</span>
          <span className="block truncate text-2xs leading-tight text-muted-foreground">{tCommon('appName')}</span>
        </span>
      ) : null}
    </Link>
  );

  return (
    <>
      {mobileOpen ? <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] lg:hidden" onClick={onCloseMobile} aria-hidden /> : null}

      <aside
        aria-label={tCommon('platformName')}
        className={cn(
          'fixed inset-y-0 start-0 z-40 flex flex-col border-e border-border bg-surface transition-[width,transform] duration-[--dur-base] ease-[--ease-out] lg:static lg:z-auto',
          collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
          // drawer/off-canvas on narrow widths; fully hidden (out of flow) on desktop when closed
          mobileOpen ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full lg:hidden'
        )}
      >
        <div className="flex h-topbar items-center justify-between border-b border-border">
          {brand}
          <button
            type="button"
            onClick={onCloseMobile}
            className="me-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label={tCommon('close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="space-y-0.5">
            {items.map((item) => {
              const Icon = ICONS[item.icon] ?? LayoutDashboard;
              const active = pathname === item.href || (pathname != null && pathname.startsWith(`${item.href}/`));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onCloseMobile}
                    title={collapsed ? tNav(item.key) : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex h-9 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium transition-[background-color,color,transform] duration-[--dur-fast]',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-secondary-foreground hover:bg-muted hover:text-foreground',
                      collapsed && 'justify-center px-0'
                    )}
                  >
                    {active ? <span className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" aria-hidden /> : null}
                    <Icon className={cn('h-4 w-4 shrink-0 transition-transform duration-[--dur-fast]', active ? 'scale-110' : 'group-hover:scale-105')} aria-hidden />
                    <span className={cn('truncate', collapsed && 'sr-only')}>{tNav(item.key)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="hidden border-t border-border p-2 lg:block">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? tShell('expand') : tShell('collapse')}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4 rtl:rotate-180" aria-hidden /> : <ChevronsLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />}
            {!collapsed ? <span>{tShell('collapse')}</span> : null}
          </button>
        </div>
      </aside>
    </>
  );
}

export { MenuIcon };
