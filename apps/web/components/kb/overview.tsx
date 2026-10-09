'use client';

import * as React from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Field, TextArea, TextInput } from './kb-parts';

/** Section grouping for the real published LWC fields. */
export const OVERVIEW_GROUPS = [
  {
    key: 'brand',
    title: 'معلومات العلامة',
    fields: [
      { key: 'restaurantName', label: 'اسم المطعم / العلامة', type: 'text' },
      { key: 'about', label: 'نبذة عن المطعم', type: 'long' }
    ]
  },
  {
    key: 'menu',
    title: 'معلومات المنيو',
    fields: [
      { key: 'menuUrl', label: 'رابط المنيو', type: 'text' },
      { key: 'currency', label: 'العملة', type: 'text' }
    ]
  },
  {
    key: 'service',
    title: 'معلومات الخدمة',
    fields: [
      { key: 'halal', label: 'معلومات الحلال', type: 'long' },
      { key: 'delivery', label: 'التوصيل / الخدمة', type: 'long' },
      { key: 'location', label: 'الموقع', type: 'long' }
    ]
  },
  {
    key: 'reservations',
    title: 'الحجوزات',
    fields: [
      { key: 'reservations', label: 'سياسة الحجوزات', type: 'long' }
    ]
  }
];

function isEmptyValue(v: unknown) {
  return v === undefined || v === null || String(v).trim() === '';
}

/** Published → readable information panels. Draft → structured form controls. */
export function OverviewWorkspace({
  value,
  groups,
  editing,
  onChange
}: {
  value: Record<string, unknown>;
  groups: typeof OVERVIEW_GROUPS;
  editing: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.key} className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <h3 className="text-[13px] font-semibold text-foreground">{group.title}</h3>
            {editing ? <Pencil className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : null}
          </header>
          <dl className="divide-y divide-border">
            {group.fields.map((f) => {
              const v = value?.[f.key];
              return (
                <div key={f.key} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4 sm:py-2.5">
                  <dt className="text-[13px] font-medium text-secondary-foreground">{f.label}</dt>
                  <dd className="min-w-0 text-[13px] text-foreground">
                    {editing ? (
                      f.type === 'long' ? (
                        <TextArea rows={3} value={isEmptyValue(v) ? '' : String(v)} onChange={(nv) => onChange({ ...value, [f.key]: nv })} />
                      ) : (
                        <TextInput value={isEmptyValue(v) ? '' : String(v)} onChange={(nv) => onChange({ ...value, [f.key]: nv })} />
                      )
                    ) : isEmptyValue(v) ? (
                      <span className="text-muted-foreground">—</span>
                    ) : f.key === 'menuUrl' ? (
                      <a href={String(v)} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline" dir="ltr">{String(v)}</a>
                    ) : (
                      <span className="whitespace-pre-wrap">{String(v)}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
      {!editing ? (
        <p className="text-xs text-muted-foreground">
          أنت تشاهد النسخة المنشورة. أنشئ مسودة لإجراء تعديلات.
        </p>
      ) : null}
    </div>
  );
}
