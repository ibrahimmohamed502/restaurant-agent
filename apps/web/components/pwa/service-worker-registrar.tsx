'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/toaster';

/**
 * Registers the service worker that powers the installable PWA shell
 * (offline fallback + static asset cache).
 *
 * Safety rules:
 *   • production only — a cached dev bundle would serve stale code;
 *   • never throws — a failed registration must not break the app;
 *   • the SW itself never caches /api/* or /webhook (see public/sw.js).
 */
export function ServiceWorkerRegistrar() {
  const t = useTranslations('pwa');
  const { push } = useToast();

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    let cancelled = false;

    const notifyUpdate = () => {
      if (cancelled) return;
      push({ title: t('updateTitle'), description: t('updateBody') });
    };

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((registration) => {
          if (cancelled) return;
          registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener('statechange', () => {
              // A controller already exists → this is an UPDATE, not a first install.
              if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                notifyUpdate();
              }
            });
          });
        })
        .catch(() => undefined);
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register);
    }

    return () => {
      cancelled = true;
      window.removeEventListener('load', register);
    };
  }, [push, t]);

  return null;
}
