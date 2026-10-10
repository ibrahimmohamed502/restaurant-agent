'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Languages, Moon, Sparkles, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoginForm } from '@/features/auth/login-form';
import { useLocale } from 'next-intl';
import { setLocaleCookie } from '@/lib/preferences';
import { directionFor, type Locale } from '@/i18n/routing';
import { cn } from '@/lib/utils';

/** Local, replaceable brand artwork slot (no external images, no licensed assets). */
function BrandArtwork({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 320" className={cn('h-full w-full', className)} role="img" aria-label="Brand artwork">
      <defs>
        <linearGradient id="cacaoBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.95" />
          <stop offset="100%" stopColor="hsl(var(--primary-hover))" stopOpacity="0.75" />
        </linearGradient>
        <radialGradient id="cacaoGlow" cx="0.7" cy="0.25" r="0.7">
          <stop offset="0%" stopColor="hsl(30 60% 70%)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="transparent" />
        </radialGradient>
      </defs>
      <rect width="480" height="320" fill="url(#cacaoBg)" />
      <rect width="480" height="320" fill="url(#cacaoGlow)" />
      <g fill="none" stroke="hsl(36 44% 97%)" strokeOpacity="0.28" strokeWidth="1.2">
        {Array.from({ length: 9 }, (_, i) => <circle key={i} cx={400 - i * 34} cy={250 - i * 18} r={90 + i * 6} />)}
      </g>
      {/* drifting accent orbs */}
      <circle className="float-slow" cx="96" cy="72" r="7" fill="hsl(36 44% 97%)" fillOpacity="0.35" />
      <circle className="float-slower" cx="420" cy="58" r="5" fill="hsl(36 44% 97%)" fillOpacity="0.3" />
      <circle className="float-slow" cx="60" cy="250" r="4" fill="hsl(36 44% 97%)" fillOpacity="0.25" />
      {/* heart mark with rising steam */}
      <g transform="translate(110 218)">
        <g stroke="hsl(36 44% 97%)" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.85">
          <path className="steam" d="M22 -8c0-9 9-12 9-21" />
          <path className="steam steam-2" d="M38 -10c0-9 9-12 9-21" />
          <path className="steam steam-3" d="M54 -8c0-9 9-12 9-21" />
        </g>
        <path d="M38 66c-14-16-22-33-22-52 0-26 16-44 36-44 8 0 14 3 18 7 4-4 10-7 18-7 20 0 36 18 36 44 0 19-8 36-22 52l-32 20z" fill="hsl(36 44% 97%)" fillOpacity="0.9" />
      </g>
      {/* monogram */}
      <g transform="translate(292 200)" className="float-slower">
        <path d="M0 52V-44h34v10c8-7 17-10 26-10 19 0 33 13 33 33v63h-34V-6c0-8-5-13-12-13s-12 5-12 13v58z" fill="hsl(36 44% 97%)" fillOpacity="0.9" />
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const activeLocale = useLocale() as Locale;
  const router = useRouter();
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light');
  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-2">
      {/* branded panel */}
      <section className="relative hidden overflow-hidden lg:block">
        <BrandArtwork className="absolute inset-0 h-full w-full" />
        <div className="relative flex h-full flex-col justify-between p-10 text-primary-foreground">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-foreground/15 backdrop-blur">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold">Restaurant AI</p>
              <p className="text-xs opacity-80">Engagement Platform</p>
            </div>
          </div>
          <div className="max-w-md space-y-2">
            <h2 className="text-3xl font-semibold leading-tight">One place for every customer conversation.</h2>
            <p className="text-sm opacity-85">Unified inbox, brand-scoped AI knowledge and Meta routing — built for restaurant teams.</p>
          </div>
        </div>
      </section>

      {/* form panel */}
      <section className="flex flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3 lg:border-b-0">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-sm font-semibold text-foreground">Restaurant AI</span>
          </div>
          <div className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => { setLocaleCookie(activeLocale === 'ar' ? 'en' : 'ar'); document.documentElement.dir = directionFor(activeLocale === 'ar' ? 'en' : 'ar'); document.documentElement.lang = activeLocale === 'ar' ? 'en' : 'ar'; window.location.reload(); }}
            >
              <Languages className="h-3.5 w-3.5" aria-hidden />
              {activeLocale === 'ar' ? 'English' : 'العربية'}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="Toggle theme">
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm">
            <LoginForm onSuccess={() => router.replace('/dashboard')} />
          </div>
        </div>
      </section>
    </main>
  );
}
