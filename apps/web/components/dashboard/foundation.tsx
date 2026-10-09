'use client';

import * as React from 'react';
import { BookOpen, Inbox, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Intentional dashboard foundation (no fabricated metrics).
 * Laid out as a real product surface so future widgets slot in cleanly.
 */
export function DashboardFoundation() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="lg:col-span-2 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[13px] font-semibold text-foreground">Getting started</h2>
        </header>
        <ul className="divide-y divide-border">
          {[
            { title: 'Publish your brand knowledge', body: 'Menu, branches, FAQs and policies.', href: '/knowledge' },
            { title: 'Reply from the Unified Inbox', body: 'Comments and Messenger messages in one place.', href: '/inbox' },
            { title: 'Connect another Meta page', body: 'Add routing channels without code deploys.', href: '/channels' }
          ].map((row) => (
            <li key={row.title} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{row.title}</p>
                <p className="text-xs text-muted-foreground">{row.body}</p>
              </div>
              <Button variant="secondary" size="sm" asChild>
                <a href={row.href}>Open</a>
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
          <p className="mt-2 text-[13px] font-medium text-foreground">Unified Inbox</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Conversation metrics arrive with the inbox module.</p>
        </section>
        <section className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-8 text-center">
          <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-md bg-surface text-muted-foreground shadow-sm">
            <BookOpen className="h-4 w-4" aria-hidden />
          </span>
          <p className="mt-2 text-[13px] font-medium text-foreground">Knowledge coverage</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Track published versions across your brands.</p>
        </section>
      </aside>
    </div>
  );
}
