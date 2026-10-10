import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/team', useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
import { NextIntlClientProvider } from 'next-intl';
import { BackButton } from '@/components/shell/back-button';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

function render(node: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('language switch (authenticated shell)', () => {
  const src = readFileSync(new URL('../components/shell/app-shell.tsx', import.meta.url), 'utf8');

  it('persists the locale cookie before refreshing — otherwise the server keeps the old language', () => {
    expect(src).toContain('setLocaleCookie(l)');
    expect(src).toContain('router.refresh()');
    // cookie must be set BEFORE the refresh
    expect(src.indexOf('setLocaleCookie(l)')).toBeLessThan(src.indexOf('router.refresh()'));
    expect(src).toContain('directionFor(l)');
  });
});

describe('BackButton', () => {
  it('renders with a localized label in EN', () => {
    const html = render(<BackButton />);
    expect(html).toContain('Back');
    expect(html).toContain('rtl:rotate-180'); // direction-aware arrow
  });

  it('renders with a localized label in AR', () => {
    const html = render(<BackButton />, 'ar');
    expect(html).toContain('رجوع');
  });

  it('uses history back with a fallback route', () => {
    const src = readFileSync(new URL('../components/shell/back-button.tsx', import.meta.url), 'utf8');
    expect(src).toContain('window.history.length > 1');
    expect(src).toContain('router.back()');
    expect(src).toContain('router.push(fallback)');
  });

  it('is present on inner pages (knowledge, inbox, team and roadmap placeholders)', () => {
    const withComponent = [
      '../app/(app)/inbox/page.tsx',
      '../app/(app)/team/page.tsx',
      '../app/(app)/settings/page.tsx',
      '../app/(app)/channels/page.tsx',
      '../app/(app)/customers/page.tsx',
      '../app/(app)/brands/page.tsx',
      '../app/(app)/ai/page.tsx',
      '../app/(app)/integrations/page.tsx',
      '../app/(app)/audit/page.tsx',
      '../app/(app)/companies/page.tsx'
    ];
    for (const p of withComponent) {
      const src = readFileSync(new URL(p, import.meta.url), 'utf8');
      expect(src, p).toContain('BackButton');
    }
    // knowledge has its own dirty-aware back control with history fallback
    const kb = readFileSync(new URL('../app/(app)/knowledge/page.tsx', import.meta.url), 'utf8');
    expect(kb).toContain('ArrowLeft');
    expect(kb).toContain('window.history.length > 1');
    expect(kb).toContain('rtl:rotate-180');
  });
});

describe('Team & Access page', () => {
  const src = readFileSync(new URL('../app/(app)/team/page.tsx', import.meta.url), 'utf8');

  it('uses the tenant-scoped /api/v1/users endpoints', () => {
    expect(src).toContain("usersApi.list()");
    expect(src).toContain('usersApi.create(');
    expect(src).toContain('usersApi.setStatus(');
    expect(src).toContain('usersApi.setRoles(');
  });

  it('offers the three RBAC roles and requires confirmation for disable', () => {
    expect(src).toContain("'Company Admin'");
    expect(src).toContain("'Supervisor'");
    expect(src).toContain("'Agent'");
    expect(src).toContain('window.confirm');
  });

  it('never hangs: loading terminates into content, empty, error/retry or forbidden states', () => {
    expect(src).toContain('ErrorState');
    expect(src).toContain('setLoading(false)');
    expect(src).toContain('forbidden');
  });

  it('team namespace translations exist with EN/AR parity', async () => {
    const en = (await import('@/messages/en.json')).default;
    const ar = (await import('@/messages/ar.json')).default;
    const enKeys = JSON.stringify(Object.keys(en.team).sort());
    const arKeys = JSON.stringify(Object.keys(ar.team).sort());
    expect(enKeys).toBe(arKeys);
    expect(en.team.table.name).toBeTruthy();
    expect(ar.team.table.name).toBeTruthy();
    expect(en.team.roles.admin).toBeTruthy();
    expect(ar.team.roles.admin).toBeTruthy();
  });
});
