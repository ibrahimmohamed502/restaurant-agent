'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Building2,
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
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from '@/lib/navigation';
import { Button } from '@/components/ui/button';

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

export function Sidebar({
  collapsed,
  isSuperAdmin,
  mobileOpen,
  onCloseMobile
}: {
  collapsed: boolean;
  isSuperAdmin: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => !i.superAdminOnly || isSuperAdmin);

  return (
    <>
      {/* mobile overlay */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={onCloseMobile} aria-hidden />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 z-40 flex flex-col border-e border-border bg-surface transition-[width,transform] duration-200 lg:static lg:z-auto lg:translate-x-0',
          collapsed ? 'w-[68px]' : 'w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full lg:rtl:translate-x-0'
        )}
        aria-label="Sidebar"
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-3">
          <Link href="/dashboard" className="flex items-center gap-2 min-w-0">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            {!collapsed ? <span className="truncate text-sm font-semibold text-foreground">LWC Platform</span> : null}
          </Link>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={onCloseMobile} aria-label="Close menu">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          <ul className="space-y-1">
            {items.map((item) => {
              const Icon = ICONS[item.icon] ?? LayoutDashboard;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onCloseMobile}
                    title={t(item.key)}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      collapsed && 'justify-center px-0'
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'sr-only')}>{t(item.key)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}

export { MenuIcon };
