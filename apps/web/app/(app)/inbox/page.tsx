import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';

/** Stage 5.0 placeholder route generator — professional empty states until each module ships. */
export default async function PlaceholderPage() {
  const t = await getTranslations('nav');
  const ts = await getTranslations('states');
  const tp = await getTranslations('placeholder');
  return (
    <div className="space-y-6">
      <PageHeader title={t('inbox')} description={tp('')} />
      <EmptyState title={ts('emptyTitle')} description={ts('emptyDescription')} />
    </div>
  );
}
