import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { SessionGate } from '@/components/shell/session-gate';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const messages = await getMessages();
  return (
    <NextIntlClientProvider messages={messages}>
      <SessionGate>{children}</SessionGate>
    </NextIntlClientProvider>
  );
}
