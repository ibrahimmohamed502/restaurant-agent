'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { ErrorState, EmptyState, PageLoading } from '@/components/ui/states';
import { useToast } from '@/components/ui/toaster';
import { KbActionBar, KbSectionNav, KbStatusBar, type KbAction, type SaveState } from '@/components/kb/kb-shell';
import { ConfirmDialog, KbSkeleton, PreviewSummary, ReviewList, ValidationPanel } from '@/components/kb/kb-parts';
import { MenuEditor, BranchEditor, type MenuStructure, type Branch } from '@/components/kb/menu-editor';
import { FaqEditor, PolicyEditor, SourcesPanel, type Faq, type PolicyField } from '@/components/kb/editors';
import { knowledgeApi, type KnowledgeOverview } from '@/lib/knowledge-api';

type SectionKey = 'overview' | 'menu' | 'branches' | 'faq' | 'policies' | 'sources';

/** Fields that actually exist in the published LWC document. */
const OVERVIEW_FIELDS: PolicyField[] = [
  { key: 'restaurantName', label: 'اسم المطعم / العلامة', kind: 'text' },
  { key: 'menuUrl', label: 'رابط المنيو', kind: 'text', help: 'https://…' },
  { key: 'currency', label: 'العملة', kind: 'text' },
  { key: 'halal', label: 'معلومات الحلال', kind: 'long' },
  { key: 'reservations', label: 'الحجوزات', kind: 'long' },
  { key: 'delivery', label: 'التوصيل / الخدمة', kind: 'long' },
  { key: 'location', label: 'الموقع', kind: 'long' },
  { key: 'about', label: 'نبذة عن المطعم', kind: 'long' }
];

const POLICY_FIELDS: PolicyField[] = [
  { key: 'meatSources', label: 'مصادر اللحوم (نص)', kind: 'long' },
  { key: 'agentNotes', label: 'ملاحظات تشغيلية للمساعد', kind: 'long', help: 'توجيهات تظهر للمساعد الآلي داخل knowledge فقط' }
];

const FAQ_KEYS = ['faqs', 'faq', 'questions'];

