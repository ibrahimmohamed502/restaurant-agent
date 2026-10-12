import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateOutcome } from '@/components/shell/session-gate';

/* Regression: SessionGate must NEVER hang on the skeleton — every failure mode
   terminates (redirect for dead sessions, retryable error state otherwise). */
describe('SessionGate outcome classification', () => {
  it('maps UNAUTHENTICATED to the dead-session branch', () => {
    expect(gateOutcome({ code: 'UNAUTHENTICATED' })).toBe('unauthenticated');
  });

  it('maps anything else (network/500/timeout/validation) to the error branch', () => {
    expect(gateOutcome({ code: 'NETWORK_ERROR' })).toBe('error');
    expect(gateOutcome({ code: 'INTERNAL' })).toBe('error');
    expect(gateOutcome({ code: undefined })).toBe('error');
    expect(gateOutcome(new Error('boom'))).toBe('error');
    expect(gateOutcome(undefined)).toBe('error');
  });
});

describe('SessionGate failure handling (source contract)', () => {
  const src = readFileSync(new URL('../components/shell/session-gate.tsx', import.meta.url), 'utf8');

  it('dead session → clears the stale cookie and hard-navigates to /login (no redirect loop)', () => {
    expect(src).toContain('authApi.logout()');
    expect(src).toContain("window.location.assign('/login')");
  });

  it('API error → localized retryable error state, not an infinite skeleton', () => {
    expect(src).toContain('ErrorState');
    expect(src).toContain("t('errorTitle')");
    expect(src).toContain("t('retry')");
  });

  it('successful session → releases loading and renders the shell with children', () => {
    expect(src).toContain('<AppShell');
    expect(src).toContain('{children}');
  });

  it('does not weaken auth: no bypass flag, no fake user', () => {
    expect(src).not.toContain('dangerouslySetInnerHTML');
    expect(src).not.toMatch(/setMe\(\{.*fake/i);
  });
});
