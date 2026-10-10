import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';

export default async function PlaceholderPage() {
  const t = await getTranslations('nav');
  const ts = await getTranslations('states');
  const tp = await getTranslations();
  return (
    <div className="space-y-6">
      <PageHeader title={t('settings')} description={tp('placeholder')} />
      <EmptyState title={ts('emptyTitle')} description={ts('emptyDescription')} />
    </div>
  );
}
