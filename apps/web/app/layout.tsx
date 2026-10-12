import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ToastProvider } from '@/components/ui/toaster';
import { directionFor } from '@/i18n/routing';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Restaurant AI Platform', template: '%s · Restaurant AI Platform' },
  description: 'Customer engagement platform for restaurant brands'
};

/** Applies the persisted theme before paint to avoid a flash of the wrong mode. */
const themeBootstrap = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=(light|dark)/);if(m==='dark'||(!m&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = directionFor(locale);
  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#4a2c1a" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#241609" media="(prefers-color-scheme: dark)" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="LWC Platform" />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
