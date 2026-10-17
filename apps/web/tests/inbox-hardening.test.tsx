/**
 * P0.3 security & UX hardening — frontend side.
 *
 *   cd apps/web && npx vitest run tests/inbox-hardening.test.tsx
 *
 * Covers the refresh lifecycle, the Facebook Comment warning, the escalation
 * permission split as the UI sees it, and translation parity for the new copy.
 * The behavioural half lives in scripts/test-human-operations-pg.mjs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const panel = readFileSync(new URL('../components/inbox/handoff-panel.tsx', import.meta.url), 'utf8');
const view = readFileSync(new URL('../components/inbox/view.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
const code = strip(panel);

const ops = (en.inbox as any).ops;
const opsAr = (ar.inbox as any).ops;
const flat = (o: any, p = ''): Array<[string, any]> =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));

describe('P0.3 i18n parity for the new copy', () => {
  it('inbox namespace matches EN/AR', () => {
    expect(Object.keys(en.inbox).sort().join(',')).toBe(Object.keys(ar.inbox).sort().join(','));
  });
  it('ops namespace matches EN/AR at every level', () => {
    expect(flat(ops).map(([k]) => k).sort().join(',')).toBe(flat(opsAr).map(([k]) => k).sort().join(','));
  });
  it('the channel warning exists in both and is fully Arabic', () => {
    for (const k of ['title', 'body', 'claimNote']) {
      expect(ops.channelNoOutbound[k], `en channelNoOutbound.${k}`).toBeTruthy();
      expect(opsAr.channelNoOutbound[k], `ar channelNoOutbound.${k}`).toMatch(/[\u0600-\u06FF]/);
    }
  });
  it('every Arabic ops value is Arabic (placeholders excepted)', () => {
    for (const [k, v] of flat(opsAr)) {
      if (typeof v !== 'string') continue;
      expect(v.replace(/\{[a-z]+\}/g, ''), `${k} must be Arabic`).toMatch(/[\u0600-\u06FF]/);
    }
  });
  it('no user-facing string is hardcoded', () => {
    for (const literal of ['Replies cannot be sent', 'Claiming does not let you reply',
      'Conversation handling', 'Take over from AI', 'Return to AI']) {
      expect(panel, `hardcoded: ${literal}`).not.toContain(`>${literal}<`);
    }
  });
});

describe('P0.3 handoff refresh lifecycle', () => {
  it('declares an explicit interval', () => {
    expect(panel).toMatch(/const REFRESH_INTERVAL_MS = \d+/);
  });
  it('uses 10s, matching the thread refresh so both views agree', () => {
    const panelMs = Number(panel.match(/const REFRESH_INTERVAL_MS = (\d+)/)![1]);
    const viewMs = Number(view.match(/setInterval\(\(\) => setRefreshToken\(\(n\) => n \+ 1\), (\d+)\)/)![1]);
    expect(panelMs).toBe(10000);
    expect(panelMs).toBe(viewMs);
  });
  it('polls on an interval and clears it', () => {
    expect(code).toContain('setInterval(');
    expect(code).toContain('return () => clearInterval(timer)');
  });
  it('never lets two requests overlap', () => {
    expect(code).toContain('if (inFlight.current) return;');
    expect(code).toContain('inFlight.current = true');
    expect(code).toMatch(/finally \{[\s\S]{0,140}inFlight\.current = false/);
  });
  it('drops a stale response using a monotonic ticket', () => {
    expect(code).toContain('const ticket = ++seq.current;');
    expect((code.match(/if \(ticket !== seq\.current\) return;/g) ?? []).length).toBe(2);
  });
  it('does not refresh while a mutation is in flight', () => {
    expect(code).toContain('if (busy !== null) return;');
  });
  it('does not poll a hidden tab', () => {
    expect(code).toContain('if (document.hidden) return;');
  });
  it('a background refresh never blanks the panel', () => {
    expect(code).toContain('if (!silent) setLoading(true)');
  });
  it('the interval is torn down and rebuilt when its dependencies change', () => {
    expect(code).toMatch(/\}, \[load, busy\]\);/);
  });
  it('refreshes after success and after a conflict', () => {
    expect(code).toMatch(/const r = await fn\(\);[\s\S]{0,500}await load\(true\)/);
    expect(code).toMatch(/if \(isConflict\(err\)\) await load\(true\)/);
  });
  it('a failed context fetch still yields an error, never an infinite skeleton', () => {
    expect(code).toMatch(/if \(loadError \|\| !ctx\)/);
    expect(code.indexOf('if (loadError || !ctx)')).toBeLessThan(code.indexOf('if (loading) {'));
  });
});

describe('P0.3 Facebook Comment channel warning', () => {
  it('is derived from the server provider value', () => {
    expect(code).toContain("const isWriteUnsupported = conversation.channelProvider !== 'meta_dm'");
  });
  it('renders a role="alert" so it is announced', () => {
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('data-testid="channel-warning"');
  });
  it('appears above the action controls', () => {
    expect(panel.indexOf('data-testid="channel-warning"'))
      .toBeLessThan(panel.indexOf('data-testid="op-claim"'));
  });
  it('repeats the point next to the controls that could mislead', () => {
    expect(panel).toContain('data-testid="channel-write-note"');
    expect(code).toContain('isWriteUnsupported && (p.canClaim || p.canAssign || p.canHandoff)');
  });
  it('never claims the customer was answered', () => {
    expect(code).not.toMatch(/has been answered|reply was sent|response sent|customer replied/i);
  });
  it('does not implement comment sending', () => {
    expect(panel).not.toMatch(/conversationsApi\.reply\(/);
    expect(code).not.toMatch(/meta_comment.*(send|post)/i);
  });
  it('does not silently resume AI or close escalations', () => {
    // The polling callback must not mutate state.
    const intervalBody = code.slice(code.indexOf('setInterval('), code.indexOf('return () => clearInterval(timer)'));
    expect(intervalBody).not.toMatch(/resumeAi\(|resolveEscalation|requestHandoff\(|assign\(|claim\(/);
  });
});

describe('P0.3 escalation permission is server-driven', () => {
  it('the panel reads canResolveEscalations from the server', () => {
    expect(panel).toContain('p.canResolveEscalations');
  });
  it('it never derives that from a role name', () => {
    expect(panel).not.toMatch(/Escalation Manager/);
    expect(code).not.toMatch(/roles\.includes|includes\('Company Admin'\)|includes\('Supervisor'\)/);
  });
  it('the API surface is unchanged — this batch added no endpoint', () => {
    expect(api).toContain('resolveEscalation: (id: string, escalationId: string, reason: string)');
    expect(api).toContain('handoffContext: (id: string)');
    // No ability name ever appears client-side: authority is the server's answer.
    expect(api).not.toContain('escalation.resolve');
    expect(panel).not.toContain('escalation.resolve');
  });
});

describe('P0.3 regressions', () => {
  it('the P0.2 composer is untouched', () => {
    expect(view).toContain('<ReplyComposer');
    expect(view).toContain('policy={detail.reply}');
  });
  it('the P0 Inbox detail error state is untouched', () => {
    expect(view).toContain('detailError');
    expect(view.indexOf(': detailError ? ('))
      .toBeLessThan(view.indexOf('detailLoading || !detail ? ('));
  });
  it('the thread refresh timer is untouched', () => {
    expect(view).toMatch(/setRefreshToken\(\(n\) => n \+ 1\), 10000\)/);
  });
  it('the panel is still mounted in the Inbox view', () => {
    expect(view).toContain("import { HandoffPanel } from './handoff-panel'");
    expect(view).toContain('<HandoffPanel');
  });
  it('RTL: no physical spacing or alignment', () => {
    expect(code).not.toMatch(/\b(ml|mr|pl|pr)-/);
    expect(code).not.toMatch(/text-(left|right)\b/);
    expect(code).not.toMatch(/\bfloat-(left|right)\b/);
  });
  it('mobile: wraps, no fixed widths', () => {
    expect(code).toMatch(/flex-wrap/);
    expect(code).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]/);
  });
});