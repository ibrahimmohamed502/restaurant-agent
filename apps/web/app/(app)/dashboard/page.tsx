import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';
import { DashboardFoundation } from '@/components/dashboard/foundation';

export default async function DashboardPage() {
  const t = await getTranslations('nav');
  const ts = await getTranslations('states');
  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashboard')}
        description="Your customer engagement overview will appear here once enabled."
        breadcrumb={<span className="text-2xs uppercase tracking-wide text-muted-foreground">Overview</span>}
      />
      <DashboardFoundation />
    </div>
  );
}
