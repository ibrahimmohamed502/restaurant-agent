import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { EmptyState } from '@/components/ui/states';

export default async function PlaceholderPage() {
  const t = await getTranslations('nav');
  const ts = await getTranslations('states');
  const tp = await getTranslations();
  return (
    <div className="space-y-6">
      <PageHeader title={t('integrations')} description={tp('placeholder')} breadcrumb={<BackButton />} />
      <EmptyState title={ts('emptyTitle')} description={ts('emptyDescription')} />
    </div>
  );
}
