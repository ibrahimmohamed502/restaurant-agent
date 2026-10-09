'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Drawer, Field, TextArea, TextInput } from './kb-parts';
import { cn } from '@/lib/utils';

export type MenuItem = { name?: string; name_en?: string; name_ar?: string; desc?: string; description?: string; price?: string | number; [k: string]: unknown };
export type MenuStructure = Record<string, Record<string, MenuItem[]>>;

/* --------------------------------------------------------------- item editor */

export function ItemDrawer({
  open,
  title,
  item,
  onClose,
  onSave,
  onDelete
}: {
  open: boolean;
  title: string;
  item: MenuItem | null;
  onClose: () => void;
  onSave: (item: MenuItem) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = React.useState<MenuItem>(item ?? {});
  const [priceError, setPriceError] = React.useState<string | null>(null);
  React.useEffect(() => { setDraft(item ?? {}); setPriceError(null); }, [item, open]);

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const nameEn = String(draft.name ?? draft.name_en ?? '');
  const nameAr = String(draft.name_ar ?? '');
  const description = String(draft.desc ?? draft.description ?? '');
  const price = draft.price === undefined || draft.price === null ? '' : String(draft.price);

  const submit = () => {
    const p = price.trim();
    if (p && !/^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,3})?$/.test(p)) {
      setPriceError('أدخل سعرًا صحيحًا، مثل 4.650');
      return;
    }
    const next: MenuItem = { ...draft, price: p };
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
      footer={
        <>
          {onDelete ? (
            <Button variant="destructive" size="sm" className="me-auto gap-1.5" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> حذف
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>إلغاء</Button>
          <Button size="sm" onClick={submit}>حفظ</Button>
        </>
      }
    >
      <Field label="الاسم (إنجليزي)" htmlFor="item-name-en">
        <TextInput id="item-name-en" value={nameEn} onChange={(v) => set('name', v)} />
      </Field>
      <Field label="الاسم (عربي)" htmlFor="item-name-ar">
        <TextInput id="item-name-ar" dir="rtl" value={nameAr} onChange={(v) => set('name_ar', v)} />
      </Field>
      <Field label="الوصف" htmlFor="item-desc">
        <TextArea id="item-desc" rows={3} value={description} onChange={(v) => set('desc', v)} />
      </Field>
      <Field label="السعر (د.ك)" htmlFor="item-price" error={priceError} hint="مثال: 4.650">
        <TextInput id="item-price" dir="ltr" inputMode="decimal" value={price} onChange={(v) => set('price', v)} invalid={Boolean(priceError)} />
      </Field>
    </Drawer>
  );
}

/* -------------------------------------------------------------- menu editor */

export function MenuEditor({
  menus,
  onChange
}: {
  menus: MenuStructure;
  onChange: (menus: MenuStructure) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [editing, setEditing] = React.useState<{ category: string; sub: string; index: number } | null>(null);
  const [itemDraft, setItemDraft] = React.useState<MenuItem | null>(null);

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);

  const addCategory = () => {
    const name = window.prompt('اسم الفئة الجديدة');
    if (!name || !name.trim()) return;
    onChange({ ...menus, [name.trim()]: { 'عام': [] } });
  };
  const removeCategory = (category: string) => {
    if (!window.confirm(`حذف الفئة "${category}" وكل أصنافها؟`)) return;
    const next = { ...menus };
    delete next[category];
    onChange(next);
  };
  const addSubcategory = (category: string) => {
    const name = window.prompt('اسم القائمة الفرعية');
    if (!name || !name.trim()) return;
    onChange({ ...menus, [category]: { ...menus[category], [name.trim()]: [] } });
  };
  const removeSubcategory = (category: string, sub: string) => {
    if (!window.confirm(`حذف "${sub}" وكل أصنافها؟`)) return;
    const next = { ...menus, [category]: { ...menus[category] } };
    delete next[category][sub];
    onChange(next);
  };
  const addItem = (category: string, sub: string) => {
    setEditing({ category, sub, index: -1 });
    setItemDraft({ name: '', name_ar: '', desc: '', price: '' });
  };
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

  const categories = Object.entries(menus);
  const totalItems = categories.reduce((n, [, subs]) => n + Object.values(subs).reduce((m, items) => m + items.length, 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute inset-y-0 start-2.5 my-auto h-4 w-4 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="بحث في المنيو…" className="h-9 ps-8" aria-label="Search menu" />
        </div>
        <Button size="sm" variant="secondary" className="gap-1.5" onClick={addCategory}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> إضافة فئة
        </Button>
        <span className="text-xs text-muted-foreground">{totalItems} صنف</span>
      </div>

      {categories.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">لا توجد فئات بعد. ابدأ بإضافة فئة مثل «الإفطار».</p>
        </div>
      ) : null}

      <div className="space-y-2">
        {categories.map(([category, subs]) => {
          const subEntries = Object.entries(subs).filter(([, items]) => items.length === 0 || items.some((it) => matches(String(it.name ?? it.name_en ?? '')) || matches(String(it.name_ar ?? '')) || matches(String(it.desc ?? it.description ?? ''))) || matches(category));
          if (!subEntries.length) return null;
          return (
            <section key={category} className="overflow-hidden rounded-lg border border-border bg-surface">
              <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{category}</h3>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => addSubcategory(category)}>
                  <Plus className="h-3 w-3" aria-hidden /> قائمة فرعية
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => removeCategory(category)}>
                  حذف الفئة
                </Button>
              </header>
              {subEntries.map(([sub, items]) => (
                <div key={sub} className="border-b border-border last:border-b-0">
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <h4 className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground">{sub}</h4>
                    <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => removeSubcategory(category, sub)}>
                      حذف
                    </button>
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => addItem(category, sub)}>
                      إضافة صنف
                    </button>
                  </div>
                  {items.length ? (
                    <ul className="divide-y divide-border">
                      {items.map((item, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            onClick={() => { setEditing({ category, sub, index: i }); setItemDraft(item); }}
                            className="flex w-full items-center gap-3 px-3 py-2 text-start hover:bg-muted/60"
                          >
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{String(item.name ?? item.name_en ?? '—')}</span>
                            {item.name_ar ? <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[35%]">{String(item.name_ar)}</span> : null}
                            <span dir="ltr" className="shrink-0 text-sm tabular-nums text-foreground">{item.price === undefined || item.price === null || String(item.price).trim() === '' ? '—' : `${item.price} د.ك`}</span>
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 pb-2 text-xs text-muted-foreground">لا توجد أصناف في هذه القائمة.</p>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>

      <ItemDrawer
        open={editing !== null}
        title={editing && editing.index >= 0 ? 'تعديل صنف' : 'إضافة صنف'}
        item={itemDraft}
        onClose={() => { setEditing(null); setItemDraft(null); }}
        onSave={saveItem}
        onDelete={editing && editing.index >= 0 ? deleteItem : undefined}
      />
    </div>
  );
}

/* ------------------------------------------------------------ branch editor */

export type Branch = { name?: string; area?: string; timings?: string; maps?: string; phone?: string; [k: string]: unknown };

export function BranchEditor({ branches, onChange }: { branches: Branch[]; onChange: (branches: Branch[]) => void }) {
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<Branch | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const open = (index: number) => {
    setEditingIndex(index);
    setDraft(index >= 0 ? { ...branches[index] } : { name: '', area: '', timings: '', maps: '', phone: '' });
    setErrors({});
  };

  const save = () => {
    if (!draft) return;
    const e: Record<string, string> = {};
    const name = String(draft.name ?? draft.name_en ?? '').trim();
    if (!name) e.name = 'الاسم مطلوب';
    if (draft.maps && String(draft.maps).trim() && !/^https?:\/\/[^\s<>"')]+\.[^\s<>"')]+$/i.test(String(draft.maps).trim())) e.maps = 'رابط غير صحيح';
    if (draft.phone && String(draft.phone).trim() && !/^\+?[\d\s().-]{7,20}$/.test(String(draft.phone).trim())) e.phone = 'رقم هاتف غير صحيح';
    const duplicate = branches.some((b, i) => i !== editingIndex && String(b.name ?? b.name_en ?? '').trim().toLowerCase() === name.toLowerCase());
    if (duplicate) e.name = 'يوجد فرع بنفس الاسم';
    setErrors(e);
    if (Object.keys(e).length) return;
    const next = [...branches];
    if (editingIndex !== null && editingIndex >= 0) next[editingIndex] = draft;
    else next.push(draft);
    onChange(next);
    setEditingIndex(null);
    setDraft(null);
  };

  const remove = (index: number) => {
    if (!window.confirm(`حذف الفرع "${branches[index]?.name ?? ''}"؟`)) return;
    onChange(branches.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{branches.length} فرع</p>
        <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => open(-1)}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> إضافة فرع
        </Button>
      </div>

      {branches.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">لا توجد فروع بعد. أضف أول فرع.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {branches.map((b, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{String(b.name ?? b.name_en ?? '—')}</span>
              {b.area ? <span className="hidden text-xs text-muted-foreground sm:block">{String(b.area)}</span> : null}
              <span className="text-xs text-muted-foreground">{String(b.timings ?? '')}</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => open(i)}>تعديل</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => remove(i)}>حذف</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Drawer
        open={editingIndex !== null}
        title={editingIndex !== null && editingIndex >= 0 ? 'تعديل فرع' : 'إضافة فرع'}
        onClose={() => { setEditingIndex(null); setDraft(null); }}
        footer={<>
          <Button variant="secondary" size="sm" onClick={() => { setEditingIndex(null); setDraft(null); }}>إلغاء</Button>
          <Button size="sm" onClick={save}>حفظ</Button>
        </>}
      >
        <Field label="اسم الفرع" htmlFor="b-name" error={errors.name}>
          <TextInput id="b-name" value={String(draft?.name ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), name: v })} invalid={Boolean(errors.name)} />
        </Field>
        <Field label="المنطقة">
          <TextInput value={String(draft?.area ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), area: v })} />
        </Field>
        <Field label="مواعيد العمل" hint="مثال: 8:00 AM – 11:30 PM">
          <TextInput value={String(draft?.timings ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), timings: v })} />
        </Field>
        <Field label="رابط الخريطة" error={errors.maps}>
          <TextInput dir="ltr" inputMode="url" value={String(draft?.maps ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), maps: v })} invalid={Boolean(errors.maps)} />
        </Field>
        <Field label="الهاتف" error={errors.phone}>
          <TextInput dir="ltr" inputMode="tel" value={String(draft?.phone ?? '')} onChange={(v) => setDraft({ ...(draft ?? {}), phone: v })} invalid={Boolean(errors.phone)} />
        </Field>
      </Drawer>
    </div>
  );
}
