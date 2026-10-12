'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Drawer, Field, TextArea, TextInput } from './kb-parts';
import { cn } from '@/lib/utils';

export type MenuItem = { name?: string; name_en?: string; name_ar?: string; desc?: string; description?: string; price?: string | number; [k: string]: unknown };
export type MenuStructure = Record<string, Record<string, MenuItem[]>>;

function ItemDrawer({ open, title, item, onClose, onSave, onDelete }: {
  open: boolean;
  title: string;
  item: MenuItem | null;
  onClose: () => void;
  onSave: (item: MenuItem) => void;
  onDelete?: () => void;
}) {
  const tk = useTranslations('knowledge');
  const [draft, setDraft] = React.useState(item ?? {});
  const [priceError, setPriceError] = React.useState<string | null>(null);
  React.useEffect(() => { setDraft(item ?? {}); setPriceError(null); }, [item, open]);

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const nameEn = String(draft.name ?? draft.name_en ?? '');
  const nameAr = String(draft.name_ar ?? '');
  const description = String(draft.desc ?? draft.description ?? '');
  const price = draft.price === undefined || draft.price === null ? '' : String(draft.price);

  const submit = () => {
    const p = price.trim();
    if (p && !/^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,3})?$/.test(p)) { setPriceError(tk('menu.priceError')); return; }
    const next = { ...draft, price: p };
    if (draft.name !== undefined) next.name = nameEn;
    if (draft.name_en !== undefined) next.name_en = nameEn;
    if (draft.name_ar !== undefined) next.name_ar = nameAr;
    if (draft.desc !== undefined) next.desc = description;
    if (draft.description !== undefined) next.description = description;
    onSave(next);
  };

  return (
    <Drawer
      open={open}
      title={title}
      onClose={onClose}
      footer={<>
        {onDelete ? <Button variant="destructive" size="sm" className="me-auto gap-1.5" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" aria-hidden /> {tk('menu.deleteItem')}</Button> : null}
        <Button variant="secondary" size="sm" onClick={onClose}>{tk('common.cancel')}</Button>
        <Button size="sm" onClick={submit}>{tk('common.save')}</Button>
      </>}
    >
      <Field label={tk('menu.field.nameEn')} htmlFor="item-name-en">
        <TextInput id="item-name-en" value={nameEn} onChange={(v) => set('name', v)} />
      </Field>
      <Field label={tk('menu.field.nameAr')} htmlFor="item-name-ar">
        <TextInput id="item-name-ar" dir="rtl" value={nameAr} onChange={(v) => set('name_ar', v)} />
      </Field>
      <Field label={tk('menu.field.desc')} htmlFor="item-desc">
        <TextArea id="item-desc" rows={3} value={description} onChange={(v) => set('desc', v)} />
      </Field>
      <Field label={tk('menu.field.price')} htmlFor="item-price" error={priceError} hint={tk('menu.field.priceHint')}>
        <TextInput id="item-price" dir="ltr" inputMode="decimal" value={price} onChange={(v) => set('price', v)} invalid={Boolean(priceError)} />
      </Field>
    </Drawer>
  );
}

