'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Draft, Review, ValidationError } from '@/lib/knowledge-api';
import { VALIDATION_MESSAGES } from '@/lib/knowledge-api';

/* -------------------------------------------------------------- field prims */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[13px]">
        {label}
      </Label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  dir,
  type = 'text',
  inputMode,
  readOnly
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  dir?: 'ltr' | 'rtl';
  type?: string;
  inputMode?: 'text' | 'decimal' | 'tel' | 'url' | 'numeric';
  readOnly?: boolean;
}) {
  return (
    <Input
      id={id}
      type={type}
      inputMode={inputMode}
      dir={dir}
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      className="h-9"
    />
  );
}

export function TextArea({
  id,
  value,
  onChange,
  rows = 4,
  placeholder,
  readOnly
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  readOnly?: boolean;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      className="flex w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:opacity-70"
    />
  );
}

/** Editable textarea for policy sections. */
export function PolicyEditorBody({ value, onChange, rows = 4 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return <TextArea value={value} onChange={onChange} rows={rows} />;
}

/* ------------------------------------------------------------------- drawer */

export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="relative ms-auto flex h-full w-full max-w-md flex-col border-s border-border bg-surface shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-border p-4">{footer}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- validation */

export function ValidationPanel({ errors, title, onJump }: { errors: ValidationError[]; title: string; onJump?: (section: string) => void }) {
  const [open, setOpen] = React.useState(true);
  if (!errors.length) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        {title}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-warning/30 bg-warning/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
          {title}
          <span className="text-xs text-muted-foreground">
            {errors.length === 1 ? 'مشكلة واحدة' : `${errors.length} مشكلات`}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">{open ? 'إخفاء' : 'عرض'}</span>
      </button>
      {open ? (
        <ul className="divide-y divide-border border-t border-border">
          {errors.slice(0, 50).map((e, i) => (
            <li key={`${e.path}-${i}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="text-foreground">
                <span className="text-muted-foreground">{sectionLabel(e.section)}</span>
                {e.field ? ` · ${e.field}` : ''}
                {' — '}
                {VALIDATION_MESSAGES[e.messageKey]?.ar ?? e.messageKey}
              </span>
              {onJump ? (
                <Button variant="ghost" size="sm" onClick={() => onJump(e.section)}>
                  انتقال
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function sectionLabel(section: string): string {
  return ({ overview: 'نظرة عامة', menu: 'المنيو', branches: 'الفروع', faq: 'الأسئلة الشائعة', policies: 'السياسات', sources: 'المصادر', root: 'عام' } as Record<string, string>)[section] ?? section;
}

/* ------------------------------------------------------------------ dialog */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'إلغاء',
  destructive,
  busy,
  onConfirm,
  onCancel,
  children
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} aria-hidden />
      <div className="relative w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        {children ? <div className="mt-3 text-sm text-foreground">{children}</div> : null}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className="gap-1.5"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- skeletons */

export function KbSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-5 w-48" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

export function ReviewList({ review }: { review: Review }) {
  const rows = review.items ?? [];
  if (!rows.length) return <p className="text-sm text-muted-foreground">لا توجد تغييرات مقارنة بالإصدار المنشور.</p>;
  const tone = { added: 'text-success', modified: 'text-warning', removed: 'text-destructive' } as const;
  const label = { added: 'إضافة', modified: 'تعديل', removed: 'حذف' } as const;
  return (
    <ul className="divide-y divide-border">
      {rows.map((c, i) => (
        <li key={`${c.path}-${i}`} className="flex items-baseline justify-between gap-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="ltr">{c.path.replace(/^\./, '') || '/'}</span>
          <span className={cn('shrink-0 text-xs font-medium', tone[c.type])}>{label[c.type]}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {c.type === 'modified' ? `${c.from} → ${c.to}` : (c.value ?? '')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PreviewSummary({ draft }: { draft: Draft }) {
  const c = draft.content as Record<string, unknown>;
  const menus = (c?.menus ?? {}) as Record<string, unknown>;
  const menuCount = Object.values(menus).reduce<number>((n, subs) => {
    if (!subs || typeof subs !== 'object') return n;
    return n + Object.keys(subs as object).length;
  }, 0);
  const branches = Array.isArray(c?.branches) ? (c.branches as unknown[]).length : 0;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="فئات المنيو" value={String(Object.keys(menus).length)} />
      <Stat label="القوائم الفرعية" value={String(menuCount)} />
      <Stat label="الفروع" value={String(branches)} />
      <Stat label="إصدار الأساس" value={`v${draft.baseVersion}`} />
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-foreground">{value}</dd>
    </div>
  );
}

export { Separator };