export default function KnowledgePage() {
  const t = useTranslations('nav');
  const router = useRouter();
  const { push } = useToast();

  const [overview, setOverview] = React.useState<KnowledgeOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [section, setSection] = React.useState<SectionKey>('overview');
  const [content, setContent] = React.useState<Record<string, unknown> | null>(null);
  const [baseline, setBaseline] = React.useState<string>('');
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [errors, setErrors] = React.useState<Array<{ section: string; path: string; field: string | null; messageKey: string }>>([]);
  const [review, setReview] = React.useState<{ counts: Record<string, number>; bySection: Record<string, Record<string, number>>; items: Array<{ path: string; type: string; value?: string; from?: string; to?: string }> } | null>(null);
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const [dialog, setDialog] = React.useState<null | 'publish' | 'discard' | 'unsaved'>(null);
  const [pendingSection, setPendingSection] = React.useState<SectionKey | null>(null);

  /* ------------------------------------------------------------- loading */
  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await knowledgeApi.overview();
      setOverview(data);
      if (data.draft) {
        setContent(data.draft.content);
        setBaseline(JSON.stringify(data.draft.content));
        setSaveState('idle');
      } else if (data.published) {
        setContent(data.published.structured);
        setBaseline(JSON.stringify(data.published.structured));
        setSaveState('idle');
      } else {
        setContent(null);
        setBaseline('');
      }
      setErrors([]);
      setReview(null);
    } catch (err) {
      setLoadError((err as { message?: string })?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const dirty = content !== null && JSON.stringify(content) !== baseline;
  const canEdit = overview?.permissions.canEdit ?? false;
  const canPublish = overview?.permissions.canPublish ?? false;
  const hasDraft = Boolean(overview?.draft && overview.draft.status !== 'discarded');

  React.useEffect(() => { setSaveState(dirty ? 'dirty' : 'idle'); }, [dirty]);

  /* ------------------------------------------------------------- editing */
  const patch = (next: Record<string, unknown>) => { setContent(next); setSaveState('dirty'); };

  const ensureDraft = async (): Promise<boolean> => {
    if (hasDraft || !content) return true;
    try {
      const created = await knowledgeApi.createDraft();
      setOverview((o) => (o ? { ...o, draft: created.draft } : o));
      return true;
    } catch (err) {
      push({ title: 'تعذّر إنشاء المسودة', description: (err as { message?: string }).message, variant: 'destructive' });
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
      push({ title: res.validation.ok ? 'تم حفظ المسودة' : 'تم الحفظ — توجد أخطاء تحقق', variant: res.validation.ok ? 'default' : 'destructive' });
    } catch (err) {
      setSaveState('error');
      push({ title: 'فشل الحفظ', description: (err as { message?: string }).message, variant: 'destructive' });
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
      push({ title: res.ok ? 'التحقق نجح' : `${res.errorCount} مشكلات تحتاج انتباهك`, variant: res.ok ? 'default' : 'destructive' });
    } catch (err) {
      push({ title: 'فشل التحقق', description: (err as { message?: string }).message, variant: 'destructive' });
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
      push({ title: res.validation.ok ? 'المسودة جاهزة للنشر' : 'راجع مشاكل التحقق قبل النشر', variant: res.validation.ok ? 'default' : 'destructive' });
    } catch (err) {
      push({ title: 'فشل المعاينة', description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, preview: false }));
    }
  };

  const publish = async () => {
    setBusy((b) => ({ ...b, publish: true }));
    try {
      const res = await knowledgeApi.publish();
      push({ title: `تم النشر — الإصدار v${res.version}` });
      setDialog(null);
      await load();
    } catch (err) {
      push({ title: 'فشل النشر', description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, publish: false }));
    }
  };

  const discard = async () => {
    setBusy((b) => ({ ...b, discard: true }));
    try {
      await knowledgeApi.discard();
      push({ title: 'تم إلغاء المسودة' });
      setDialog(null);
      await load();
    } catch (err) {
      push({ title: 'فشل إلغاء المسودة', description: (err as { message?: string }).message, variant: 'destructive' });
    } finally {
      setBusy((b) => ({ ...b, discard: false }));
    }
  };

  /* -------------------------------------------------- unsaved-change guard */
  const switchSection = (next: SectionKey) => {
    if (dirty) { setPendingSection(next); setDialog('unsaved'); return; }
    setSection(next);
  };

  const leaveWorkspace = (e: React.MouseEvent) => {
    if (!dirty) { router.push('/inbox'); return; }
    e.preventDefault();
    setDialog('unsaved');
  };

  /* ------------------------------------------------------------------ view */
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <PageHeader title={t('knowledge')} />
        <PageLoading />
      </div>
    );
  }
  if (loadError || !overview) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <PageHeader title={t('knowledge')} />
        <ErrorState title="تعذّر تحميل قاعدة المعرفة" description="حدث خطأ أثناء جلب البيانات." actionLabel="إعادة المحاولة" onAction={load} />
      </div>
    );
  }
  if (!content) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <PageHeader title={t('knowledge')} description="إدارة معرفة العلامة التجارية" />
        <EmptyState title="لا توجد معرفة منشورة" description="أنشئ مسودة أولًا لبدء إدارة المحتوى." />
      </div>
    );
  }

  const c = content;
  const menus = ((c.menus ?? {}) as MenuStructure);
  const branches = (Array.isArray(c.branches) ? c.branches : []) as Branch[];
  const faqKey = FAQ_KEYS.find((k) => Array.isArray(c[k])) ?? 'faqs';
  const faqs = (Array.isArray(c[faqKey]) ? c[faqKey] : []) as Faq[];

  const sections: Array<{ key: SectionKey; label: string; badge?: string }> = [
    { key: 'overview', label: 'نظرة عامة' },
    { key: 'menu', label: 'المنيو', badge: String(Object.keys(menus).length) },
    { key: 'branches', label: 'الفروع', badge: String(branches.length) },
    { key: 'faq', label: 'الأسئلة الشائعة', badge: String(faqs.length) },
    { key: 'policies', label: 'السياسات والخدمة' },
    { key: 'sources', label: 'المصادر والإصدارات' }
  ];

  const actions: KbAction[] = [
    ...(canEdit ? [{ key: 'draft', label: 'إنشاء مسودة', onClick: () => ensureDraft().then(() => push({ title: 'المسودة جاهزة' })), variant: 'secondary' as const, disabled: hasDraft }] : []),
    { key: 'save', label: 'حفظ المسودة', onClick: saveDraft, variant: 'secondary' as const, disabled: !canEdit || !dirty, busy: busy.save },
    { key: 'validate', label: 'تحقق', onClick: validate, variant: 'secondary' as const, disabled: !canEdit, busy: busy.validate },
    { key: 'preview', label: 'معاينة', onClick: preview, variant: 'secondary' as const, disabled: !canEdit, busy: busy.preview },
    { key: 'publish', label: 'نشر', onClick: () => setDialog('publish'), variant: 'primary' as const, disabled: !canPublish || errors.length > 0, busy: busy.publish, title: errors.length ? 'عالج مشاكل التحقق أولًا' : undefined },
    ...(canEdit && hasDraft ? [{ key: 'discard', label: 'إلغاء المسودة', onClick: () => setDialog('discard'), variant: 'destructive' as const, disabled: busy.discard }] : [])
  ];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-24">
      <PageHeader
        title={t('knowledge')}
        description="إدارة معرفة العلامة التجارية: المنيو، الفروع، الأسئلة الشائعة والسياسات"
        breadcrumb={<a href="/inbox" onClick={leaveWorkspace} className="hover:underline">صندوق الموحد</a>}
      />

      <KbStatusBar
        brandLabel={overview.source.title}
        publishedVersion={overview.published?.version ?? null}
        draftState={hasDraft ? 'draft' : 'none'}
        saveState={saveState}
        errorCount={errors.length || null}
      />

      {errors.length > 0 ? (
        <ValidationPanel
          errors={errors}
          title="التحقق يحتاج انتباهك"
          onJump={(s) => { const map: Record<string, SectionKey> = { overview: 'overview', menu: 'menu', branches: 'branches', faq: 'faq', policies: 'policies', sources: 'sources' }; const target = map[s]; if (target) switchSection(target); }}
        />
      ) : null}

      <KbSectionNav sections={sections} active={section} onChange={(k) => switchSection(k as SectionKey)} />

      <div className="min-h-[280px]">
        {section === 'overview' ? (
          <PolicyEditor fields={OVERVIEW_FIELDS} value={c} onChange={(next) => patch({ ...next })} />
        ) : null}
        {section === 'menu' ? <MenuEditor menus={menus} onChange={(next) => patch({ ...c, menus: next })} /> : null}
        {section === 'branches' ? <BranchEditor branches={branches} onChange={(next) => patch({ ...c, branches: next })} /> : null}
        {section === 'faq' ? <FaqEditor faqs={faqs} onChange={(next) => patch({ ...c, [faqKey]: next })} label="السؤال" /> : null}
        {section === 'policies' ? <PolicyEditor fields={POLICY_FIELDS} value={c} onChange={(next) => patch(next)} /> : null}
        {section === 'sources' ? <SourcesPanel source={overview.source} versions={overview.history} /> : null}
      </div>

      <KbActionBar actions={actions} />

      <ConfirmDialog
        open={dialog === 'publish'}
        title="نشر الإصدار الجديد؟"
        description="سيصبح هذا الإصدار هو المعرفة النشطة للمساعد الآلي. الإصدار السابق يبقى متاحًا في السجل."
        confirmLabel={busy.publish ? 'جارٍ النشر…' : 'تأكيد النشر'}
        busy={busy.publish}
        onConfirm={publish}
        onCancel={() => setDialog(null)}
      >
        {review ? (
          <div className="space-y-2">
            <p className="text-[13px] text-muted-foreground">
              أضيف {review.counts.added ?? 0} · عُدّل {review.counts.modified ?? 0} · حُذف {review.counts.removed ?? 0}
            </p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              <ReviewList review={review as never} />
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">للمراجعة الكاملة اضغط «معاينة» قبل النشر.</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'discard'}
        title="إلغاء المسودة؟"
        description="سيتم التخلي عن كل التغييرات غير المنشورة. المعرفة المنشورة حاليًا لا تتأثر."
        confirmLabel="إلغاء المسودة"
        destructive
        busy={busy.discard}
        onConfirm={discard}
        onCancel={() => setDialog(null)}
      />

      <ConfirmDialog
        open={dialog === 'unsaved'}
        title="تغييرات غير محفوظة"
        description="لديك تعديلات لم تُحفظ بعد. هل تريد الحفظ قبل المتابعة؟"
        confirmLabel="حفظ ومتابعة"
        cancelLabel="تجاهل التغييرات"
        busy={busy.save}
        onConfirm={async () => { await saveDraft(); setDialog(null); if (pendingSection) setSection(pendingSection); }}
        onCancel={() => { setDialog(null); if (pendingSection) setSection(pendingSection); }}
      />

      {busy.publish ? (
        <div className="fixed bottom-4 end-4 z-[70] flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-lg">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> جارٍ النشر…
        </div>
      ) : null}
    </div>
  );
}
