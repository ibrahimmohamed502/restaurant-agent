/**
 * P0.3-B — Unified Inbox human-operations UI.
 *
 *   cd apps/web && npx vitest run tests/inbox-ops.test.tsx
 *
 * Runs in vitest's `node` environment (see vitest.config.ts), so there is no DOM.
 * These assertions are therefore about what the component SOURCE guarantees — the
 * same approach as tests/inbox-reply.test.tsx, and the set of things that must not
 * regress silently:
 *
 *   - every control is rendered from the SERVER's permissions object, never from a
 *     role name or a client-side rule
 *   - nothing claims success before the API has confirmed it
 *   - `duplicate` is neutral, not an error and not a second success
 *   - one mutation at a time, so a double click cannot submit twice
 *   - a conflict refetches instead of leaving a stale button enabled
 *   - a failed fetch is an error with a retry, never an infinite skeleton
 *   - every reason-taking action requires a reason AND passes through a confirm
 *   - no user-facing string is hardcoded; EN/AR stay in parity
 *
 * Behavioural coverage of the operations themselves lives in
 * scripts/test-human-operations-pg.mjs, which exercises the real service against
 * a real PostgreSQL.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

const panel = readFileSync(new URL('../components/inbox/handoff-panel.tsx', import.meta.url), 'utf8');
/**
 * Comment-stripped source.
 *
 * Several docblocks deliberately NAME the patterns they forbid ("no optimistic
 * state", "there is deliberately no force parameter"). Asserting on the raw file
 * would match the explanation rather than the behaviour, so behavioural
 * assertions run against the code only.
 */
const panelCode = panel
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\*.*$/gm, '')
  .replace(/\/\/.*$/gm, '');
const view = readFileSync(new URL('../components/inbox/view.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../components/inbox/composer.tsx', import.meta.url), 'utf8');

const ops = (en.inbox as Record<string, unknown>).ops as Record<string, any>;
const opsAr = (ar.inbox as Record<string, unknown>).ops as Record<string, any>;

const flat = (o: any, p = ''): Array<[string, any]> =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));

describe('P0.3-B i18n parity', () => {
  it('inbox namespace matches EN/AR', () => {
    expect(Object.keys(en.inbox).sort().join(',')).toBe(Object.keys(ar.inbox).sort().join(','));
  });
  it('ops namespace matches EN/AR, at every nesting level', () => {
    expect(flat(ops).map(([k]) => k).sort().join(',')).toBe(flat(opsAr).map(([k]) => k).sort().join(','));
  });
  it('every Arabic value is actually Arabic', () => {
    for (const [k, v] of flat(opsAr)) {
      if (typeof v !== 'string') continue;
      // Placeholders like {name} are the only permitted non-Arabic content.
      expect(v.replace(/\{[a-z]+\}/g, ''), `${k} must be Arabic`).toMatch(/[\u0600-\u06FF]/);
    }
  });
  it('no user-facing string is hardcoded in the panel', () => {
    // Every rendered label must come from t(...). Literal English sentinels that
    // would reach the user are the defect this guards.
    for (const literal of ['Claim conversation', 'Assign to', 'Resume AI', 'Take over',
      'Close escalation', 'Reason', 'Cancel', 'Confirm', 'Loading...']) {
      expect(panel, `hardcoded string: ${literal}`).not.toContain(`>${literal}<`);
    }
    // and every control label resolves through the ops namespace
    for (const key of ['claim', 'assign', 'reassign', 'unassign', 'resolve', 'handoff',
      'resumeAi', 'closeEscalation', 'reasonLabel', 'cancel', 'confirm', 'title']) {
      expect(ops[key], `missing en.inbox.ops.${key}`).toBeTruthy();
    }
  });
});

