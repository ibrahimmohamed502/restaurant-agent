import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rolesTabSrc = readFileSync(new URL('../app/(app)/team/roles-tab.tsx', import.meta.url), 'utf8');
const rolesApiSrc = readFileSync(new URL('../lib/roles-api.ts', import.meta.url), 'utf8');

describe('roles tab (A1)', () => {
  it('the list API excludes deleted roles server-side', () => {
    const src = readFileSync(
      new URL('../../../src/services/roles.js', import.meta.url),
      'utf8'
    );
    expect(src).toContain("status <> 'deleted'");
  });

  it('the list API keeps an explicit includeDeleted escape hatch', () => {
    const src = readFileSync(
      new URL('../../../src/services/roles.js', import.meta.url),
      'utf8'
    );
    expect(src).toContain('includeDeleted');
  });

  it('refreshes the list after a successful delete', () => {
    expect(rolesTabSrc).toContain('rolesApi.remove');
    expect(rolesTabSrc).toMatch(/remove\([\s\S]*?load\(\)/);
  });

  it('renders a create button', () => {
    expect(rolesTabSrc).toContain('openCreate');
  });

  it('renders disable/enable toggle', () => {
    expect(rolesTabSrc).toContain('toggleStatus');
  });

  it('renders delete confirmation', () => {
    expect(rolesTabSrc).toContain('confirmDelete');
  });

  it('does not include server-forbidden abilities in the matrix', () => {
    expect(rolesTabSrc).not.toContain('brand.grant_all');
    expect(rolesTabSrc).not.toContain('brand.revoke_all');
  });

  it('disables toggle for deleted roles', () => {
    expect(rolesTabSrc).toContain("r.status === 'deleted'");
  });

  it('roles-api has all CRUD methods', () => {
    expect(rolesApiSrc).toContain('create:');
    expect(rolesApiSrc).toContain('update:');
    expect(rolesApiSrc).toContain('setStatus:');
    expect(rolesApiSrc).toContain('remove:');
  });
});
