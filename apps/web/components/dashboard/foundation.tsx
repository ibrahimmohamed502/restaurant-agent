'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BookOpen, Inbox, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Dashboard foundation (restored from the 373d62a9 Stage 5 baseline).
 * Intentional surface — no fabricated metrics: a real product layout that
 * loads synchronously (no dashboard fetch → no loading state at all).
 * Future widgets slot in cleanly; real data arrives with the modules below.
 */
export function DashboardFoundation() {
  const t = useTranslations('dashboardFoundation');
  const rows = [
    { title: t('publishTitle'), body: t('publishBody'), href: '/knowledge' },
    { title: t('replyTitle'), body: t('replyBody'), href: '/inbox' },
    { title: t('connectTitle'), body: t('connectBody'), href: '/channels' }
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="lg:col-span-2 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[13px] font-semibold text-foreground">{t('gettingStarted')}</h2>
        </header>
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.href} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{row.title}</p>
                <p className="text-xs text-muted-foreground">{row.body}</p>
              </div>
              <Button variant="secondary" size="sm" asChild>
                <Link href={row.href}>{t('open')}</Link>
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <aside className="space-y-4">
        <section className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-8 text-center">
          <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-md bg-surface text-muted-foreground shadow-sm">
            <Inbox className="h-4 w-4" aria-hidden />
          </span>
          <p className="mt-2 text-[13px] font-medium text-foreground">{t('inboxTitle')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('inboxBody')}</p>
        </section>
        <section className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-8 text-center">
          <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-md bg-surface text-muted-foreground shadow-sm">
            <BookOpen className="h-4 w-4" aria-hidden />
          </span>
          <p className="mt-2 text-[13px] font-medium text-foreground">{t('knowledgeTitle')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('knowledgeBody')}</p>
        </section>
      </aside>
    </div>
  );
}
