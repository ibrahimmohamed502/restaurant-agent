'use client';

import * as React from 'react';

type Toast = { id: string; title: string; description?: string; variant?: 'default' | 'destructive' };
type ToastContextValue = { toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: string) => void };

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const push = React.useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((cur) => [...cur, { ...t, id }]);
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismiss = React.useCallback((id: string) => setToasts((cur) => cur.filter((x) => x.id !== id)), []);
  const value = React.useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 z-[100] flex w-full max-w-sm flex-col gap-2 end-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg ${
              t.variant === 'destructive' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-surface text-foreground'
            }`}
            role="status"
          >
            <p className="font-medium">{t.title}</p>
            {t.description ? <p className="text-xs text-muted-foreground">{t.description}</p> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
