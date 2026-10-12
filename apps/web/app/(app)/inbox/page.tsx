'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-header';
import { BackButton } from '@/components/shell/back-button';
import { InboxView } from '@/components/inbox/view';

export default function InboxPage() {
  const t = useTranslations('nav');
  const ti = useTranslations('inbox');
  return (
    <div className="space-y-5">
      <PageHeader title={t('inbox')} description={ti('subtitle')} breadcrumb={<BackButton />} />
      <InboxView />
    </div>
  );
}
