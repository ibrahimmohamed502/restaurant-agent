'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, TextArea, TextInput } from './kb-parts';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------- FAQs */

export type Faq = { question?: string; answer?: string; q?: string; a?: string; [k: string]: unknown };

export function FaqEditor({ faqs, onChange, label }: { faqs: Faq[]; onChange: (faqs: Faq[]) => void; label: string }) {
  const add = () => onChange([...faqs, { question: '', answer: '' }]);
  const update = (i: number, patch: Faq) => onChange(faqs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(faqs.filter((_, idx) => idx !== i));

  if (!faqs.length) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">لا توجد أسئلة شائعة بعد.</p>
        <Button size="sm" variant="secondary" className="mt-3 gap-1.5" onClick={add}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> إضافة سؤال
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{faqs.length} سؤال</p>
        <Button size="sm" variant="secondary" className="gap-1.5" onClick={add}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> إضافة سؤال
        </Button>
      </div>
      <ul className="space-y-2">
        {faqs.map((f, i) => (
          <li key={i} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-start gap-2">
              <Field label={label} htmlFor={`faq-q-${i}`}>
                <TextInput id={`faq-q-${i}`} value={String(f.question ?? f.q ?? '')} onChange={(v) => update(i, f.question !== undefined ? { question: v } : { q: v })} />
              </Field>
              <Button size="icon" variant="ghost" className="mt-6 h-9 w-9 text-destructive" onClick={() => remove(i)} aria-label="Delete FAQ">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-2">
              <Field label="الإجابة" htmlFor={`faq-a-${i}`}>
                <TextArea id={`faq-a-${i}`} rows={3} value={String(f.answer ?? f.a ?? '')} onChange={(v) => update(i, f.answer !== undefined ? { answer: v } : { a: v })} />
              </Field>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- policies */

export type PolicyField = { key: string; label: string; kind: 'text' | 'long' | 'bool'; help?: string };

/** Structured editor for the existing top-level policy/service fields. */
export function PolicyEditor({
  fields,
  value,
  onChange
}: {
  fields: PolicyField[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [boolOpen, setBoolOpen] = React.useState<Record<string, boolean>>({});
  return (
    <div className="space-y-5">
      {fields.map((f) => {
        const v = value[f.key];
        const str = v === undefined || v === null ? '' : String(v);
        return (
          <div key={f.key}>
            {f.kind === 'long' ? (
              <Field label={f.label} htmlFor={`p-${f.key}`} hint={f.help}>
                <TextArea id={`p-${f.key}`} rows={3} value={str} onChange={(nv) => onChange({ ...value, [f.key]: nv })} />
              </Field>
            ) : f.kind === 'bool' ? (
              <div className="flex items-start gap-3 rounded-md border border-border bg-surface p-3">
                <input
                  id={`p-${f.key}`}
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input"
                  checked={str.toLowerCase() === 'true'}
                  onChange={(e) => onChange({ ...value, [f.key]: e.target.checked ? 'true' : 'false' })}
                />
                <div>
                  <label htmlFor={`p-${f.key}`} className="text-[13px] font-medium text-foreground">{f.label}</label>
                  {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
                  {str && str.toLowerCase() !== 'true' && str.toLowerCase() !== 'false' ? (
                    <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setBoolOpen((s) => ({ ...s, [f.key]: !s[f.key] }))}>
                      {boolOpen[f.key] ? 'إخفاء النص الأصلي' : 'عرض النص الأصلي'}
                    </button>
                  ) : null}
                  {boolOpen[f.key] ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{str}</p> : null}
                </div>
              </div>
            ) : (
              <Field label={f.label} htmlFor={`p-${f.key}`} hint={f.help}>
                <TextInput id={`p-${f.key}`} value={str} onChange={(nv) => onChange({ ...value, [f.key]: nv })} />
              </Field>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- sources */

export function SourcesPanel({ source, versions }: { source: { kind: string; title: string } | null; versions: Array<{ version: number; created_at: string; published_by_name: string | null }> }) {
  return (
    <div className="space-y-5">
      {source ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h3 className="text-sm font-semibold text-foreground">مصدر المعرفة</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{source.title}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">النوع</dt><dd className="text-foreground">{source.kind}</dd></div>
            <div><dt className="text-xs text-muted-foreground">عدد الإصدارات</dt><dd className="text-foreground">{versions.length}</dd></div>
          </dl>
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">سجل النشر</h3>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">لم يتم النشر بعد.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {versions.map((v, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className={cn('inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium', i === 0 ? 'border-success/30 bg-success/10 text-success' : 'border-border bg-surface-2 text-muted-foreground')}>
                  v{v.version}
                </span>
                <span className="text-muted-foreground">{new Date(v.created_at).toLocaleString('en-GB', { hour12: false })}</span>
                <span className="ms-auto text-muted-foreground">{v.published_by_name ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
