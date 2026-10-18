import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import ar from '@/messages/ar.json';
import {
  ELIGIBILITY_WARNINGS,
  eligibilityState,
  inAnyDepartment,
  type EffectivePermission
} from '@/lib/teams-api';

const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );

const enTeams = (en as unknown as { teams: Record<string, unknown> }).teams;
const arTeams = (ar as unknown as { teams: Record<string, unknown> }).teams;

const pageSrc = readFileSync(new URL('../app/(app)/teams/page.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../lib/teams-api.ts', import.meta.url), 'utf8');
const navSrc = readFileSync(new URL('../lib/navigation.ts', import.meta.url), 'utf8');
// apps/web/tests -> apps/web -> apps -> repo root
const doc = readFileSync(new URL('../../../docs/p0-5-b-api-contract.md', import.meta.url), 'utf8');

/**
 * Source text with comments removed.
 *
 * These tests assert that the page does not CALL something. Matching raw source
 * flagged the file's own explanatory comments - which legitimately mention
 * /brand-grants and the eligibility invariant - and turned a passing page red.
 * Strip comments so the assertion is about code, not prose.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const pageCode = code(pageSrc);
const apiCode = code(apiSrc);

/** Resolve a dotted path against the Arabic namespace, returning the leaf. */
function leaf(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], root);
}

function person(over: Partial<EffectivePermission> = {}): EffectivePermission {
  return {
    id: 'p1',
    name: 'Dana',
    email: 'dana@t.local',
    status: 'active',
    roles: ['Agent'],
    teams: [{ id: 'tm1', name: 'Marketing', role_in_team: 'agent' }],
    all_brands: false,
    brand_ids: ['b1'],
    has_handling_role: true,
    assignment_eligible: true,
    warnings: [],
    ...over
  };
}

describe('teams i18n (EN/AR)', () => {
  it('has exact EN/AR key parity', () => {
    expect(flatten(enTeams).sort().join(',')).toBe(flatten(arTeams).sort().join(','));
  });

  it('does not ship English copy into Arabic', () => {
    const untranslated = flatten(arTeams).filter((k) => {
      const v = leaf(arTeams, k);
      return typeof v === 'string' && !/[\u0600-\u06FF]/.test(v);
    });
    expect(untranslated).toEqual([]);
  });

  it('labels every warning code the API can emit', () => {
    for (const code of ELIGIBILITY_WARNINGS) {
      expect(enTeams.eligibility).toHaveProperty(['warnings', code].join('.'));
      expect(arTeams.eligibility).toHaveProperty(['warnings', code].join('.'));
    }
  });
});

