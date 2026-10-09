import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('states');
  return (
    <NextIntlClientProvider messages={await getMessages()}>
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-4xl font-semibold text-foreground">404</p>
        <h1 className="text-lg font-medium text-foreground">{t('notFoundTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('notFoundDescription')}</p>
      </main>
    </NextIntlClientProvider>
  );
}
