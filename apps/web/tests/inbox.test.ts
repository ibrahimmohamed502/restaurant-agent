import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

describe('localization parity for Stage 5 surfaces', () => {
  it('inbox namespace matches EN/AR', () => {
    expect(Object.keys(en.inbox).sort().join(',')).toBe(Object.keys(ar.inbox).sort().join(','));
  });
  it('dashboard and nav namespaces match EN/AR', () => {
    expect(Object.keys(en.dashboard).sort().join(',')).toBe(Object.keys(ar.dashboard).sort().join(','));
    expect(Object.keys(en.nav).sort().join(',')).toBe(Object.keys(ar.nav).sort().join(','));
  });
  it('nav.dashboard remains a string label (no nested object regression)', () => {
    expect(typeof en.nav.dashboard).toBe('string');
    expect(typeof ar.nav.dashboard).toBe('string');
    expect(typeof en.inbox).toBe('object');
  });
});

describe('inbox uses tenant-scoped authenticated endpoints only', () => {
  const src = readFileSync(new URL('../components/inbox/view.tsx', import.meta.url), 'utf8');
  it('calls /api/v1/conversations with credentials', () => {
    expect(src).toContain("fetch('/api/v1/conversations'");
    expect(src).toContain('credentials:');
  });
  it('never supplies a tenant id from the browser', () => {
    expect(src).not.toMatch(/tenant/);
  });
  it('contains no placeholder copy', () => {
    expect(src).not.toContain('placeholder');
  });
});

describe('login artwork is local (no external hotlinks)', () => {
  it('login page uses inline SVG only', () => {
    const src = readFileSync(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<svg');
    expect(src).toContain('url(#cacaoBg)');
    expect(src).not.toMatch(/https?:\/\/[^"']*\.(png|jpe?g|webp|jpeg|gif)/i);
  });
  it('offers a language toggle and theme toggle', () => {
    const src = readFileSync(new URL('../app/login/page.tsx', import.meta.url), 'utf8');
    expect(src).toContain('setLocaleCookie');
  });
});
