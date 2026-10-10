'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, TextArea, TextInput } from './kb-parts';
import { PolicyEditorBody } from './kb-parts';
import { Drawer } from './kb-parts';

/* ------------------------------------------------------------------- FAQs */

export type Faq = { question?: string; answer?: string; q?: string; a?: string; [k: string]: unknown };

export function FaqEditor({ faqs, readOnly, onChange, label }: { faqs: Faq[]; readOnly?: boolean; onChange: (faqs: Faq[]) => void; label: string }) {
  const tk = useTranslations('knowledge');
  const [open, setOpen] = React.useState<number | null>(null);
  const add = () => onChange([...faqs, { question: '', answer: '' }]);
  const update = (i: number, patch: Faq) => onChange(faqs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(faqs.filter((_, idx) => idx !== i));

  if (!faqs.length) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">{tk('faq.empty')}</p>
        {!readOnly ? <Button size="sm" variant="secondary" className="mt-3 gap-1.5" onClick={add}><Plus className="h-3.5 w-3.5" aria-hidden /> {tk('faq.add')}</Button> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{tk('faq.count', { count: faqs.length })}</p>
        {!readOnly ? <Button size="sm" variant="secondary" className="gap-1.5" onClick={add}><Plus className="h-3.5 w-3.5" aria-hidden /> {tk('faq.add')}</Button> : null}
      </div>
      <ul className="space-y-2">
        {faqs.map((f, i) => {
          const isOpen = open === i;
          const question = String(f.question ?? f.q ?? '');
          const answer = String(f.answer ?? f.a ?? '');
          return (
            <li key={i} className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
              <div className="flex items-start gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 text-start"
                >
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />}
                  <span className="min-w-0 flex-1 text-[13px] font-medium text-foreground">{question || tk('faq.untitled')}</span>
                </button>
                {!readOnly ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 w-7" onClick={() => setOpen(isOpen ? null : i)} aria-label={tk('faq.edit')}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => remove(i)} aria-label={tk('faq.delete')}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ) : null}
              </div>
              {isOpen ? (
                <div className="space-y-3 border-t border-border px-3 py-3">
                  <Field label={label} htmlFor={`faq-q-${i}`}>
                    <TextInput id={`faq-q-${i}`} value={question} readOnly={readOnly} onChange={(v) => update(i, f.question !== undefined ? { question: v } : { q: v })} />
                  </Field>
                  <Field label={tk('faq.field.answer')} htmlFor={`faq-a-${i}`}>
                    <TextArea id={`faq-a-${i}`} rows={3} value={answer} readOnly={readOnly} onChange={(v) => update(i, f.answer !== undefined ? { answer: v } : { a: v })} />
                  </Field>
                </div>
              ) : !readOnly ? null : (
                <p className="px-3 pb-2.5 text-xs text-muted-foreground">{answer || '—'}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- branches */

export type Branch = { name?: string; area?: string; timings?: string; maps?: string; phone?: string; [k: string]: unknown };

export function BranchEditor({ branches, readOnly, onChange }: { branches: Branch[]; readOnly?: boolean; onChange: (branches: Branch[]) => void }) {
  const tk = useTranslations('knowledge');
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<Branch | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const open = (index: number) => { setEditingIndex(index); setDraft(index >= 0 ? { ...branches[index] } : { name: '', area: '', timings: '', maps: '', phone: '' }); setErrors({}); };

  const save = () => {
    if (!draft) return;
    const e: Record<string, string> = {};
    const name = String((draft as Branch).name ?? (draft as Branch).name_en ?? '').trim();
    if (!name) e.name = tk('branches.error.name');
    if ((draft as Branch).maps && String((draft as Branch).maps).trim() && !/^https?:\/\/[^\s<>"')]+\.[^\s<>"')]+$/i.test(String((draft as Branch).maps).trim())) e.maps = tk('branches.error.maps');
    if ((draft as Branch).phone && String((draft as Branch).phone).trim() && !/^\+?[\d\s().-]{7,20}$/.test(String((draft as Branch).phone).trim())) e.phone = tk('branches.error.phone');
    if (branches.some((b, i) => i !== editingIndex && String(b.name ?? b.name_en ?? '').trim().toLowerCase() === name.toLowerCase())) e.name = tk('branches.error.duplicate');
    setErrors(e);
    if (Object.keys(e).length) return;
    const next = [...branches];
    if (editingIndex !== null && editingIndex >= 0) next[editingIndex] = draft;
    else next.push(draft);
    onChange(next);
    setEditingIndex(null);
    setDraft(null);
  };

  const remove = (index: number) => { if (!window.confirm(tk('branches.confirmDelete', { name: branches[index]?.name ?? '' }))) return; onChange(branches.filter((_, i) => i !== index)); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{tk('branches.count', { count: branches.length })}</p>
        {!readOnly ? <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => open(-1)}><Plus className="h-3.5 w-3.5" aria-hidden /> {tk('branches.add')}</Button> : null}
      </div>

      {branches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">{tk('branches.empty')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          {branches.map((b, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{String(b.name ?? b.name_en ?? '—')}</span>
              {b.area ? <span className="hidden text-xs text-muted-foreground sm:block">{String(b.area)}</span> : null}
              <span className="text-xs text-muted-foreground">{String(b.timings ?? '')}</span>
              {!readOnly ? (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => open(i)}>{tk('branches.edit')}</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => remove(i)}>{tk('branches.delete')}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Drawer
        open={editingIndex !== null}
        title={editingIndex !== null && editingIndex >= 0 ? tk('branches.editTitle') : tk('branches.newTitle')}
        onClose={() => { setEditingIndex(null); setDraft(null); }}
        footer={<>
          <Button variant="secondary" size="sm" onClick={() => { setEditingIndex(null); setDraft(null); }}>{tk('common.cancel')}</Button>
          <Button size="sm" onClick={save}>{tk('common.save')}</Button>
        </>}
      >
        <Field label={tk('branches.field.name')} htmlFor="b-name" error={errors.name}>
          <TextInput id="b-name" value={String(draft?.name ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), name: v })} invalid={Boolean(errors.name)} />
        </Field>
        <Field label={tk('branches.field.area')}>
          <TextInput value={String(draft?.area ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), area: v })} />
        </Field>
        <Field label={tk('branches.field.timings')} hint={tk('branches.field.timingsHint')}>
          <TextInput value={String(draft?.timings ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), timings: v })} />
        </Field>
        <Field label={tk('branches.field.maps')} error={errors.maps}>
          <TextInput dir="ltr" inputMode="url" value={String(draft?.maps ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), maps: v })} invalid={Boolean(errors.maps)} />
        </Field>
        <Field label={tk('branches.field.phone')} error={errors.phone}>
          <TextInput dir="ltr" inputMode="tel" value={String(draft?.phone ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), phone: v })} invalid={Boolean(errors.phone)} />
        </Field>
      </Drawer>
    </div>
  );
}

/* --------------------------------------------------------------- policies */

export type PolicyField = { key: string; label: string; kind: 'text' | 'long' | 'bool'; help?: string };

const POLICY_FIELDS: PolicyField[] = [
  { key: 'meatSources', label: 'policies.meatSources', kind: 'long' },
  { key: 'agentNotes', label: 'policies.agentNotes', kind: 'long' }
];

export function PolicyEditor({ value, editing, onChange }: { value: Record<string, unknown>; editing: boolean; onChange: (next: Record<string, unknown>) => void }) {
  const tk = useTranslations('knowledge');
  return (
    <div className="space-y-5">
      {POLICY_FIELDS.map((f) => {
        const v = value[f.key];
        const str = v === undefined || v === null ? '' : String(v);
        return (
          <section key={f.key} className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
            <header className="border-b border-border px-4 py-2.5">
              <h3 className="text-[13px] font-semibold text-foreground">{tk(f.label as 'policies.meatSources')}</h3>
            </header>
            <div className="px-4 py-3">
              {editing ? <PolicyEditorBody value={str} onChange={(nv) => onChange({ ...value, [f.key]: nv })} rows={5} /> : (
                str.trim() ? <p className="whitespace-pre-wrap text-[13px] text-foreground">{str}</p> : <span className="text-muted-foreground">—</span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- sources */

export function SourcesPanel({ source, versions }: { source: { kind: string; title: string } | null; versions: Array<{ version: number; created_at: string; published_by_name: string | null }> }) {
  const tk = useTranslations('knowledge');
  return (
    <div className="space-y-5">
      {source ? (
        <section className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground">{tk('sources.title')}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{source.title}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">{tk('sources.kind')}</dt><dd className="mt-0.5 text-foreground">{source.kind}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{tk('sources.versionCount')}</dt><dd className="mt-0.5 text-foreground">{versions.length}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{tk('sources.currentVersion')}</dt><dd className="mt-0.5 text-foreground">{versions[0] ? `v${versions[0].version}` : '—'}</dd></div>
          </dl>
        </section>
      ) : null}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">{tk('sources.history')}</h3>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tk('sources.noHistory')}</p>
        ) : (
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
            {versions.map((v, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className={i === 0 ? 'inline-flex h-6 items-center rounded-md border border-success/30 bg-success/10 px-2 text-xs font-medium text-success' : 'inline-flex h-6 items-center rounded-md border border-border bg-surface-2 px-2 text-xs font-medium text-muted-foreground'}>
                  v{v.version}
                </span>
                <span className="text-muted-foreground">{new Date(v.created_at).toLocaleString('en-GB', { hour12: false })}</span>
                <span className="ms-auto text-muted-foreground">{v.published_by_name ?? '—'}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