describe('capabilities drive the controls, the server still enforces them', () => {
  it('asks the server what the caller may do', () => {
    expect(pageCode).toContain('teamsApi.capabilities()');
    expect(apiCode).toContain("'/teams/capabilities'");
  });

  it('gates each write control on its OWN ability', () => {
    // Renaming and disabling are separate abilities. One combined check would
    // hide the disable button from someone entitled to it - the UI mirror of the
    // backend bug that let update-only callers disable a team.
    expect(pageCode).toContain("allowed('team.create')");
    expect(pageCode).toContain("allowed('team.update')");
    expect(pageCode).toContain("allowed('team.disable')");
    expect(pageCode).toContain("allowed('team.assign')");
  });

  it('never treats having capabilities as being allowed to skip the server', () => {
    // The list is presentation only. Every mutation must still go through the
    // API, and there must be no branch that mutates local state on the strength
    // of `can` alone.
    expect(pageCode).not.toMatch(/if\s*\(\s*can\.length\s*\)\s*\{?\s*(set|await)/);
    expect(pageCode).toContain('teamsApi.rename(');
    expect(pageCode).toContain('teamsApi.setStatus(');
    expect(pageCode).toContain('teamsApi.addMember(');
    expect(pageCode).toContain('teamsApi.removeMember(');
  });

  it('degrades to showing everything when capabilities cannot be read', () => {
    // A failed hint must not blank the screen: the catch sets an empty list,
    // which disables the buttons and still leaves the page readable.
    expect(pageCode).toMatch(/capabilities\(\)[\s\S]{0,80}\.catch\(\(\)\s*=>\s*setCan\(\[\]\)\)/);
  });
});

describe('removing a member', () => {
  it('shows who is in the team before offering to remove them', () => {
    expect(pageCode).toContain('membersOf');
    expect(pageCode).toContain('t(\'team.removeMember\')');
  });

  it('confirms, naming both the person and the team', () => {
    expect(pageCode).toContain("t('team.confirmRemove'");
    expect(pageCode).toContain('removing?.person.name');
    expect(pageCode).toContain('removing?.team.name');
  });

  it('refreshes eligibility afterwards, not just the roster', () => {
    // Removing the last eligible member must visibly change their readiness.
    // Refreshing only the roster would leave the answer stale.
    const after = pageCode.slice(pageCode.indexOf('removeMember('));
    expect(after).toContain('loadPeople(');
  });

  it('uses the destructive style so the action reads as destructive', () => {
    expect(pageCode).toMatch(/Button variant="destructive"[\s\S]{0,200}removeMember/);
  });

  it('derives the roster instead of asking once per team', () => {
    // N extra round trips to learn something the permissions read model already
    // returned - and a second source that could disagree with the first.
    expect(pageCode).not.toContain('teamsApi.members(');
  });
});

describe('the three eligibility states', () => {
  const person = (over: Partial<EffectivePermission> = {}): EffectivePermission => ({
    id: 'p1', name: 'Dana', email: 'dana@t.local', status: 'active',
    roles: ['Agent'], teams: [{ id: 'tm1', name: 'Marketing', role_in_team: 'agent' }],
    all_brands: false, brand_ids: ['b1'], has_handling_role: true,
    assignment_eligible: true, warnings: [], ...over
  });

  it('green means eligible AND nothing outstanding', () => {
    expect(eligibilityState(person())).toBe('ready');
  });

  it('eligible with no department is MANUAL ONLY, not green', () => {
    // The real case from production: a Company Admin with brand access and no
    // department. Collapsing this into "ready" showed a green badge next to
    // "Not in any department", which told the administrator the opposite of
    // the truth.
    const p = person({ teams: [], warnings: ['NO_TEAM'] });
    expect(p.assignment_eligible).toBe(true);
    expect(eligibilityState(p)).toBe('manual_only');
  });

  it('not eligible is never anything but not_ready', () => {
    expect(eligibilityState(person({ assignment_eligible: false, warnings: ['NO_HANDLING_ROLE'] })))
      .toBe('not_ready');
    expect(eligibilityState(person({ assignment_eligible: false, warnings: ['INACTIVE'] })))
      .toBe('not_ready');
    expect(eligibilityState(person({ assignment_eligible: false, warnings: [] })))
      .toBe('not_ready');
  });

  it('no state is ever green while a warning is shown', () => {
    // The invariant the old badge broke: a green badge beside a warning.
    for (const warnings of [[], ['NO_TEAM'], ['NO_HANDLING_ROLE'], ['NO_BRAND_ACCESS'],
      ['NO_HANDLING_ROLE', 'NO_BRAND_ACCESS', 'NO_TEAM'], ['INACTIVE']]) {
      for (const eligible of [true, false]) {
        const s = eligibilityState(person({ warnings: warnings as never, assignment_eligible: eligible }));
        if (warnings.length > 0) {
          expect(s).not.toBe('ready');
        }
      }
    }
  });

  it('counts the people routing could ever consider', () => {
    const people = [
      person({ id: 'a', teams: [{ id: 't', name: 'M', role_in_team: null }] }),
      person({ id: 'b', teams: [] }),
      person({ id: 'c', teams: [{ id: 't', name: 'M', role_in_team: null }] })
    ];
    expect(inAnyDepartment(people)).toBe(2);
  });

  it('the summary shows TWO numbers, never one merged verdict', () => {
    const e = enTeams.eligibility as Record<string, unknown>;
    expect(e).toHaveProperty('summaryManual');
    expect(e).toHaveProperty('summaryRouting');
    expect(pageCode).toContain('summaryManual');
    expect(pageCode).toContain('summaryRouting');
  });

  it('does not claim department membership guarantees automatic assignment', () => {
    // "Eligibility is necessary, not sufficient" has to be said somewhere, or an
    // administrator reads a green badge as a promise.
    expect((enTeams.eligibility as Record<string, unknown>).summaryNote).toMatch(/not sufficient/i);
    expect((arTeams.eligibility as Record<string, unknown>).summaryNote).toBeTruthy();
    const hints = (enTeams.eligibility as Record<string, Record<string, string>>).hint;
    expect(Object.keys(hints)).toContain('ready');
    expect(hints.ready).toMatch(/automatic/i);
  });
});

describe('the page keeps /team and /teams apart', () => {
  it('registers /teams separately from /team in the sidebar', () => {
    expect(navSrc).toContain("href: '/team'");
    expect(navSrc).toContain("href: '/teams'");
  });

  it('has its own title, not the user-management one', () => {
    expect(enTeams.title).toBe('Departments & eligibility');
    expect(enTeams.title).not.toBe((en as unknown as { team: Record<string, string> }).team.nav);
  });

  it('does not call the users or brand-grants API', () => {
    // Accounts and brand access have their own screens and their own abilities.
    // This screen borrowing them would put two places that disagree about who can
    // see what. Asserted against code, not prose - see `code()` above.
    expect(pageCode).not.toContain('usersApi');
    expect(pageCode).not.toContain('brand-grants');
    expect(pageCode).not.toContain('brandGrants');
  });
});

describe('the page renders the server verdict, it does not recompute it', () => {
  it('delegates the verdict to the tested helper rather than deciding inline', () => {
    expect(pageCode).toContain('eligibilityState(person)');
    // The page must not branch on the raw fields itself - that is the drift
    // this feature exists to prevent.
    expect(pageCode).not.toMatch(/person\.assignment_eligible\s*\?/);
    // A local derivation is exactly the drift this feature exists to prevent.
    expect(pageCode).not.toMatch(/warnings\s*\.\s*length\s*===\s*0/);
  });

  it('renders EVERY warning, not just the first', () => {
    expect(pageCode).toContain('person.warnings.map');
    expect(pageCode).not.toMatch(/warnings\s*\[\s*0\s*\]/);
  });

  it('does not call the assignment endpoint - this screen never assigns', () => {
    expect(pageCode).not.toContain('/conversations/');
    expect(pageCode).not.toContain('assignConversation');
  });
});

describe('empty and error states', () => {
  it('has copy for a company with no departments', () => {
    expect(enTeams.empty).toHaveProperty('title');
    expect(enTeams.empty).toHaveProperty('description');
    expect(arTeams.empty).toHaveProperty('title');
  });

  it('calls out the state production is actually in: teams with nobody in them', () => {
    expect(enTeams.empty).toHaveProperty('unassigned');
    expect(arTeams.empty).toHaveProperty('unassigned');
  });

  it('tells the user an empty department cannot receive work', () => {
    expect(enTeams.team).toHaveProperty('emptyRoster');
  });

  it('has distinct copy for unauthorized, forbidden and no-scope', () => {
    // These are three different failures. Collapsing them into one generic
    // message is how "you lack permission" turns into "something went wrong".
    const e = enTeams.errors as Record<string, string>;
    expect(e).toHaveProperty('unauthorizedTitle');
    expect(e).toHaveProperty('forbiddenTitle');
    expect(e).toHaveProperty('noScopeTitle');
    expect(new Set([e.unauthorizedTitle, e.forbiddenTitle, e.noScopeTitle]).size).toBe(3);
  });
});

describe('the client stays thin', () => {
  it('sends the CSRF-safe paths and unwraps the standard envelope', () => {
    expect(apiCode).toMatch(/api\s*\n?\s*\.?\s*get<\{\s*teams:\s*Team\[\]\s*\}>\('\/teams'\)/);
    expect(apiCode).toMatch(/get<\{\s*people:\s*EffectivePermission\[\];\s*warning_count:\s*number\s*\}>/);
    expect(apiCode).toMatch(/api\s*\.?\s*del<\{\s*member:\s*TeamMember\s*\}>\(`\/teams\/\$\{teamId\}\/members\/\$\{userId\}`\)/);
  });

  it('reuses the existing brands router instead of owning brands', () => {
    expect(apiCode).toContain("api.get<BrandOption[]>('/companies/brands')");
    expect(apiCode).not.toContain("api.post<BrandOption>('/brands");
  });

  it('distinguishes a missing ability from a missing company scope', () => {
    expect(apiCode).toContain("noScope: e.code === 'TEAM_FORBIDDEN'");
  });
});

describe('the invariant the screen is built on', () => {
  it('no longer asserts the invented "eligible iff no warnings" rule', () => {
    // That rule was written from an assumption, then "proved" with fixtures I
    // wrote myself, and was wrong: the server does NOT require a department for
    // hand assignment. It is pinned against real server output in
    // test-team-access-pg.mjs instead.
    expect(pageCode).not.toMatch(/warnings\s*\.\s*length\s*===\s*0/);
    expect(doc).not.toMatch(/assignment_eligible\s*===\s*\(warnings\.length === 0\)/);
  });

  it('the contract documents the REAL relationship', () => {
    expect(doc).toMatch(/NO_TEAM/);
    expect(doc).toMatch(/hand/i);
  });
});
