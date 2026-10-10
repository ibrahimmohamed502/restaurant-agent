'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, BookOpen, Eye, GitBranch, Pencil, Store } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageLoading } from '@/components/ui/states';
import { useToast } from '@/components/ui/toaster';
import { KbActionBar, KbSectionNav, KbStatusBar, type KbAction, type SaveState } from '@/components/kb/kb-shell';
import { ConfirmDialog, KbSkeleton, PreviewSummary, ReviewList, ValidationPanel } from '@/components/kb/kb-parts';
import { MenuEditor } from '@/components/kb/menu-editor';
import { BranchEditor, FaqEditor, PolicyEditor, SourcesPanel, type Faq, type PolicyField } from '@/components/kb/editors';
import { OverviewWorkspace, OVERVIEW_GROUPS } from '@/components/kb/overview';
import { knowledgeApi, type KnowledgeOverview, type ValidationError, type Review } from '@/lib/knowledge-api';

type SectionKey = 'overview' | 'menu' | 'branches' | 'faq' | 'policies' | 'sources';

/** Fields that exist in the published LWC document, grouped for a premium workspace. */
export default function KnowledgePage() {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const tk = useTranslations('knowledge');
  const router = useRouter();
  const { push } = useToast();

  const [overview, setOverview] = React.useState<KnowledgeOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);

  const [section, setSection] = React.useState<SectionKey>('overview');
  const [content, setContent] = React.useState<Record<string, unknown> | null>(null);
  const [baseline, setBaseline] = React.useState('');
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [errors, setErrors] = React.useState<ValidationError[]>([]);
  const [review, setReview] = React.useState<Review | null>(null);
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const [dialog, setDialog] = React.useState<null | 'publish' | 'discard' | 'unsaved'>(null);
  const [pendingSection, setPendingSection] = React.useState<SectionKey | null>(null);

  /* ------------------------------------------------------------- loading */
  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await knowledgeApi.overview();
      setOverview(data);
      const base = data.draft?.content ?? data.published?.structured ?? null;
      setContent(base);
      setBaseline(JSON.stringify(base));
      setSaveState('idle');
      setErrors([]);
      setReview(null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const dirty = content !== null && JSON.stringify(content) !== baseline;
  const canEdit = overview?.permissions.canEdit ?? false;
  const canPublish = overview?.permissions.canPublish ?? false;
  const hasDraft = Boolean(overview?.draft && overview.draft.status === 'editing');
  const publishedVersion = overview?.published?.version ?? null;

  React.useEffect(() => { setSaveState(dirty ? 'dirty' : 'idle'); }, [dirty]);

  /* ------------------------------------------------------------- editing */
  const patch = (next: Record<string, unknown>) => { setContent(next); setSaveState('dirty'); };

  const ensureDraft = async () => {
    if (hasDraft || !content) return true;
    try {
      const created = await knowledgeApi.createDraft();
      setOverview((o) => (o ? { ...o, draft: created.draft } : o));
      return true;
    } catch (err) {
      push({ title: tk('toast.draftFailed'), description: (err as { message?: string }).message, variant: 'destructive' });
      return false;
    }
  };

  const saveDraft = async () => {
    if (!content) return;
    setBusy((b) => ({ ...b, save: true }));
    setSaveState('saving');
    try {
      const ok = await ensureDraft();
      if (!ok) { setSaveState('dirty'); return; }
      const baseVersion = overview?.draft?.baseVersion ?? overview?.published?.version ?? 1;
      const res = await knowledgeApi.saveDraft(content, baseVersion);
      setBaseline(JSON.stringify(res.draft.content));
      setErrors(res.validation.errors);
      setSaveState('saved');
      push({ title: res.validation.ok ? tk('toast.saved') : tk('toast.savedWithIssues'), variant: res.validation.ok ? 'default' : 'destructive' });
    } catch (err) {
      setSaveState('error');
      push({ title: tk('toast.saveFailed'), description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, save: false }));
    }
  };

  const validate = async () => {
    setBusy((b) => ({ ...b, validate: true }));
    try {
      const ok = await ensureDraft();
      if (!ok) return;
      if (dirty) await saveDraft();
      const res = await knowledgeApi.validate();
      setErrors(res.errors);
      setReview(res.review);
      push({ title: res.ok ? tk('toast.validateOk') : tk('toast.validateIssues', { count: res.errorCount }), variant: res.ok ? 'default' : 'destructive' });
    } catch (err) {
      push({ title: tk('toast.validateFailed'), description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, validate: false }));
    }
  };

  const preview = async () => {
    setBusy((b) => ({ ...b, preview: true }));
    try {
      const ok = await ensureDraft();
      if (!ok) return;
      if (dirty) await saveDraft();
      const res = await knowledgeApi.preview();
      setErrors(res.validation.errors);
      setReview(res.review);
      push({ title: res.validation.ok ? tk('toast.previewOk') : tk('toast.previewIssues'), variant: res.validation.ok ? 'default' : 'destructive' });
    } catch (err) {
      push({ title: tk('toast.previewFailed'), description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, preview: false }));
    }
  };

  const publish = async () => {
    setBusy((b) => ({ ...b, publish: true }));
    try {
      const res = await knowledgeApi.publish();
      push({ title: tk('toast.published', { version: res.version }) });
      setDialog(null);
      await load();
    } catch (err) {
      push({ title: tk('toast.publishFailed'), description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, publish: false }));
    }
  };

  const discard = async () => {
    setBusy((b) => ({ ...b, discard: true }));
    try {
      await knowledgeApi.discard();
      push({ title: tk('toast.discarded') });
      setDialog(null);
      await load();
    } catch (err) {
      push({ title: tk('toast.discardFailed'), description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, discard: false }));
    }
  };

  const switchSection = (next: SectionKey) => {
    if (dirty && next !== section) { setPendingSection(next); setDialog('unsaved'); return; }
    setSection(next);
  };

  /** Back control: history back when safe, parent page as fallback, dirty-aware. */
  const goBack = () => {
    if (dirty) { setDialog('unsaved'); return; }
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push('/inbox');
  };

  /* ------------------------------------------------------------------ view */
  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('knowledge')} />
        <KbSkeleton />
      </div>
    );
  }
  if (loadError || !overview) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('knowledge')} />
        <ErrorState title={tk('errors.title')} description={tk('errors.description')} actionLabel={tc('retry')} onAction={load} />
      </div>
    );
  }
  if (!content) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('knowledge')} description={tk('description')} />
        <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <p className="text-sm text-muted-foreground">{tk('empty.description')}</p>
        </div>
      </div>
    );
  }

  const c = content;
  const menus = (c.menus ?? {}) as Record<string, Record<string, Array<Record<string, unknown>>>>;
  const branches = Array.isArray(c.branches) ? c.branches : [];
  const faqKey = ['faqs', 'faq', 'questions'].find((k) => Array.isArray(c[k])) ?? 'faqs';
  const faqs = Array.isArray(c[faqKey]) ? c[faqKey] : [];
  const editing = hasDraft;

  const sections = [
    { key: 'overview', label: tk('sections.overview'), icon: Store },
    { key: 'menu', label: tk('sections.menu'), icon: BookOpen, badge: String(Object.keys(menus).length) },
    { key: 'branches', label: tk('sections.branches'), icon: GitBranch, badge: String(branches.length) },
    { key: 'faq', label: tk('sections.faq'), icon: Eye, badge: String(faqs.length) },
    { key: 'policies', label: tk('sections.policies'), icon: Pencil },
    { key: 'sources', label: tk('sections.sources'), icon: BookOpen }
  ];

  const actions: KbAction[] = [
    ...(canEdit && !editing ? [{ key: 'draft', label: tk('actions.createDraft'), onClick: () => ensureDraft().then(() => push({ title: tk('actions.draftReady') })), variant: 'primary' as const }] : []),
    { key: 'save', label: tk('actions.saveDraft'), onClick: saveDraft, variant: 'secondary', disabled: !canEdit || !editing || !dirty, busy: busy.save },
    { key: 'validate', label: tk('actions.validate'), onClick: validate, variant: 'secondary', disabled: !canEdit || !editing, busy: busy.validate },
    { key: 'preview', label: tk('actions.preview'), onClick: preview, variant: 'secondary', disabled: !canEdit || !editing, busy: busy.preview },
    { key: 'publish', label: tk('actions.publish'), onClick: () => setDialog('publish'), variant: 'primary', disabled: !canPublish || !editing || errors.length > 0, busy: busy.publish, title: errors.length ? tk('status.validationHint') : undefined },
    ...(canEdit && editing ? [{ key: 'discard', label: tk('actions.discardDraft'), onClick: () => setDialog('discard'), variant: 'destructive' as const, disabled: busy.discard }] : [])
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('knowledge')}
        description={tk('description')}
        breadcrumb={
          <button type="button" onClick={goBack} aria-label={tk('backToInbox')} title={tk('back')} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
            {tk('back')}
          </button>
        }
        actions={
          editing ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-medium text-warning">
              <Pencil className="h-3 w-3" aria-hidden /> {tk('status.editingDraft')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-success">
              <Eye className="h-3 w-3" aria-hidden /> {tk('status.viewingPublished')}
            </span>
          )
        }
      />

      <KbStatusBar
        brandLabel={overview.source.title}
        publishedVersion={publishedVersion}
        draftState={editing ? 'draft' : 'none'}
        saveState={saveState}
        errorCount={errors.length || null}
      />

      {errors.length > 0 ? (
        <ValidationPanel
          errors={errors}
          title={tk('validation.attention')}
          onJump={(s) => { const map: Record<string, SectionKey> = { overview: 'overview', menu: 'menu', branches: 'branches', faq: 'faq', policies: 'policies', sources: 'sources' }; const target = map[s]; if (target) switchSection(target); }}
        />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[13rem_1fr]">
        <KbSectionNav sections={sections} active={section} onChange={(k) => switchSection(k as SectionKey)} />
        <div className="min-w-0">
          {section === 'overview' ? (
            <OverviewWorkspace value={c} groups={OVERVIEW_GROUPS} editing={editing && canEdit} onChange={(next) => patch({ ...next })} />
          ) : null}
          {section === 'menu' ? <MenuEditor menus={menus} readOnly={!editing || !canEdit} onChange={(next) => patch({ ...c, menus: next })} /> : null}
          {section === 'branches' ? <BranchEditor branches={branches} readOnly={!editing || !canEdit} onChange={(next) => patch({ ...c, branches: next })} /> : null}
          {section === 'faq' ? <FaqEditor faqs={faqs} label={tk('faq.field.question')} readOnly={!editing || !canEdit} onChange={(next) => patch({ ...c, [faqKey]: next })} /> : null}
          {section === 'policies' ? <PolicyEditor value={c} editing={editing && canEdit} onChange={(next) => patch(next)} /> : null}
          {section === 'sources' ? <SourcesPanel source={overview.source} versions={overview.history} /> : null}
        </div>
      </div>

      <KbActionBar actions={actions} />

      <ConfirmDialog
        open={dialog === 'publish'}
        title={tk('dialog.publish.title')}
        description={tk('dialog.publish.description')}
        confirmLabel={busy.publish ? tk('dialog.publish.publishing') : tk('dialog.publish.confirm')}
        busy={busy.publish}
        onConfirm={publish}
        onCancel={() => setDialog(null)}
      >
        {review ? (
          <div className="space-y-2">
            <p className="text-[13px] text-muted-foreground">
              {tk('dialog.publish.reviewSummary', { added: review.counts.added ?? 0, modified: review.counts.modified ?? 0, removed: review.counts.removed ?? 0 })}
            </p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              <ReviewList review={review} />
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">{tk('dialog.publish.previewHint')}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'discard'}
        title={tk('dialog.discard.title')}
        description={tk('dialog.discard.description')}
        confirmLabel={tk('actions.discardDraft')}
        destructive
        busy={busy.discard}
        onConfirm={discard}
        onCancel={() => setDialog(null)}
      />

      <ConfirmDialog
        open={dialog === 'unsaved'}
        title={tk('dialog.unsaved.title')}
        description={tk('dialog.unsaved.description')}
        confirmLabel={tk('dialog.unsaved.confirm')}
        cancelLabel={tk('dialog.unsaved.cancel')}
        busy={busy.save}
        onConfirm={async () => { await saveDraft(); setDialog(null); if (pendingSection) setSection(pendingSection); }}
        onCancel={() => { setDialog(null); if (pendingSection) setSection(pendingSection); }}
      />
    </div>
  );
}
