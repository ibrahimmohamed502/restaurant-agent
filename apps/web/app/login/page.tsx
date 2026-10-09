'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { LoginForm } from '@/features/auth/login-form';

export default function LoginPage() {
  const t = useTranslations();
  const router = useRouter();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('common.appName')}</p>
            <p className="text-xs text-muted-foreground">{t('common.company')}</p>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <LoginForm onSuccess={() => router.replace('/dashboard')} />
        </div>
      </div>
    </main>
  );
}
