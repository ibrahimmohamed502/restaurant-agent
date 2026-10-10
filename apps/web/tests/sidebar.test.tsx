import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// the sidebar highlights the active route — provide one for the test render
vi.mock('next/navigation', () => ({ usePathname: () => '/inbox' }));

import { NextIntlClientProvider } from 'next-intl';
import { Sidebar } from '@/components/shell/sidebar';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const noop = () => {};

function render(node: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  const messages = locale === 'en' ? en : ar;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('Sidebar (global SaaS navigation)', () => {
  it('renders all primary navigation routes', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    for (const href of ['/dashboard', '/inbox', '/knowledge', '/brands', '/channels', '/ai', '/team', '/integrations', '/settings', '/customers']) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('Unified Inbox');
    expect(html).toContain('Knowledge Base');
  });

  it('renders grouped navigation with labels', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('Overview'); // group label (navGroups.overview)
    expect(html).toContain('Engagement');
    expect(html).toContain('Configuration');
  });

  it('highlights the active route with aria-current', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    // pathname is mocked to /inbox → only the inbox link is current
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    const inboxIdx = html.indexOf('href="/inbox"');
    const tagStart = html.lastIndexOf('<a ', inboxIdx);
    expect(html.slice(tagStart, inboxIdx + 400)).toContain('aria-current="page"');
  });

  it('hides super-admin-only items from non-super-admins (RBAC)', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin={false} mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).not.toContain('href="/companies"');
    expect(html).not.toContain('href="/audit"');
    const admin = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(admin).toContain('href="/companies"');
    expect(admin).toContain('href="/audit"');
  });

  it('renders in Arabic (RTL) with translated labels', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />, 'ar');
    expect(html).toContain('صندوق الموحد');
    expect(html).toContain('قاعدة المعرفة');
  });

  it('renders the mobile drawer backdrop when open', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('bg-black/40');
    expect(html).toContain('translate-x-0');
  });

  it('supports the collapsed state (icons only)', () => {
    const html = render(<Sidebar collapsed isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('w-sidebar-collapsed');
    expect(html).not.toContain('Engagement Platform');
  });

  it('uses logical (direction-aware) positioning classes', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('start-0'); // side-aware: left in LTR, right in RTL
    expect(html).toContain('border-e');
  });
});
