'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { InternalNote } from '@/lib/api';

/**
 * Stage 7 — internal staff notes panel.
 *
 * STRICTLY separate from the customer timeline. Notes are never sent to the
 * customer, never enter a provider payload, and never enter the AI context.
 */
export function InternalNotesPanel({
  notes,
  canCreate,
  busy,
  onCreate,
  onDelete
}: {
  notes: InternalNote[];
  canCreate: boolean;
  busy: boolean;
  onCreate: (body: string) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
}) {
  const t = useTranslations('inbox');
  const [body, setBody] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(text);
      setBody('');
    } catch {
      setError(t('noteFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <p className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('notesStaffOnly')}
      </p>

      {canCreate ? (
        <form className="space-y-2" onSubmit={submit}>
          <label className="sr-only" htmlFor="internal-note">{t('notes')}</label>
          <textarea
            id="internal-note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder={t('notePlaceholder')}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={saving || body.trim().length < 1}>
              {saving ? t('saving') : t('addNote')}
            </Button>
          </div>
        </form>
      ) : null}

      {notes.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('notesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <p className="whitespace-pre-wrap text-[13px] text-foreground">{n.body}</p>
              <div className="mt-1 flex items-center justify-between text-2xs text-muted-foreground">
                <span>
                  {n.author?.name ?? n.author?.email ?? t('unknownAuthor')}
                  {' · '}
                  {n.createdAt ? new Date(n.createdAt).toLocaleString() : ''}
                </span>
                {n.canDelete ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t('deleteNote')}
                    onClick={() => onDelete(n.id)}
                    className="inline-flex items-center gap-1 text-destructive hover:underline disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
