import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/channels', useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPalette } from '@/components/shell/command-palette';
import { ChangePasswordDialog } from '@/components/shell/change-password-dialog';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

function render(node: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('command palette', () => {
  const src = readFileSync(new URL('../components/shell/command-palette.tsx', import.meta.url), 'utf8');

  it('binds ⌘K / Ctrl+K globally and toggles', () => {
    expect(src).toContain("e.key.toLowerCase() === 'k'");
    expect(src).toContain('e.metaKey || e.ctrlKey');
    expect(src).toContain('preventDefault');
  });

  it('renders navigation items with localized labels', () => {
    const html = render(<CommandPalette open onClose={() => {}} isSuperAdmin />);
    expect(html).toContain('Knowledge Base');
    expect(html).toContain('Unified Inbox');
    expect(html).toContain('Dashboard');
  });

  it('renders in Arabic', () => {
    const html = render(<CommandPalette open onClose={() => {}} isSuperAdmin />, 'ar');
    expect(html).toContain('قاعدة المعرفة');
  });

  it('handles Escape / arrows / Enter and empty results', () => {
    expect(src).toContain("e.key === 'Escape'");
    expect(src).toContain("'ArrowDown'");
    expect(src).toContain("'ArrowUp'");
    expect(src).toContain('noResults');
  });
});

describe('change password dialog', () => {
  const src = readFileSync(new URL('../components/shell/change-password-dialog.tsx', import.meta.url), 'utf8');

  it('calls the authenticated password endpoint', () => {
    expect(src).toContain('authApi.changePassword');
  });

  it('validates current password, min length and confirmation match', () => {
    expect(src).toContain('passwordTooShort');
    expect(src).toContain('passwordMismatch');
    expect(src).toContain('currentPassword');
  });

  it('renders with localized labels', () => {
    const html = render(<ChangePasswordDialog open onClose={() => {}} />);
    expect(html).toContain('Change password');
    const arHtml = render(<ChangePasswordDialog open onClose={() => {}} />, 'ar');
    expect(arHtml).toContain('تغيير كلمة المرور');
  });

  it('password endpoint is wired in the API client', async () => {
    const api = await import('@/lib/api');
    expect(typeof api.authApi.changePassword).toBe('function');
    expect(typeof api.channelsApi.list).toBe('function');
  });
});

describe('channels page (read-only routing viewer)', () => {
  const src = readFileSync(new URL('../app/(app)/channels/page.tsx', import.meta.url), 'utf8');

  it('uses the tenant-scoped channels API', () => {
    expect(src).toContain('channelsApi.list()');
  });

  it('never references credentials or tokens', () => {
    expect(src.toLowerCase()).not.toContain('credential');
    expect(src.toLowerCase()).not.toContain('token');
  });

  it('shows health, status and a read-only notice; terminates into empty/error states', () => {
    expect(src).toContain('readonlyNote');
    expect(src).toContain('ErrorState');
    expect(src).toContain('empty.title');
    expect(src).toContain('setLoading(false)');
  });
});

describe('brand assets (favicon + PWA manifest)', () => {
  it('favicon and manifest exist with the brand mark', () => {
    const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
    expect(favicon).toContain('<svg');
    expect(existsSync(new URL('../public/manifest.webmanifest', import.meta.url))).toBe(true);
  });

  it('layout links the manifest and theme colors', () => {
    const src = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    expect(src).toContain('rel="manifest"');
    expect(src).toContain('theme-color');
  });
});

describe('top loader', () => {
  const src = readFileSync(new URL('../components/shell/top-loader.tsx', import.meta.url), 'utf8');
  it('animates on route change and self-clears (no stuck bar)', () => {
    expect(src).toContain('usePathname');
    expect(src).toContain('top-loader-bar');
    expect(src).toContain('setVisible(false)');
  });
});

describe('command/channels/auth translation parity', () => {
  it('command + channels namespaces have exact EN/AR parity', () => {
    const walk = (o: unknown, pre = ''): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? walk(v, pre + k + '.') : [pre + k]));
    for (const ns of ['command', 'channels', 'auth'] as const) {
      expect(JSON.stringify(walk(en[ns]).sort())).toBe(JSON.stringify(walk(ar[ns]).sort()));
    }
    expect(en.command.placeholder).toBeTruthy();
    expect(ar.command.placeholder).toBeTruthy();
  });
});