/** Category rail + compact item rows; drawer editor for add/edit. */
export function MenuEditor({ menus, readOnly, onChange }: { menus: MenuStructure; readOnly?: boolean; onChange: (menus: MenuStructure) => void }) {
  const tk = useTranslations('knowledge');
  const [query, setQuery] = React.useState('');
  const [activeCat, setActiveCat] = React.useState<string | null>(() => Object.keys(menus)[0] ?? null);
  const [editing, setEditing] = React.useState<{ category: string; sub: string; index: number } | null>(null);
  const [itemDraft, setItemDraft] = React.useState<MenuItem | null>(null);

  React.useEffect(() => {
    if (!activeCat || !(activeCat in menus)) setActiveCat(Object.keys(menus)[0] ?? null);
  }, [menus, activeCat]);

  const q = query.trim().toLowerCase();
  const categories = Object.entries(menus);
  const totalItems = categories.reduce((n, [, subs]) => n + Object.values(subs).reduce((m, items) => m + items.length, 0), 0);

  const addCategory = () => {
    const name = window.prompt(tk('menu.promptNewCategory'));
    if (!name || !name.trim()) return;
    onChange({ ...menus, [name.trim()]: { 'عام': [] } });
    setActiveCat(name.trim());
  };
  const removeCategory = (category: string) => {
    if (!window.confirm(tk('menu.confirmDeleteCategory', { name: category }))) return;
    const next = { ...menus };
    delete next[category];
    onChange(next);
  };
  const addSubcategory = (category: string) => {
    const name = window.prompt(tk('menu.promptNewSubcategory'));
    if (!name || !name.trim()) return;
    onChange({ ...menus, [category]: { ...menus[category], [name.trim()]: [] } });
  };
  const removeSubcategory = (category: string, sub: string) => {
    if (!window.confirm(tk('menu.confirmDeleteSubcategory', { name: sub }))) return;
    const next = { ...menus, [category]: { ...menus[category] } };
    delete next[category][sub];
    onChange(next);
  };
  const addItem = (category: string, sub: string) => { setEditing({ category, sub, index: -1 }); setItemDraft({ name: '', name_ar: '', desc: '', price: '' }); };
  const saveItem = (item: MenuItem) => {
    if (!editing) return;
    const items = [...(menus[editing.category]?.[editing.sub] ?? [])];
    if (editing.index >= 0) items[editing.index] = item;
    else items.push(item);
    onChange({ ...menus, [editing.category]: { ...menus[editing.category], [editing.sub]: items } });
    setEditing(null);
    setItemDraft(null);
  };
  const deleteItem = () => {
    if (!editing) return;
    const items = [...(menus[editing.category]?.[editing.sub] ?? [])];
    items.splice(editing.index, 1);
    onChange({ ...menus, [editing.category]: { ...menus[editing.category], [editing.sub]: items } });
    setEditing(null);
    setItemDraft(null);
  };

  const subEntries = React.useMemo(() => {
    if (!activeCat) return [] as Array<[string, MenuItem[]]>;
    return Object.entries(menus[activeCat] ?? {})
      .map(([sub, items]) => {
        const list = (items ?? []) as MenuItem[];
        const filtered = q
          ? list.filter((it) => String(it.name ?? it.name_en ?? '').toLowerCase().includes(q) || String(it.name_ar ?? '').toLowerCase().includes(q) || String(it.desc ?? it.description ?? '').toLowerCase().includes(q))
          : list;
        return [sub, filtered] as [string, MenuItem[]];
      })
      .filter(([, items]) => items.length > 0);
  }, [menus, activeCat, q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute inset-y-0 start-2.5 my-auto h-4 w-4 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tk('menu.search')} className="h-9 ps-8" aria-label={tk('menu.search')} />
        </div>
        {!readOnly ? (
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={addCategory}><Plus className="h-3.5 w-3.5" aria-hidden /> {tk('menu.addCategory')}</Button>
        ) : null}
        <span className="text-xs text-muted-foreground">{tk('menu.counter', { items: totalItems, categories: categories.length })}</span>
      </div>

      {categories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">{tk('menu.noCategories')}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[11rem_1fr]">
          {/* category rail */}
          <nav aria-label={tk('menu.categories')} className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {categories.map(([category, subs]) => {
              const count = Object.values(subs).reduce((n, items) => n + items.length, 0);
              const active = activeCat === category;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCat(category)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex shrink-0 items-center justify-between gap-2 rounded-md border px-3 py-2 text-start text-[13px] font-medium transition-colors lg:w-full',
                    active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-surface text-secondary-foreground hover:bg-muted'
                  )}
                >
                  <span className="truncate">{category}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </nav>

          {/* items */}
          <div className="min-w-0 space-y-3">
            {activeCat ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">{activeCat}</h3>
                {!readOnly ? (
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => activeCat && addSubcategory(activeCat)}><Plus className="h-3 w-3" aria-hidden /> {tk('menu.addSubcategory')}</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => activeCat && removeCategory(activeCat)}>{tk('menu.deleteCategory')}</Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {subEntries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">{tk('menu.noMatches')}</p>
              </div>
            ) : null}

            {subEntries.map(([sub, subItems]) => (
              <section key={sub} className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
                <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
                  <h4 className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{sub}</h4>
                  {!readOnly ? (
                    <>
                      <button type="button" className="text-2xs text-muted-foreground hover:text-destructive" onClick={() => activeCat && removeSubcategory(activeCat, sub)}>{tk('menu.deleteSubcategory')}</button>
                      <button type="button" className="text-2xs text-primary hover:underline" onClick={() => activeCat && addItem(activeCat, sub)}>{tk('menu.addItem')}</button>
                    </>
                  ) : null}
                </header>
                <ul className="divide-y divide-border">
                  {subItems.map((item, i) => (
                    <li key={String(item.name ?? item.name_en ?? i)}>
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => { const realIndex = activeCat ? (menus[activeCat][sub] ?? []).indexOf(item) : -1; if (activeCat) setEditing({ category: activeCat, sub, index: realIndex }); setItemDraft(item); }}
                        className="flex w-full items-center gap-3 px-3 py-2 text-start transition-colors enabled:hover:bg-muted/60 disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{String(item.name ?? item.name_en ?? '—')}</span>
                        {item.name_ar ? <span className="hidden min-w-0 max-w-[35%] truncate text-xs text-muted-foreground sm:block">{String(item.name_ar)}</span> : null}
                        <span dir="ltr" className="shrink-0 text-[13px] font-medium tabular-nums text-foreground">
                          {item.price === undefined || item.price === null || String(item.price).trim() === '' ? '—' : `${item.price} ${tk('menu.currency')}`}
                        </span>
                        {!readOnly ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      <ItemDrawer
        open={editing !== null}
        title={editing && editing.index >= 0 ? tk('menu.editItem') : tk('menu.newItem')}
        item={itemDraft}
        onClose={() => { setEditing(null); setItemDraft(null); }}
        onSave={saveItem}
        onDelete={editing && editing.index >= 0 ? deleteItem : undefined}
      />
    </div>
  );
}
