import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('../components/inbox/view.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../components/inbox/handoff-panel.tsx', import.meta.url), 'utf8');

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

const viewCode = strip(view);
const panelCode = strip(panel);

describe('Dialog reset regression - background refresh must not close dialogs', () => {
  it('view.tsx tracks whether this is an initial load vs a refresh', () => {
    expect(viewCode).toContain('const isInitialLoad = prevSelectedRef.current !== selected');
    expect(viewCode).toContain('prevSelectedRef.current = selected');
  });

  it('view.tsx only shows the skeleton on initial load, not on background refresh', () => {
    expect(viewCode).toContain('if (isInitialLoad) setDetailLoading(true)');
  });

  it('view.tsx does not setDetail null on error during a background refresh', () => {
    expect(viewCode).toContain('if (isInitialLoad) setDetail(null)');
  });

  it('HandoffPanel dialog state is NOT reset by background polling', () => {
    const loadFn = panelCode.slice(panelCode.indexOf('const load = React.useCallback'), panelCode.indexOf('React.useEffect(() => { void load();'));
    expect(loadFn).not.toContain('setDialog(null)');
    expect(loadFn).not.toContain('setReason(');
    expect(loadFn).not.toContain('setMemberId(');
  });

  it('the member-selector useEffect is at the top level (Rules of Hooks)', () => {
    const lines = panelCode.split('\n');
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
    expect(lastEffect).toBeLessThan(firstEarlyReturn);
  });

  it('the HandoffPanel is mounted with a stable conversationId (no remount on refresh)', () => {
    expect(view).toContain('conversationId={detail.conversation.id}');
    expect(view).not.toMatch(/<HandoffPanel[^>]*key=/);
  });
});
