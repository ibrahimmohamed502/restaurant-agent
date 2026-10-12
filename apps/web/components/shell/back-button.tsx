'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Consistent back control for inner/workspace pages.
 * History-back when safe, with a parent-route fallback. Direction-aware arrow.
 */
export function BackButton({ fallback = '/dashboard', className }: { fallback?: string; className?: string }) {
  const t = useTranslations('common');
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      aria-label={t('back')}
      title={t('back')}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        className
      )}
    >
      <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
      {t('back')}
    </button>
  );
}
