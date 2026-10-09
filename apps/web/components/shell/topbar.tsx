'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Languages, LogOut, Menu as MenuIcon, Moon, Sun } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { setLocaleCookie } from '@/lib/preferences';
import { directionFor, type Locale } from '@/i18n/routing';

export type ShellUser = { name: string | null; email: string } | null;
export type ContextValue = { company: string; brand: string } | null;

/** Company / brand context chips — clear separation from the user area. */
function ContextChips({ context }: { context: ContextValue }) {
  const t = useTranslations('shell');
  if (!context) return null;
  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs font-medium text-secondary-foreground">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">{t('company')}</span>
        {context.company}
      </span>
      <span className="text-muted-foreground/50" aria-hidden>/</span>
      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs font-medium text-foreground">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">{t('brand')}</span>
        {context.brand}
      </span>
    </div>
  );
}

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
    <header className="sticky top-0 z-30 flex h-topbar items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur lg:px-5">
      <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" onClick={onOpenMobile} aria-label={t('shell.menu')}>
        <MenuIcon className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="hidden h-8 w-8 lg:inline-flex" onClick={onToggleCollapsed} aria-label={t('shell.collapse')}>
        <MenuIcon className="h-4 w-4" />
      </Button>

      <div className="mx-auto flex w-full max-w-content items-center gap-3">
        <ContextChips context={context} />

        <div className="ms-auto flex items-center gap-1">
          {/* language */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" aria-label={t('common.language')}>
                <Languages className="h-3.5 w-3.5" aria-hidden />
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
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.theme')}>
                {theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={theme} onValueChange={(v) => onThemeChange(v as 'light' | 'dark')}>
                <DropdownMenuRadioItem value="light"><Sun className="h-4 w-4" /> {t('common.light')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark"><Moon className="h-4 w-4" /> {t('common.dark')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="mx-1 h-6 w-px bg-border" aria-hidden />

          {/* user */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label={t('common.profile')}>
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="text-2xs">{initials}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              <div className="px-2 py-1.5">
                <p className="text-[13px] font-medium text-foreground">{user?.name ?? '—'}</p>
                <p className="text-xs text-muted-foreground">{user?.email ?? ''}</p>
              </div>
              <div className="my-1 h-px bg-border" />
              <DropdownMenuItem onSelect={onLogout}>
                <LogOut className="h-4 w-4" /> {t('common.logout')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
