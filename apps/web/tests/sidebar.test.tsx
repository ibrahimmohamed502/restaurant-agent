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

describe('Sidebar (global SaaS navigation — reference layout)', () => {
  it('shows the product header', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('LWC Platform');
  });

  it('renders all navigation entries in the reference order with icons', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    const order = ['/dashboard', '/inbox', '/customers', '/companies', '/brands', '/channels', '/ai', '/knowledge', '/team', '/integrations', '/audit', '/settings'];
    const positions = order.map((h) => html.indexOf(`href="${h}"`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions); // ascending = reference order
    // every item has an icon (svg) and a visible label
    expect((html.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(order.length);
    for (const label of ['Dashboard', 'Unified Inbox', 'Customers', 'Companies', 'Brands', 'Channels', 'AI', 'Knowledge Base', 'Team &amp; Access', 'Integrations', 'Audit Logs', 'Settings']) {
      expect(html).toContain(label);
    }
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
    expect(html).toContain('لوحة التحكم');
  });

  it('uses logical (direction-aware) positioning — left in LTR, right in RTL', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('start-0'); // physical side follows dir
    expect(html).toContain('border-e');
    expect(html).toContain('ltr:-translate-x-full rtl:translate-x-full lg:translate-x-0');
  });

  it('renders the mobile drawer backdrop when open', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('bg-black/40');
    expect(html).toContain('translate-x-0');
  });

  it('collapses to an icon rail (no giant blank column)', () => {
    const html = render(<Sidebar collapsed isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect(html).toContain('w-sidebar-collapsed');
    expect(html).not.toContain('Engagement Platform');
    // labels remain available to screen readers (sr-only), not removed
    expect(html).toContain('sr-only');
  });

  it('highlights the active route with aria-current', () => {
    const html = render(<Sidebar collapsed={false} isSuperAdmin mobileOpen={false} onToggleCollapsed={noop} onCloseMobile={noop} />);
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    const inboxIdx = html.indexOf('href="/inbox"');
    const tagStart = html.lastIndexOf('<a ', inboxIdx);
    expect(html.slice(tagStart, inboxIdx + 400)).toContain('aria-current="page"');
  });
});
