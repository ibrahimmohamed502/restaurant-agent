import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/navigation', () => ({
  usePathname: () => '/integrations',
  useRouter: () => ({ back: vi.fn(), push: vi.fn() })
}));

import IntegrationsPage from '@/app/(app)/integrations/page';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

function render(node: React.ReactNode, messages: Record<string, unknown> = en) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages as never}>
      {node}
    </NextIntlClientProvider>
  );
}

const src = readFileSync(new URL('../app/(app)/integrations/page.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );

const enInt = (en as unknown as { integrations: Record<string, unknown> }).integrations;
const arInt = (ar as unknown as { integrations: Record<string, unknown> }).integrations;

describe('integrations i18n (EN/AR)', () => {
  it('has exact EN/AR key parity', () => {
    expect(flatten(enInt).sort().join(',')).toBe(flatten(arInt).sort().join(','));
  });

  it('translates the user-facing strings (not copied English)', () => {
    expect(enInt.title).toBe('Integrations');
    expect(arInt.title).toBe('التكاملات');
    expect(arInt.title).not.toBe(enInt.title);
    const enSummary = enInt.summary as Record<string, string>;
    const arSummary = arInt.summary as Record<string, string>;
    expect(arSummary.total).not.toBe(enSummary.total);
    expect(arSummary.total).toBeTruthy();
  });

  it('covers the labels the page renders', () => {
    const keys = flatten(enInt);
    for (const required of [
      'title', 'description', 'allBrands', 'filterByBrand', 'noBrand',
      'summary.total', 'summary.active', 'summary.attention', 'summary.disabled',
      'columns.brand', 'columns.health', 'columns.credentials', 'columns.lastEvent',
      'columns.lastError', 'columns.externalId',
      'statusLabels.active', 'statusLabels.disabled',
      'healthLabels.ok', 'healthLabels.degraded', 'healthLabels.down', 'healthLabels.unknown',
      'credentialsLabels.present', 'credentialsLabels.missing', 'credentialsLabels.expires',
      'capabilities.comments', 'capabilities.directMessages',
      'providersTitle', 'emptyTitle', 'emptyDescription',
      'loadFailedTitle', 'loadFailedDescription', 'readOnlyNotice'
    ]) {
      expect(keys).toContain(required);
    }
  });
});

describe('integrations page rendering', () => {
  it('renders the localized shell before data arrives', () => {
    const html = render(<IntegrationsPage />);
    expect(html).toContain('Integrations');
    expect(html).toContain('Channels connected to your company');
  });

  it('renders with Arabic messages too (no missing-key crash)', () => {
    const html = render(<IntegrationsPage />, ar as unknown as Record<string, unknown>);
    expect(html).toContain('التكاملات');
  });

  it('exposes a loading state for the async listing', () => {
    const html = render(<IntegrationsPage />);
    expect(html).toContain('role="status"');
  });
});

describe('integrations page direction & responsiveness', () => {
  it('uses logical (direction-aware) utilities — no physical left/right', () => {
    expect(src).not.toMatch(/\b(ml|mr|pl|pr)-/);
    expect(src).not.toMatch(/text-(left|right)\b/);
    expect(src).not.toMatch(/className="[^"]*\b(left|right)-\d/);
  });

  it('relies on the document direction from the locale instead of hardcoding dir', () => {
    expect(src).not.toContain('dir="rtl"');
    expect(src).not.toContain('dir="ltr"');
  });

  it('uses end/start alignment so RTL reads naturally', () => {
    expect(src).toContain('text-end');
    expect(src).toContain('justify-between');
  });

  it('is responsive (grid breakpoints + wrapping)', () => {
    expect(src).toMatch(/sm:grid-cols-/);
    expect(src).toMatch(/md:grid-cols-/);
    expect(src).toContain('flex-wrap');
  });
});

describe('integrations page security & provider neutrality', () => {
  it('never hardcodes a provider in the UI (labels come from the registry/API)', () => {
    expect(src).not.toMatch(/facebook/i);
    expect(src).not.toMatch(/instagram/i);
    expect(src).not.toMatch(/whatsapp/i);
    expect(src).toContain('providerLabel');
  });

  it('is read-only: no connect/disconnect/rotation controls', () => {
    expect(src).not.toMatch(/integrationsApi\.(connect|disconnect|rotate|reconnect|create|update|delete)/);
    expect(src).toContain('readOnlyNotice');
  });

  it('API client exposes only read operations on the integrations scope', () => {
    const block = apiSrc.slice(apiSrc.indexOf('export const integrationsApi'));
    expect(block).toContain('api.get<IntegrationsResponse>');
    expect(block).toContain('api.get<{ integration: IntegrationInfo }>');
    expect(block).not.toContain('api.post');
    expect(block).not.toContain('api.patch');
    expect(block).not.toContain('api.del');
  });

  it('API client never asks for a tenant parameter (server-scoped)', () => {
    const block = apiSrc.slice(apiSrc.indexOf('export const integrationsApi'));
    expect(block).not.toContain('tenantId=');
  });
});