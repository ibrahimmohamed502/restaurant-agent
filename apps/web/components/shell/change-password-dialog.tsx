'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi } from '@/lib/api';

/** Self-service password change: current password + new password (min 8).
 *  On success every OTHER session is revoked server-side. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) { setCurrent(''); setNext(''); setConfirm(''); setError(null); }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    setError(null);
    if (!current || !next) { setError(t('passwordRequired')); return; }
    if (String(next).length < 8) { setError(t('passwordTooShort')); return; }
    if (next !== confirm) { setError(t('passwordMismatch')); return; }
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      onClose();
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? tc('retry'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('changePassword')}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="enter-up relative w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <KeyRound className="h-4 w-4 text-primary" aria-hidden />
          {t('changePassword')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('changePasswordHint')}</p>
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cp-current" className="text-[13px]">{t('currentPassword')}</Label>
            <Input id="cp-current" type="password" dir="ltr" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-new" className="text-[13px]">{t('newPassword')}</Label>
            <Input id="cp-new" type="password" dir="ltr" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-confirm" className="text-[13px]">{t('confirmPassword')}</Label>
            <Input id="cp-confirm" type="password" dir="ltr" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9" />
          </div>
          {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>{tc('cancel')}</Button>
          <Button size="sm" onClick={submit} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {t('changePassword')}
          </Button>
        </div>
      </div>
    </div>
  );
}
