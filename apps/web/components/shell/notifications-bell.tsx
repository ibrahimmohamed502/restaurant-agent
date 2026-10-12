'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bell, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ensureCsrfToken, notificationsApi } from '@/lib/api';
import { cn } from '@/lib/utils';

function relTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Stage 7 — notification bell.
 * Only ever shows the signed-in user's OWN notifications (server-enforced).
 * Clicking an item opens the referenced conversation in the Inbox.
 */
export function NotificationsBell() {
  const t = useTranslations('notifications');
  const router = useRouter();
  const [unread, setUnread] = React.useState(0);
  const [items, setItems] = React.useState<Array<{
    id: string; type: string; title: string; body: string | null;
    data: Record<string, unknown>; readAt: string | null; createdAt: string | null;
  }>>([]);
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const res = await notificationsApi.list(open);
      setUnread(res.unread);
      setItems(res.items);
      setLoaded(true);
    } catch {
      /* notifications are non-critical — never break the shell */
    }
  }, [open]);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (!open) void refresh(); }, 60000);
    return () => clearInterval(id);
  }, [refresh, open]);

  const openConversation = async (item: (typeof items)[number]) => {
    const conversationId = typeof item.data?.conversationId === 'string' ? item.data.conversationId : null;
    if (!item.readAt) {
      try {
        await ensureCsrfToken();
        await notificationsApi.markRead(item.id);
        setUnread((n) => Math.max(0, n - 1));
        setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, readAt: new Date().toISOString() } : x)));
      } catch { /* ignore */ }
    }
    setOpen(false);
    router.push(conversationId ? `/inbox?conversation=${conversationId}` : '/inbox');
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label={t('title')}
          onClick={() => setOpen(true)}
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-2xs font-semibold text-destructive-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-xs font-semibold text-foreground">{t('title')}</p>
          {unread > 0 ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
              onClick={async () => {
                try {
                  await ensureCsrfToken();
                  await notificationsApi.markAllRead();
                  await refresh();
                } catch { /* ignore */ }
              }}
            >
              <Check className="h-3 w-3" aria-hidden />
              {t('markAllRead')}
            </button>
          ) : null}
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <li className="px-3 py-8 text-center text-xs text-muted-foreground">
              {loaded ? t('empty') : t('loading')}
            </li>
          ) : null}
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => openConversation(n)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-start hover:bg-muted/60',
                  !n.readAt && 'bg-primary/5'
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-foreground">{n.title}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">{relTime(n.createdAt)}</span>
                </span>
                {n.body ? <span className="line-clamp-2 text-2xs text-muted-foreground">{n.body}</span> : null}
                {!n.readAt ? <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
