import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';
import { getTranslations } from 'next-intl/server';

export default async function DashboardPage() {
  const t = await getTranslations('nav');
  const ts = await getTranslations('states');
  const tp = await getTranslations('placeholder');
  return (
    <div className="space-y-6">
      <PageHeader title={t('dashboard')} description={tp('')} />
      <EmptyState title={t('dashboard')} description={ts('emptyDescription')} />
    </div>
  );
}
