'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Download, Plus, Share, Smartphone, X } from 'lucide-react';

const DISMISS_KEY = 'lwc.pwa.install.dismissedAt';
/** Re-show the hint after 30 days (new iPhones / new users). */
const REHINT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Safari only — Chrome/Firefox on iOS cannot install a home-screen app.
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && safari;
}

function dismissedRecently(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < REHINT_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * "Add to Home Screen" hint.
 *
 * • iOS Safari  → step-by-step instructions (iOS has no install API).
 * • Chrome/Edge → the native `beforeinstallprompt` prompt.
 * • Installed / dismissed → nothing is rendered.
 */
export function InstallPrompt() {
  const t = useTranslations('pwa');
  const [visible, setVisible] = React.useState(false);
  const [mode, setMode] = React.useState<'ios' | 'native' | null>(null);
  const deferred = React.useRef<BeforeInstallPromptEvent | null>(null);

  React.useEffect(() => {
    if (isStandalone()) return;
    if (dismissedRecently()) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferred.current = event as BeforeInstallPromptEvent;
      setMode('native');
      setVisible(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);

    // iOS never fires beforeinstallprompt — detect it directly.
    if (isIos()) {
      setMode('ios');
      setVisible(true);
    }

    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  const dismiss = React.useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* private mode — dismissal simply won't persist */
    }
  }, []);

  const install = React.useCallback(async () => {
    const prompt = deferred.current;
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    deferred.current = null;
    dismiss();
  }, [dismiss]);

  if (!visible || !mode) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[90] px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 sm:inset-x-auto sm:start-4 sm:max-w-sm sm:pb-3"
    >
      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3 shadow-lg">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Smartphone className="h-5 w-5" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{t('installTitle')}</p>
          {mode === 'ios' ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t('installBodyIos')}
            </p>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('installBody')}</p>
          )}

          <div className="mt-2 flex items-center gap-2">
            {mode === 'native' ? (
              <button
                type="button"
                onClick={install}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                {t('installAction')}
              </button>
            ) : (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground">
                <Share className="h-3.5 w-3.5" aria-hidden />
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t('installActionIos')}
              </span>
            )}
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {t('installDismiss')}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={dismiss}
          aria-label={t('installDismiss')}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
