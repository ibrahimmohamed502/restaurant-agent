'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** Persistent status strip: what brand is being edited, published vs draft state. */
export function KbStatusBar({
  brandLabel,
  publishedVersion,
  draftState,
  saveState,
  errorCount,
  className
}: {
  brandLabel: string;
  publishedVersion: number | null;
  draftState: 'none' | 'draft';
  saveState: SaveState;
  errorCount: number | null;
  className?: string;
}) {
  const state = draftState === 'draft'
    ? saveState === 'dirty'
      ? { tone: 'warning', label: { en: 'Draft · Unsaved changes', ar: 'مسودة · تغييرات غير محفوظة' } }
      : saveState === 'saving'
        ? { tone: 'info', label: { en: 'Saving…', ar: 'جارٍ الحفظ…' } }
        : saveState === 'saved'
          ? { tone: 'success', label: { en: 'Draft saved', ar: 'تم حفظ المسودة' } }
          : saveState === 'error'
            ? { tone: 'destructive', label: { en: 'Save failed', ar: 'فشل الحفظ' } }
            : { tone: 'neutral', label: { en: 'Draft', ar: 'مسودة' } }
    : publishedVersion
      ? { tone: 'success', label: { en: `Published · v${publishedVersion}`, ar: `منشور · الإصدار ${publishedVersion}` } }
      : { tone: 'neutral', label: { en: 'No published version', ar: 'لا يوجد إصدار منشور' } };

  const toneClass = {
    neutral: 'border-border bg-surface-2 text-muted-foreground',
    info: 'border-info/30 bg-info/10 text-info',
    success: 'border-success/30 bg-success/10 text-success',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    destructive: 'border-destructive/30 bg-destructive/10 text-destructive'
  }[state.tone as 'neutral'];

  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3', className)}>
      <div className="text-sm font-medium text-foreground">{brandLabel}</div>
      <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium', toneClass)}>{state.label.ar}</span>
      {errorCount !== null && errorCount > 0 ? (
        <span className="inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          {errorCount === 1 ? 'مشكلة واحدة تحتاج انتباهك' : `${errorCount} مشكلات تحتاج انتباهك`}
        </span>
      ) : null}
    </div>
  );
}

const ACTION_BASE = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50';

const ACTION_VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'border border-border bg-surface text-foreground hover:bg-muted',
  destructive: 'border border-destructive/40 text-destructive hover:bg-destructive/10'
} as const;

export type KbAction = {
  key: string;
  label: string;
  onClick: () => void;
  variant?: keyof typeof ACTION_VARIANTS;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
};

/** Sticky action bar — always visible, disabled states reflect the real workflow. */
export function KbActionBar({ actions, className }: { actions: KbAction[]; className?: string }) {
  return (
    <div className={cn('sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:-mx-6 lg:px-6', className)}>
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-end gap-2">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            disabled={a.disabled || a.busy}
            title={a.title}
            className={cn(ACTION_BASE, ACTION_VARIANTS[a.variant ?? 'secondary'])}
          >
            {a.busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Navigation for the knowledge workspace (vertical rail on desktop). */
export function KbSectionNav({
  sections,
  active,
  onChange
}: {
  sections: Array<{ key: string; label: string; badge?: string; icon?: React.ComponentType<{ className?: string }> }>;
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <nav aria-label="Knowledge sections" className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
      {sections.map((s) => {
        const Icon = s.icon;
        const isActive = active === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-start text-[13px] font-medium transition-colors duration-[--dur-fast] lg:w-full',
              isActive ? 'bg-primary/10 text-primary' : 'text-secondary-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {isActive ? <span className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" aria-hidden /> : null}
            {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
            <span className="truncate">{s.label}</span>
            {s.badge ? <span className="ms-auto text-2xs text-muted-foreground">{s.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
