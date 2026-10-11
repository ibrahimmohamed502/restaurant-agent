'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Check, Loader2, Lock, Save, ShieldAlert } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, PageLoading } from '@/components/ui/states';
import { aiApi, type AiConfig } from '@/lib/api';

const TONES: Array<{ value: AiConfig['tone']; labelKey: string }> = [
  { value: 'professional', labelKey: 'tone.professional' },
  { value: 'friendly', labelKey: 'tone.friendly' },
  { value: 'custom', labelKey: 'tone.custom' }
];

export default function AiPage() {
  const t = useTranslations('ai');
  const tc = useTranslations('common');

  const [config, setConfig] = React.useState<AiConfig | null>(null);
  const [canEdit, setCanEdit] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  // form state
  const [tone, setTone] = React.useState<AiConfig['tone']>('professional');
  const [languages, setLanguages] = React.useState<string[]>(['ar', 'en']);
  const [customInstructions, setCustomInstructions] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [cfg, me] = await Promise.all([
        aiApi.config(),
        import('@/lib/api').then((m) => m.authApi.me())
      ]);
      setConfig(cfg);
      if (cfg) {
        setTone(cfg.tone);
        setLanguages(cfg.languages);
        setCustomInstructions(cfg.customInstructions);
      }
      setCanEdit((me?.roles ?? []).includes('Company Admin'));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const updated = await aiApi.saveConfig({ tone, languages, customInstructions });
      setConfig(updated);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav')} breadcrumb={<BackButton />} />
        <PageLoading />
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav')} breadcrumb={<BackButton />} />
        <ErrorState title={t('errors.title')} description={t('errors.description')} actionLabel={tc('retry')} onAction={load} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('nav')} description={t('description')} breadcrumb={<BackButton />} />

      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Bot className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{config?.agentName ?? t('agentName')}</h2>
            <p className="text-xs text-muted-foreground">{t('agentSubtitle')}</p>
          </div>
        </header>

        <div className="space-y-5 p-4">
          {/* tone */}
          <div className="space-y-2">
            <Label className="text-[13px]">{t('tone')}</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {TONES.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setTone(opt.value)}
                  className={`rounded-md border px-3 py-2.5 text-start text-[13px] font-medium transition-colors disabled:cursor-default ${
                    tone === opt.value ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-surface text-secondary-foreground hover:bg-muted'
                  }`}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* custom instructions */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-custom" className="text-[13px]">{t('customInstructions')}</Label>
            <textarea
              id="ai-custom"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              disabled={!canEdit}
              rows={4}
              placeholder={t('customPlaceholder')}
              className="w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-70"
            />
            <p className="text-xs text-muted-foreground">{t('customHint')}</p>
          </div>

          {/* languages */}
          <div className="space-y-2">
            <Label className="text-[13px]">{t('languages')}</Label>
            <div className="flex gap-2">
              {['ar', 'en'].map((l) => (
                <label key={l} className="flex items-center gap-2 text-[13px] text-secondary-foreground">
                  <input
                    type="checkbox"
                    checked={languages.includes(l)}
                    disabled={!canEdit}
                    onChange={(e) => setLanguages((ls) => (e.target.checked ? [...ls, l] : ls.filter((x) => x !== l)))}
                    className="h-4 w-4 rounded border-border"
                  />
                  {l === 'ar' ? 'العربية' : 'English'}
                </label>
              ))}
            </div>
          </div>

          {/* fallback policy — backend-managed, read-only */}
          <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{t('fallbackPolicy')}</p>
              <p className="text-xs text-muted-foreground">{t('fallbackPolicyNote')}</p>
            </div>
          </div>

          {!canEdit ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" aria-hidden /> {t('readOnly')}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={busy} className="gap-1.5">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
                {t('save')}
              </Button>
              {saved ? (
                <span className="flex items-center gap-1 text-xs text-success">
                  <Check className="h-3.5 w-3.5" aria-hidden /> {t('saved')}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
