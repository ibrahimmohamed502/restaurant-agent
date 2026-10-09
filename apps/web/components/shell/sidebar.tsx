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
  Sparkles,
  Tags,
  Users,
  X
} from 'lucide-react';
import { NAV_ITEMS } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'layout-dashboard': LayoutDashboard,
  inbox: Inbox,
  users: Users,
  'building-2': Building2,
  tags: Tags,
  radio: Radio,
  sparkles: Sparkles,
  'book-open': BookOpen,
  shield: Shield,
  plug: Plug,
  'scroll-text': ScrollText,
  settings: Settings
};

const GROUP_LABELS: Record<string, string> = {
  overview: 'overview',
  engagement: 'engagement',
  organization: 'organization',
  configuration: 'configuration'
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
  mobileOpen: boolean;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
}) {
  const t = useTranslations('navGroups');
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => !i.superAdminOnly || isSuperAdmin);

  const groups = ['overview', 'engagement', 'organization', 'configuration']
    .map((key) => ({ key, items: items.filter((i) => i.group === key) }))
    .filter((g) => g.items.length > 0);

  const brand = (
    <Link href="/dashboard" onClick={onCloseMobile} className="flex h-topbar items-center gap-2.5 px-3" title="Restaurant AI Platform">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
        <Sparkles className="h-4 w-4" aria-hidden />
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold leading-tight text-foreground">Restaurant AI</span>
          <span className="block truncate text-2xs leading-tight text-muted-foreground">Engagement Platform</span>
        </span>
      ) : null}
    </Link>
  );

  return (
    <>
      {mobileOpen ? <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onCloseMobile} aria-hidden /> : null}

      <aside
        aria-label="Sidebar"
        className={cn(
          'fixed inset-y-0 start-0 z-40 flex flex-col border-e border-border bg-surface transition-[width,transform] duration-[--dur-base] ease-[--ease-out] lg:static lg:z-auto',
          collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
          mobileOpen ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full lg:translate-x-0'
        )}
      >
        <div className="flex h-topbar items-center justify-between border-b border-border">
          {brand}
          <button
            type="button"
            onClick={onCloseMobile}
            className="me-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {groups.map((group) => (
            <div key={group.key} className="mb-4 last:mb-0">
              {!collapsed ? (
                <p className="px-3 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{t(GROUP_LABELS[group.key])}</p>
              ) : (
                <div className="mx-3 mb-2 border-t border-border" />
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon] ?? LayoutDashboard;
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onCloseMobile}
                        title={collapsed ? item.key : undefined}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex h-9 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-[--dur-fast]',
                          active ? 'bg-primary/10 text-primary' : 'text-secondary-foreground hover:bg-muted hover:text-foreground',
                          collapsed && 'justify-center px-0'
                        )}
                      >
                        {active ? <span className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" aria-hidden /> : null}
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className={cn('truncate', collapsed && 'sr-only')}>{t(item.key)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-border p-2 lg:block">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4 rtl:rotate-180" aria-hidden /> : <ChevronsLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />}
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        </div>
      </aside>
    </>
  );
}

export { MenuIcon };
