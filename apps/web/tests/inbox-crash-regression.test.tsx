import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const panel = readFileSync(new URL('../components/inbox/handoff-panel.tsx', import.meta.url), 'utf8');

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

const code = strip(panel);

describe('Inbox crash regression - Rules of Hooks', () => {
  it('every React.useEffect is declared BEFORE the first early return', () => {
    const lines = code.split('\n');
    let firstEarlyReturn = -1;
    let lastEffect = -1;
    for (let i = 0; i < lines.length; i++) {
      if (firstEarlyReturn === -1 && /if\s*\(\s*loadError\s*\|\|\s*!ctx\s*\)/.test(lines[i])) {
        firstEarlyReturn = i;
      }
      if (/React\.useEffect\s*\(/.test(lines[i])) {
        lastEffect = i;
      }
    }
    expect(firstEarlyReturn).toBeGreaterThan(-1);
    expect(lastEffect).toBeGreaterThan(-1);
    expect(lastEffect).toBeLessThan(firstEarlyReturn);
  });

  it('the member-selector effect reads from ctx eligibleMembers, not a bare variable', () => {
    expect(code).toContain('const members = ctx?.eligibleMembers ?? []');
    expect(code).toContain('const ids = new Set(members.map((m) => m.id))');
  });

  it('the member-selector effect is guarded by dialog kind assign', () => {
    expect(code).toContain("if (dialog?.kind !== 'assign') return;");
  });

  it('the panel renders the loading state without crashing (SSR)', () => {
    const loadingIdx = code.indexOf('data-testid="handoff-panel-loading"');
    const errorIdx = code.indexOf('data-testid="handoff-panel-error"');
    expect(loadingIdx).toBeGreaterThan(errorIdx);
    expect(loadingIdx).toBeGreaterThan(0);
  });

  it('the panel renders the error state without crashing (SSR)', () => {
    expect(code).toContain('data-testid="handoff-panel-error"');
    expect(code).toContain('ErrorState');
  });

  it('translations are present for all acknowledgment statuses', () => {
    const ops = (en.inbox as any).ops;
    const opsAr = (ar.inbox as any).ops;
    for (const s of ['pending', 'sent', 'failed', 'unknown', 'skipped']) {
      expect(ops.ack.status[s]).toBeTruthy();
      expect(opsAr.ack.status[s]).toBeTruthy();
    }
  });
});
