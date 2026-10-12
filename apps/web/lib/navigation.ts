export type NavItem = {
  key: string;
  href: string;
  icon: string;
  group: 'overview' | 'engagement' | 'organization' | 'configuration';
  superAdminOnly?: boolean;
};

/** Sidebar information architecture (super-admin items hidden by RBAC). */
export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', href: '/dashboard', icon: 'layout-dashboard', group: 'overview' },
  { key: 'inbox', href: '/inbox', icon: 'inbox', group: 'engagement' },
  { key: 'customers', href: '/customers', icon: 'users', group: 'engagement' },
  { key: 'companies', href: '/companies', icon: 'building-2', group: 'organization', superAdminOnly: true },
  { key: 'brands', href: '/brands', icon: 'tags', group: 'organization' },
  { key: 'channels', href: '/channels', icon: 'radio', group: 'organization' },
  { key: 'ai', href: '/ai', icon: 'sparkles', group: 'configuration' },
  { key: 'knowledge', href: '/knowledge', icon: 'book-open', group: 'configuration' },
  { key: 'team', href: '/team', icon: 'shield', group: 'configuration' },
  { key: 'integrations', href: '/integrations', icon: 'plug', group: 'configuration' },
  { key: 'audit', href: '/audit', icon: 'scroll-text', group: 'configuration', superAdminOnly: true },
  { key: 'settings', href: '/settings', icon: 'settings', group: 'configuration' }
];
