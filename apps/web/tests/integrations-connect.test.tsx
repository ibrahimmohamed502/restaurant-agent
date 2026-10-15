import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/navigation', () => ({
  usePathname: () => '/integrations',
  useRouter: () => ({ back: vi.fn(), push: vi.fn() })
}));

import { ToastProvider } from '@/components/ui/toaster';
import IntegrationsPage from '@/app/(app)/integrations/page';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

function render(node: React.ReactNode, messages: Record<string, unknown> = en) {
  return renderToStaticMarkup(
    <ToastProvider>
      <NextIntlClientProvider locale="en" messages={messages as never}>
        {node}
      </NextIntlClientProvider>
    </ToastProvider>
  );
}

const pageSrc = readFileSync(new URL('../app/(app)/integrations/page.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

const enI = (en as unknown as { integrations: Record<string, any> }).integrations;
const arI = (ar as unknown as { integrations: Record<string, any> }).integrations;
const flatten = (o: Record<string, unknown>, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));

describe('integrations i18n — EN/AR parity (Batch 3)', () => {
  it('exact key parity including the wizard + connection keys', () => {
    expect(flatten(enI).sort().join(',')).toBe(flatten(arI).sort().join(','));
  });

  it('wizard strings are translated, not copied', () => {
    expect(enI.wizard.connect).toBe('Connect Facebook Page');
    expect(arI.wizard.connect).toBe('ربط صفحة فيسبوك');
    expect(arI.wizard.connect).not.toBe(enI.wizard.connect);
    expect(arI.connection.subscriptionFailed).not.toBe(enI.connection.subscriptionFailed);
    expect(arI.connection.unknown).not.toBe(enI.connection.unknown);
  });

  it('disabled-state hint exists in both locales', () => {
    expect(enI.wizard.notConfiguredHint).toBeTruthy();
    expect(arI.wizard.notConfiguredHint).toBeTruthy();
  });
});

describe('integrations page renders (EN + AR)', () => {
  it('renders the English shell', () => {
    const html = render(<IntegrationsPage />);
    expect(html).toContain('Integrations');
    expect(html).toContain('Connect Facebook Page');
  });

  it('renders with Arabic messages', () => {
    const html = render(<IntegrationsPage />, ar as unknown as Record<string, unknown>);
    expect(html).toContain('التكاملات');
    expect(html).toContain('ربط صفحة فيسبوك');
  });

  it('exposes a loading state for the async listing', () => {
    expect(render(<IntegrationsPage />)).toContain('role="status"');
  });
});

describe('truthful connection status', () => {
  it('renders every server-derived connection state label', () => {
    for (const key of ['connected', 'pendingSubscription', 'subscriptionFailed', 'needsAttention', 'notConnected', 'unknown']) {
      expect(enI.connection[key]).toBeTruthy();
      expect(arI.connection[key]).toBeTruthy();
    }
  });

  it('uses the server connectionState, never a locally derived one', () => {
    expect(pageSrc).toContain('i.connectionState');
    expect(pageSrc).toContain('stateMeta');
    // no local guesswork from credential presence
    expect(pageSrc).not.toMatch(/credentials\.present\s*\?\s*'connected'/);
  });

  it('offers retry for a failed subscription and re-verify for legacy rows', () => {
    expect(pageSrc).toContain("i.connectionState === 'subscription_failed'");
    expect(pageSrc).toContain("i.connectionState === 'unknown'");
    expect(pageSrc).toContain('resubscribe');
    expect(pageSrc).toContain('reverify');
    expect(enI.actions.retrySubscription).toBeTruthy();
    expect(enI.actions.reverify).toBeTruthy();
  });
});

describe('OAuth flow hygiene', () => {
  it('reads the flow token from the fragment and scrubs the URL', () => {
    expect(pageSrc).toContain('window.location.hash');
    expect(pageSrc).toContain('history.replaceState');
    // the token must never be placed in a query string
    expect(pageSrc).not.toMatch(/searchParams\.set\('t'/);
  });

  it('sends the flow token as a header, not in the URL', () => {
    const block = apiSrc.slice(apiSrc.indexOf('export const metaOAuthApi'));
    expect(block).toContain('X-Flow-Token');
    expect(block).not.toMatch(/flowToken=/);
  });

  it('shows a clear notice when self-service is not configured', () => {
    expect(pageSrc).toContain('OAUTH_NOT_CONFIGURED');
    expect(pageSrc).toContain('notConfiguredHint');
  });
});

describe('direction & responsiveness', () => {
  it('uses logical utilities only', () => {
    expect(pageSrc).not.toMatch(/\b(ml|mr|pl|pr)-/);
    expect(pageSrc).not.toMatch(/text-(left|right)\b/);
    expect(pageSrc).toContain('text-end');
    expect(pageSrc).toContain('justify-between');
  });

  it('is responsive and does not hardcode a direction', () => {
    expect(pageSrc).toMatch(/sm:grid-cols-/);
    expect(pageSrc).toMatch(/md:grid-cols-/);
    expect(pageSrc).not.toContain('dir="rtl"');
  });
});

describe('provider neutrality', () => {
  it('does not hardcode a provider id or name in the UI code', () => {
    // strip comments so documentation prose is not mistaken for hardcoding
    const code = pageSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/instagram|whatsapp|twitter|tiktok/i);
    // labels come from the registry/i18n; the connect action uses the meta OAuth client
    expect(pageSrc).toContain('providerLabel');
    expect(pageSrc).toContain('metaOAuthApi');
  });
});