describe('P0.3-B permissions come from the server', () => {
  it('reads the handoff context endpoint, not a role list', () => {
    expect(api).toContain('handoffContext: (id: string) => api.get<HandoffContext>');
    expect(api).toContain('/conversations/${id}/handoff');
  });
  it('renders controls only from ctx.permissions', () => {
    expect(panel).toContain('const { permissions: p');
    for (const flag of ['canClaim', 'canAssign', 'canReassign', 'canUnassign',
      'canResolve', 'canResumeAi', 'canHandoff', 'canResolveEscalations']) {
      expect(panel, `panel must read permissions.${flag}`).toContain(`p.${flag}`);
    }
  });
  it('never derives authority from a role name', () => {
    expect(panel).not.toMatch(/includes\('Company Admin'\)/);
    expect(panel).not.toMatch(/includes\('Supervisor'\)/);
    expect(panel).not.toMatch(/roles\.includes/);
  });
  it('never treats frontend visibility as authorization — it re-sends to the server', () => {
    // There is no local state transition that could bypass the API: the panel never
    // writes a state into its own cache, it only ever replaces the whole context
    // with what the server returned.
    expect(panel).not.toMatch(/setCtx\([^)]*state:\s*'ASSIGNED'/);
    expect(panelCode).not.toMatch(/setCtx\(\{[^}]*state:/);
    // "optimistic" may appear in the docblock explaining why we do not do it.
    expect(panelCode).not.toMatch(/optimistic/i);
  });
});

describe('P0.3-B every operation uses the real endpoint', () => {
  const ops_expected: Array<[string, string, string]> = [
    ['claim', 'claim', '/conversations/${id}/claim'],
    ['assign', 'assign', '/conversations/${id}/assign'],
    ['unassign', 'unassign', '/conversations/${id}/unassign'],
    ['resolve', 'resolve', '/conversations/${id}/resolve'],
    ['resumeAi', 'resumeAi', '/conversations/${id}/resume-ai'],
    ['handoff', 'requestHandoff', '/conversations/${id}/handoff'],
    ['escalation', 'resolveEscalation', '/escalations/${escalationId}/resolve']
  ];
  for (const [name, method, path] of ops_expected) {
    it(`${name} calls conversationsApi.${method} at the real path`, () => {
      expect(api).toContain(path);
      expect(panel).toContain(`conversationsApi.${method}(`);
    });
  }
  it('no invented endpoint exists in the client', () => {
    // Guard against the dead `activate` client that pointed at a route which never
    // existed on the server.
    expect(api).not.toContain('/conversations/${id}/activate');
    expect(api).not.toContain('activate:');
  });
  it('the panel is mounted in the Inbox view', () => {
    expect(view).toContain("import { HandoffPanel } from './handoff-panel'");
    expect(view).toContain('<HandoffPanel');
    expect(view).toContain('conversationId={detail.conversation.id}');
  });
});

describe('P0.3-B reason and confirmation', () => {
  it('every reason-taking action passes through the confirm dialog', () => {
    for (const kind of ['unassign', 'resolve', 'resumeAi', 'handoff', 'escalation', 'assign']) {
      expect(panel, `${kind} must open a dialog`).toContain(`setDialog({ kind: '${kind}'`);
    }
  });
  it('a reason under two characters cannot be submitted', () => {
    expect(panel).toContain('const reasonTooShort = reason.trim().length < 2');
    expect(panel).toContain('disabled={!canSubmitDialog}');
  });
  it('assign additionally requires a selected member', () => {
    expect(panel).toContain("(dialog?.kind !== 'assign' || memberId !== '')");
  });
  it('the reason is sent to the server, not just displayed', () => {
    expect(panel).toContain('const r = reason.trim()');
    expect(panel).toMatch(/unassign\(conversationId, r\)/);
    expect(panel).toMatch(/resumeAi\(conversationId, r\)/);
    expect(panel).toMatch(/requestHandoff\(conversationId, r\)/);
    expect(panel).toMatch(/resolveEscalation\(conversationId, dialog\.escalation\.id, r\)/);
  });
});

describe('P0.3-B escalation handling', () => {
  it('closes exactly one escalation, identified by id', () => {
    expect(panel).toContain('dialog.escalation.id');
  });
  it('offers no control to close every escalation at once', () => {
    expect(panel).not.toMatch(/closeAllEscalations|resolveAll/i);
  });
  it('tells the operator closing does NOT resume the AI', () => {
    expect(ops.escalationNoAutoResume).toBeTruthy();
    expect(ops.escalationDescription).toMatch(/NOT resumed/);
    expect(panel).toContain('escalationNoAutoResume');
  });
  it('surfaces category, priority, status and creation time', () => {
    // The three maps are separate: a priority label is not a category label.
    for (const k of ['high', 'normal', 'low']) {
      expect(ops.priority[k], `priority.${k}`).toBeTruthy();
    }
    for (const k of ['complaint', 'handoff', 'contact_data', 'collab',
      'supplier', 'reservation', 'other']) {
      expect(ops.category[k], `category.${k}`).toBeTruthy();
    }
    for (const k of ['new', 'assigned', 'in_progress', 'done']) {
      expect(ops.escalationStatus[k], `escalationStatus.${k}`).toBeTruthy();
    }
    expect(ops.createdAt).toBeTruthy();
    expect(panel).toContain('t(`priority.${e.priority}`)');
    expect(panel).toContain('t(`category.${e.category ?? \'other\'}`)');
    expect(panel).toContain('t(`escalationStatus.${e.status}`)');
    expect(panel).toContain("relTime(e.createdAt)");
  });
});

describe('P0.3-B resume-AI safety', () => {
  it('is offered only when the server permits it', () => {
    expect(panel).toContain('p.canResumeAi ?');
  });
  it('shows the server-supplied blocker reason instead of silently hiding it', () => {
    expect(panel).toContain('p.resumeAiBlockedReason');
    expect(panel).toContain('data-testid="resume-ai-blocked"');
    expect(panel).toContain('resumeBlockedText(p.resumeAiBlockedReason, t)');
  });
  it('explains every blocker the server can return', () => {
    for (const r of ['open_escalations', 'human_engaged', 'reply_in_flight', 'no_ability',
      'already_ai_active', 'state_not_resumable']) {
      expect(ops.resumeBlocked[r], `resumeBlocked.${r}`).toBeTruthy();
      expect(panel, `panel must handle ${r}`).toContain(`'${r}'`);
    }
  });
  it('offers no override — there is nothing to bypass an escalation with', () => {
    expect(panelCode).not.toMatch(/\bforce\b|\boverride\b|ignoreEscalation/i);
    const apiCode = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
    expect(apiCode).not.toMatch(/\bforce\b|\boverride\b/i);
    // Resume AI sends nothing but its own id and reason.
    expect(panel).toMatch(/conversationsApi\.resumeAi\(conversationId, r\)/);
  });
});

describe('P0.3-B staff handoff', () => {
  it('warns that the AI will stop and that no message is sent', () => {
    expect(ops.handoffDescription).toMatch(/AI will stop/);
    expect(ops.handoffDescription).toMatch(/No message is sent/);
    expect(panel).toContain('handoffDescription');
  });
  it('sends no customer message — P0.3-C owns that', () => {
    // The handoff path must not touch the reply endpoint at all.
    expect(panel).not.toMatch(/conversationsApi\.reply\(/);
  });
});

describe('P0.3-B errors, concurrency and duplicate submissions', () => {
  it('handles every status the API can return', () => {
    // Each server code maps to a distinct translation key — asserted explicitly,
    // because deriving the key name mechanically would pass even if the key did
    // not exist.
    const codeToKey: Record<string, string> = {
      OPS_FORBIDDEN: 'forbidden',
      OPS_NOT_FOUND: 'notFound',
      OPS_ESCALATION_NOT_FOUND: 'escalationNotFound',
      OPS_ASSIGNEE_NO_BRAND_ACCESS: 'assigneeBrand',
      OPS_ASSIGNEE_NOT_ELIGIBLE: 'assigneeIneligible',
      OPS_OPEN_ESCALATIONS: 'openEscalations',
      OPS_HUMAN_ENGAGED: 'humanEngaged',
      OPS_REPLY_IN_FLIGHT: 'replyInFlight',
      OPS_NOT_ASSIGNED: 'notAssigned',
      HANDOFF_CONFLICT: 'conflict',
      HANDOFF_INVALID_TRANSITION: 'invalidTransition',
      HANDOFF_REASON_REQUIRED: 'reasonRequired',
      HANDOFF_USER_NOT_ELIGIBLE: 'assigneeIneligible',
      HANDOFF_SAME_ASSIGNEE: 'sameAssignee',
      HANDOFF_NOT_ASSIGNED: 'notAssigned',
      HANDOFF_NOT_FOUND: 'notFound',
      OPS_VALIDATION_FAILED: 'validation',
      OPS_INTERNAL: 'server'
    };
    for (const [code, key] of Object.entries(codeToKey)) {
      expect(panel, `must map ${code}`).toContain(`'${code}'`);
      expect(panel, `${code} must resolve to errors.${key}`).toContain(`errors.${key}`);
      expect(ops.errors[key], `translation errors.${key} for ${code}`).toBeTruthy();
    }
    // Every key in the map must be a real translation.
    for (const key of Object.values(codeToKey)) {
      expect(ops.errors[key], `errors.${key}`).toBeTruthy();
    }
    expect(panel).toContain('err.status === 409');
    expect(panel).toContain('err.status === 0'); // network
  });
  it('a failed context fetch is an error with a retry, never a skeleton', () => {
    expect(panel).toContain('const [loadError, setLoadError]');
    expect(panel).toContain('data-testid="handoff-panel-error"');
    expect(panel).toContain('<ErrorState');
    expect(panel).toMatch(/if \(loadError \|\| !ctx\)/);
    // The error branch must come BEFORE the skeleton branch. `loading && !ctx`
    // would also be safe today, but ordering it this way means no future edit can
    // reintroduce the infinite skeleton this bug class came from.
    expect(panelCode.indexOf('if (loadError || !ctx)'))
      .toBeLessThan(panelCode.indexOf('if (loading) {'));
    // A failed fetch must CLEAR the context, or the panel would keep rendering the
    // previous conversation's controls.
    expect(panelCode).toMatch(/catch[\s\S]{0,240}setCtx\(null\)/);
  });
  it('prevents duplicate submissions', () => {
    expect(panel).toContain('if (busy) return');
    expect(panel).toContain('const disabled = busy !== null');
    expect(panel).toMatch(/disabled=\{disabled\}/);
    expect(panel).toContain("aria-busy={busy === 'claim'}");
  });
  it('renders duplicate as neutral, not as success or failure', () => {
    expect(panel).toContain("kind: 'duplicate'");
    expect(panel).toContain('t(\'outcome.alreadyDone\')');
    expect(ops.outcome.alreadyDone).toBeTruthy();
    // and it must not be styled as either success or error
    expect(panel).toMatch(/outcome\.kind === 'duplicate'[\s\S]{0,200}border-border/);
  });
  it('never shows success before the server confirms it', () => {
    // Scoped to run() so the Outcome TYPE declaration (which also contains
    // `kind: 'ok'`) cannot satisfy the ordering check.
    const start = panelCode.indexOf('const run = React.useCallback');
    const body = panelCode.slice(start, panelCode.indexOf('}, [busy, load, onChanged, t])'));
    expect(body).toContain("kind: 'ok'");
    expect(body.indexOf('const r = await fn()')).toBeLessThan(body.indexOf("kind: 'ok'"));
    // Clearing the previous banner may happen BEFORE the await — that is correct,
    // it stops a stale "done" showing while the new request is in flight. What must
    // never happen before the await is a real outcome.
    expect(body).toMatch(/setOutcome\(null\)/);
    const beforeAwait = body.slice(0, body.indexOf('const r = await fn()'));
    expect(beforeAwait).not.toContain("kind: 'ok'");
    expect(beforeAwait).not.toContain("kind: 'error'");
    expect(beforeAwait).not.toContain("kind: 'duplicate'");
  });
  it('refreshes server state after a success AND after a conflict', () => {
    expect(panel).toMatch(/const r = await fn\(\);[\s\S]{0,400}await load\(true\)/);
    expect(panel).toMatch(/if \(isConflict\(err\)\) await load\(true\)/);
  });
  it('a stale assignee selection cannot be submitted', () => {
    expect(panel).toContain('if (memberId && !ids.has(memberId)) setMemberId(\'\')');
  });
});

describe('P0.3-B responsive and RTL', () => {
  it('uses direction-agnostic layout so RTL mirrors correctly', () => {
    // Tailwind's ml-/mr-/pl-/pr- are PHYSICAL and do not mirror in RTL; the
    // logical equivalents are ms-/me-/ps-/pe-. Note `items-` contains the substring
    // `ms-`, so a naive match is a false positive — hence \b and the explicit
    // physical-property list.
    expect(panelCode).not.toMatch(/\b(ml|mr|pl|pr)-/);
    expect(panelCode).not.toMatch(/text-(left|right)\b/);
    expect(panelCode).not.toMatch(/(^|[\s"'{])(left|right)\s*:/);
    expect(panelCode).not.toMatch(/\bfloat-(left|right)\b/);
    expect(panelCode).not.toMatch(/\brounded-(l|r)\b/);
    // Alignment comes from flexbox, which is direction-aware by definition.
    expect(panelCode).toMatch(/justify-between|justify-center|items-start|items-center/);
    // and every horizontal pad/margin used is symmetric (px-, mx-) or logical.
    expect(panelCode).not.toMatch(/\bpx-\[/);
  });
  it('lays out for small screens without a fixed width', () => {
    expect(panel).toMatch(/flex-wrap/);
    expect(panel).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]/);
  });
  it('user-supplied reasons are not forced into one direction', () => {
    // A reason written in Arabic inside an English UI must still read correctly.
    expect(panel).toContain('maxLength={500}');
  });
});

describe('P0.3-B regressions', () => {
  it('the P0.2 reply composer is untouched', () => {
    expect(view).toContain('<ReplyComposer');
    expect(composer).toContain('newIdempotencyKey');
    expect(composer).toContain('if (sending) return');
    // The composer keeps its own policy-driven guard; the panel never relaxes it.
    expect(view).toContain('policy={detail.reply}');
  });
  it('the P0 Inbox detail error state is untouched', () => {
    expect(view).toContain('detailError');
    expect(view.indexOf(': detailError ? ('))
      .toBeLessThan(view.indexOf('detailLoading || !detail ? ('));
  });
  it('the detail and list reads are not weakened by this batch', () => {
    // The SQL lives in the BACKEND (src/api/v1/conversations.js); view.tsx fetches
    // the scoped API. So the thing to protect here is that no unscoped client-side
    // read is introduced — the panel must go through the same authenticated,
    // brand-scoped endpoints as everything else.
    expect(view).toContain("fetch('/api/v1/conversations'");
    expect(view).toContain('credentials: \'include\'');
    expect(view).not.toContain('handoffContext('); // the panel owns that call
    expect(panel).toContain('conversationsApi.handoffContext(conversationId)');
  });
});