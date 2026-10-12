'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Field, TextArea, TextInput } from './kb-parts';

/** Section grouping for the real published LWC fields (labels resolve via i18n keys). */
export const OVERVIEW_GROUPS = [
  {
    key: 'brand',
    titleKey: 'overview.group.brand',
    fields: [
      { key: 'restaurantName', labelKey: 'overview.field.restaurantName', type: 'text' },
      { key: 'about', labelKey: 'overview.field.about', type: 'long' }
    ]
  },
  {
    key: 'menu',
    titleKey: 'overview.group.menu',
    fields: [
      { key: 'menuUrl', labelKey: 'overview.field.menuUrl', type: 'text' },
      { key: 'currency', labelKey: 'overview.field.currency', type: 'text' }
    ]
  },
  {
    key: 'service',
    titleKey: 'overview.group.service',
    fields: [
      { key: 'halal', labelKey: 'overview.field.halal', type: 'long' },
      { key: 'delivery', labelKey: 'overview.field.delivery', type: 'long' },
      { key: 'location', labelKey: 'overview.field.location', type: 'long' }
    ]
  },
  {
    key: 'reservations',
    titleKey: 'overview.group.reservations',
    fields: [
      { key: 'reservations', labelKey: 'overview.field.reservations', type: 'long' }
    ]
  }
] as const;

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
  const tk = useTranslations('knowledge');
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.key} className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <h3 className="text-[13px] font-semibold text-foreground">{tk(group.titleKey)}</h3>
            {editing ? <Pencil className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : null}
          </header>
          <dl className="divide-y divide-border">
            {group.fields.map((f) => {
              const v = value?.[f.key];
              return (
                <div key={f.key} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4 sm:py-2.5">
                  <dt className="text-[13px] font-medium text-secondary-foreground">{tk(f.labelKey)}</dt>
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
          {tk('overview.publishedNote')}
        </p>
      ) : null}
    </div>
  );
}
