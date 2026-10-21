import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ToastProvider } from '@/components/ui/toaster';
import { InstallPrompt } from '@/components/pwa/install-prompt';
import { ServiceWorkerRegistrar } from '@/components/pwa/service-worker-registrar';
import { directionFor } from '@/i18n/routing';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Restaurant AI Platform', template: '%s · Restaurant AI Platform' },
  description: 'Customer engagement platform for restaurant brands',
  applicationName: 'LWC Platform',
  manifest: '/manifest.webmanifest',
  // iOS: "Add to Home Screen" → standalone app (no Safari chrome).
  appleWebApp: {
    capable: true,
    title: 'LWC Platform',
    statusBarStyle: 'default'
  },
  // Stop iOS from turning menu prices into clickable phone numbers.
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }
    ],
    apple: [{ url: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' }]
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 5 (not 1) so pinch-zoom stays available for accessibility.
  maximumScale: 5,
  // Lets the layout reach the notch/home-indicator area on iPhone; the shell
  // compensates with env(safe-area-inset-*) padding.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#4a2c1a' },
    { media: '(prefers-color-scheme: dark)', color: '#241609' }
  ]
};

/** Applies the persisted theme before paint to avoid a flash of the wrong mode. */
const themeBootstrap = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=(light|dark)/);if(m==='dark'||(!m&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e)}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = directionFor(locale);
  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ToastProvider>
            {children}
            <ServiceWorkerRegistrar />
            <InstallPrompt />
          </ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
