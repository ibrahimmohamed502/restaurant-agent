'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Command, Search } from 'lucide-react';
import { NAV_ITEMS } from '@/lib/navigation';
import { cn } from '@/lib/utils';

type Item = { key: string; label: string; hint?: string; href: string };

/**
 * ⌘K / Ctrl+K command palette — quick navigation across the SaaS shell.
 * Frontend-only; uses the existing navigation map and translated labels.
 */
export function CommandPalette({ open, onClose, isSuperAdmin }: { open: boolean; onClose: () => void; isSuperAdmin: boolean }) {
  const t = useTranslations('command');
  const tNav = useTranslations('nav');
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const items: Item[] = React.useMemo(
    () =>
      NAV_ITEMS.filter((i) => !i.superAdminOnly || isSuperAdmin).map((i) => ({
        key: i.key,
        label: tNav(i.key),
        hint: tNav(i.key),
        href: i.href
      })),
    [tNav, isSuperAdmin]
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.href.toLowerCase().includes(q)) : items;
    return list.slice(0, 10);
  }, [items, query]);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const id = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(id);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[active];
        if (item) { router.push(item.href); onClose(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, filtered, active, router, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={t('title')}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div className="enter-up relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            placeholder={t('placeholder')}
            aria-label={t('title')}
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground sm:flex">
            <Command className="h-3 w-3" aria-hidden />K
          </kbd>
        </div>

        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('noResults')}</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto p-2">
            {filtered.map((item, i) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => { router.push(item.href); onClose(); }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-start text-[13px] font-medium transition-colors',
                    i === active ? 'bg-primary/10 text-primary' : 'text-secondary-foreground hover:bg-muted'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-2xs text-muted-foreground">
          <span>{t('hint')}</span>
          <span>{t('shortcut')}</span>
        </div>
      </div>
    </div>
  );
}

/** Global ⌘K/Ctrl+K listener. */
export function useCommandPalette(): [boolean, () => void] {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return [open, () => setOpen(false)];
}
