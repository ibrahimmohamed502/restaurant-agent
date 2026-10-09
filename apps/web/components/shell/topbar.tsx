'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Languages, LogOut, Menu as MenuIcon, Monitor, Moon, Sun, User as UserIcon } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import type { Locale } from '@/i18n/routing';

export type ShellUser = { name: string | null; email: string } | null;
export type ContextValue = { company: string; brand: string } | null;

export function Topbar({
  user,
  context,
  locale,
  theme,
  onToggleCollapsed,
  onOpenMobile,
  onLocaleChange,
  onThemeChange,
  onLogout
}: {
  user: ShellUser;
  context: ContextValue;
  locale: Locale;
  theme: 'light' | 'dark';
  onToggleCollapsed: () => void;
  onOpenMobile: () => void;
  onLocaleChange: (l: Locale) => void;
  onThemeChange: (t: 'light' | 'dark') => void;
  onLogout: () => void;
}) {
  const t = useTranslations();
  const initials = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur lg:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobile} aria-label={t('shell.menu')}>
        <MenuIcon className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={onToggleCollapsed} aria-label={t('shell.collapse')}>
        <MenuIcon className="h-4 w-4" />
      </Button>

      {context ? (
        <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
          <span className="rounded-md border border-border bg-surface-2 px-2 py-1">{context.company}</span>
          <Separator orientation="vertical" className="h-4" />
          <span className="rounded-md border border-border bg-surface-2 px-2 py-1">{context.brand}</span>
        </div>
      ) : null}

      <div className="ms-auto flex items-center gap-1">
        {/* language */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t('common.language')}>
              <Languages className="h-4 w-4" />
              <span className="hidden sm:inline">{locale === 'ar' ? 'العربية' : 'English'}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={locale} onValueChange={(v) => onLocaleChange(v as Locale)}>
              <DropdownMenuRadioItem value="ar">العربية</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* theme */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('common.theme')}>
              {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => onThemeChange(v as 'light' | 'dark')}>
              <DropdownMenuRadioItem value="light">
                <Sun className="h-4 w-4" /> {t('common.light')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="h-4 w-4" /> {t('common.dark')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* user */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('common.profile')} className="rounded-full">
              <Avatar>
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium text-foreground">{user?.name ?? '—'}</p>
              <p className="text-xs text-muted-foreground">{user?.email ?? ''}</p>
            </div>
            <Separator className="my-1" />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <UserIcon className="h-4 w-4" /> {t('common.profile')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut className="h-4 w-4" /> {t('common.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
