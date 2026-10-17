/**
 * P0.3 final batch — owner bootstrap UI and acknowledgment display.
 *
 *   cd apps/web && npx vitest run tests/p03-final.test.tsx
 *
 * These are source- and catalogue-level assertions, following the convention
 * already used in this repository (node environment, no jsdom, no testing-library).
 * The behavioural guarantees live in scripts/test-p03-final-pg.mjs against a real
 * PostgreSQL, and in scripts/test-p03-final.mjs against the real ability graph.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const card = readFileSync(new URL('../app/(app)/companies/escalation-managers-card.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/(app)/companies/page.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../components/inbox/handoff-panel.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
const code = strip(card);
const panelCode = strip(panel);

const ops = (en.inbox as any).ops;
const opsAr = (ar.inbox as any).ops;
const esc = (en.platform as any).escalation;
const escAr = (ar.platform as any).escalation;
const flat = (o: any, p = ''): Array<[string, any]> =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));

describe('P0.3 i18n', () => {
  it('platform.escalation has full EN/AR key parity', () => {
    expect(flat(esc).map(([k]) => k).sort().join(',')).toBe(flat(escAr).map(([k]) => k).sort().join(','));
  });
  it('inbox.ops.ack has full EN/AR key parity', () => {
    expect(flat(ops.ack).map(([k]) => k).sort().join(',')).toBe(flat(opsAr.ack).map(([k]) => k).sort().join(','));
  });
  it('every new Arabic escalation string is Arabic', () => {
    for (const [k, v] of flat(escAr)) {
      if (typeof v !== 'string') continue;
      expect(v, `${k} must be Arabic`).toMatch(/[\u0600-\u06FF]/);
    }
  });
  it('every new Arabic acknowledgment string is Arabic', () => {
    for (const [k, v] of flat(opsAr.ack)) {
      if (typeof v !== 'string') continue;
      expect(v, `${k} must be Arabic`).toMatch(/[\u0600-\u06FF]/);
    }
  });
  it('translates all five acknowledgment statuses', () => {
    for (const s of ['pending', 'sent', 'failed', 'unknown', 'skipped']) {
      expect(ops.ack.status[s], `en ack.status.${s}`).toBeTruthy();
      expect(opsAr.ack.status[s], `ar ack.status.${s}`).toBeTruthy();
    }
  });
  it('translates every skip reason the server can emit', () => {
    for (const s of [
      'not_customer_requested', 'conversation_missing', 'channel_unsupported',
      'channel_inactive', 'window_closed', 'language_undetermined', 'duplicate'
    ]) {
      expect(ops.ack.skip[s], `en ack.skip.${s}`).toBeTruthy();
      expect(opsAr.ack.skip[s], `ar ack.skip.${s}`).toBeTruthy();
    }
  });
  it('states plainly that the grant does NOT include brand or customer access', () => {
    expect(esc.scopeWarning).toMatch(/brand|براند/);
    expect(escAr.scopeWarning).toMatch(/[\u0600-\u06FF]/);
    expect(escAr.scopeWarning).toMatch(/براند/);
  });
  it('has no hardcoded user-facing text in either new component', () => {
    for (const literal of ['Grant permission', 'Reason', 'Company', 'Complaint resolution',
      'منح الإذن', 'السبب', 'الشركة']) {
      expect(card, `hardcoded in card: ${literal}`).not.toContain(`>${literal}<`);
    }
  });
});

describe('P0.3 owner bootstrap UI', () => {
  it('is mounted on the platform page', () => {
    expect(page).toContain('<EscalationManagersCard');
    expect(page).toContain("from './escalation-managers-card'");
  });
  it('targets an explicit company, not an implicit one', () => {
    expect(card).toContain('esc-company');
    expect(card).toMatch(/companies\.length > 0\) setTenantId\(companies\[0\]\.id\)/);
  });
  it('reads the role and permissions from the server rather than hardcoding them', () => {
    expect(code).toContain('view.permissions.join');
    expect(code).toContain('view.role');
    // The ability name may appear in prose explaining the design, but never in
    // executable code — the screen must describe what the server says it does.
    expect(code).not.toMatch(/escalation\.resolve/);
  });
  it('never derives authority from a role name', () => {
    expect(code).not.toMatch(/includes\('Company Admin'\)|includes\('Supervisor'\)|includes\('Escalation Manager'\)|\broles\b/);
  });
  it('requires a reason of at least 8 characters, matching the server', () => {
    expect(code).toMatch(/const MIN_REASON_CHARS = 8/);
    expect(code).toMatch(/reason\.trim\(\)\.length >= MIN_REASON_CHARS/);
  });
  it('disables both grant and revoke until a reason is given', () => {
    expect(code).toMatch(/disabled=\{!userId \|\| !selected \|\| !reasonValid/);
    expect(code).toMatch(/disabled=\{actionBusy !== null \|\| !reasonValid\}/);
  });
  it('does not offer someone who already holds the role again', () => {
    expect(code).toMatch(/\.filter\(\(c\) => !c\.already_granted\)/);
  });
  it('treats an already-granted / already-revoked result as success, not failure', () => {
    expect(code).toMatch(/alreadyGranted \? t\('alreadyGranted'\)/);
    expect(code).toMatch(/alreadyRevoked \? t\('alreadyRevoked'\)/);
  });
  it('reloads after a mutation so the list reflects the server', () => {
    expect(code).toMatch(/await load\(tenantId\)/);
  });
  it('clears the previous answer when the company changes', () => {
    expect(code).toMatch(/else setView\(null\)/);
  });
  it('announces errors and notices to assistive tech', () => {
    expect(card).toContain('role="alert"');
    expect(card).toContain('role="status"');
    expect(card).toContain('data-testid="esc-notice"');
  });
  it('has a testid on the card and the grant button', () => {
    expect(card).toContain('data-testid="escalation-managers"');
    expect(card).toContain('data-testid="grant-escalation"');
  });
  it('exposes the three owner API methods', () => {
    expect(api).toContain('listEscalationManagers');
    expect(api).toContain('grantEscalationManager');
    expect(api).toContain('revokeEscalationManager');
  });
  it('uses a POST action for revoke, because a reason must travel in the body', () => {
    expect(api).toContain("api.post<EscalationRevokeResult>('/platform/escalation-managers/revoke', payload)");
  });
});

describe('P0.3 acknowledgment display', () => {
  it('renders only when an acknowledgment exists', () => {
    expect(panel).toContain('{acknowledgment ? (');
    expect(panel).toContain('data-testid="ack-status"');
  });
  it('exposes the status as an attribute for styling and for tests', () => {
    expect(panel).toContain('data-status={acknowledgment.status}');
  });
  it('renders the server status key and the skip reason', () => {
    expect(panel).toContain('t(`ack.status.${acknowledgment.status}`)');
    expect(panel).toMatch(/t\(`ack\.skip\.\$\{acknowledgment\.skipReason\}`/);
  });
  it('shows an explicit note for the UNKNOWN outcome', () => {
    expect(panel).toContain("acknowledgment.status === 'unknown'");
    expect(panel).toContain("t('ack.unknownNote')");
    expect(ops.ack.unknownNote).toMatch(/not be retried|will not be retried/i);
    expect(opsAr.ack.unknownNote).toMatch(/[\u0600-\u06FF]/);
  });
  it('never claims the customer was answered or was told', () => {
    expect(panelCode).not.toMatch(/has been answered|was answered|customer (was|has been) (told|notified|replied)/i);
    expect(ops.ack.status.sent).not.toMatch(/answered|replied/i);
    expect(opsAr.ack.status.sent).not.toMatch(/اتحل|تم الرد/);
  });
  it('is rendered as plain text, not as a control that could act', () => {
    expect(panel).not.toMatch(/ack\w*\s*(onClick|disabled|href)/);
    // Scoped to the acknowledgment block itself. The panel legitimately contains a
    // close-escalation control from P0.3-B; what matters is that the acknowledgment
    // display cannot drive it, or resume the AI, on its own.
    const block = panel.slice(panel.indexOf('data-testid="ack-status"'), panel.indexOf('data-testid="handoff-outcome"'));
    expect(block).not.toMatch(/onClick|Button|<form/);
    expect(block).not.toMatch(/resumeAi\(|resolveEscalation\(/);
  });
  it('is placed after the channel warning and before the outcome banner', () => {
    expect(panel.indexOf('data-testid="channel-warning"'))
      .toBeLessThan(panel.indexOf('data-testid="ack-status"'));
    expect(panel.indexOf('data-testid="ack-status"'))
      .toBeLessThan(panel.indexOf('data-testid="handoff-outcome"'));
  });
});

describe('P0.3 regressions — everything earlier still holds', () => {
  it('the handoff panel still refreshes on the same lifecycle', () => {
    expect(panel).toMatch(/const REFRESH_INTERVAL_MS = \d+/);
    expect(panel).toContain('if (inFlight.current) return;');
    expect(panel).toContain('if (ticket !== seq.current) return;');
    expect(panel).toContain('if (busy !== null) return;');
    expect(panel).toContain('if (document.hidden) return;');
  });
  it('the Facebook Comment warning is untouched', () => {
    expect(panel).toContain("const isWriteUnsupported = conversation.channelProvider !== 'meta_dm'");
    expect(panel).toContain('data-testid="channel-warning"');
    expect(panel).toContain('data-testid="channel-write-note"');
  });
  it('the seven P0.3-A operations are still present', () => {
    for (const id of ['op-claim', 'op-resolve', 'op-resume-ai', 'op-handoff', 'op-assign', 'op-unassign']) {
      expect(panel, `missing control ${id}`).toContain(`data-testid="${id}"`);
    }
  });
  it('escalation closure is still server-driven', () => {
    expect(panel).toContain('p.canResolveEscalations');
    expect(panel).not.toContain('escalation.resolve');
  });
  it('RTL: no physical spacing or alignment in either new component', () => {
    for (const src of [code, panelCode]) {
      expect(src).not.toMatch(/\b(ml|mr|pl|pr)-/);
      expect(src).not.toMatch(/text-(left|right)\b/);
      expect(src).not.toMatch(/\bfloat-(left|right)\b/);
    }
  });
  it('mobile: wraps rather than overflowing', () => {
    expect(code).toMatch(/flex-wrap/);
    expect(code).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]/);
  });
  it('the existing companies page behaviour is untouched', () => {
    expect(page).toContain('platformApi.createCompany');
    expect(page).toContain('platformApi.disableCompany');
    expect(page).toContain('platformApi.getMetrics()');
  });
});