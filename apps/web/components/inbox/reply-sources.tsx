'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen } from 'lucide-react';
import { aiApi, type ReplySource } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Admin-only reply sources (Stage 6 Batch 3A).
 * Resolves references against the CURRENT published knowledge via the API —
 * no knowledge is duplicated here. Renders nothing for non-admins.
 */
export function ReplySources({ messageId, canView }: { messageId: string | null | undefined; canView: boolean }) {
  const t = useTranslations('inbox');
  const [sources, setSources] = React.useState<ReplySource[] | null>(null);

  React.useEffect(() => {
    if (!canView || !messageId) return;
    let alive = true;
    aiApi
      .replySources(messageId)
      .then((rows) => { if (alive) setSources(rows); })
      .catch(() => { if (alive) setSources([]); });
    return () => { alive = false; };
  }, [canView, messageId]);

  if (!canView || !messageId || !sources || !sources.length) return null;

  return (
    <div className="mt-2 space-y-1.5 border-t border-primary-foreground/20 pt-2">
      <p className="flex items-center gap-1.5 text-2xs font-medium opacity-80">
        <BookOpen className="h-3 w-3" aria-hidden />
        {t('sources')}
      </p>
      {sources.map((s) =>
        s.sources.filter((src) => src.resolved).map((src, i) => (
          <p key={`${s.id}-${i}`} className="text-2xs opacity-80" dir="auto">
            <span className="font-medium">{sectionLabel(src.section, t)}</span>
            {s.knowledgeVersion ? ` · v${s.knowledgeVersion}` : ''}
            {src.score !== undefined ? ` · ${Math.round(Number(src.score) * 100)}%` : ''}
            {src.content ? ` · ${src.content.slice(0, 60)}` : ''}
          </p>
        ))
      )}
    </div>
  );
}

function sectionLabel(section: string | null, t: ReturnType<typeof useTranslations>): string {
  const key = (section ?? '') as 'menu' | 'branches' | 'faq' | 'policies' | 'overview';
  if (['menu', 'branches', 'faq', 'policies', 'overview'].includes(key)) {
    try { return t(`sections.${key}` as 'sections.menu'); } catch { /* fall through */ }
  }
  return section ?? '—';
}
