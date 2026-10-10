import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { DashboardFoundation } from '@/components/dashboard/foundation';

export default async function DashboardPage() {
  const t = await getTranslations('nav');
  const tf = await getTranslations('dashboardFoundation');
  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashboard')}
        description={tf('description')}
        breadcrumb={<span className="text-2xs uppercase tracking-wide text-muted-foreground">{tf('overview')}</span>}
      />
      <DashboardFoundation />
    </div>
  );
}
