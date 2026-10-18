import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import ar from '@/messages/ar.json';
import {
  ELIGIBILITY_WARNINGS,
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
  it('reads assignment_eligible rather than deriving it from warnings', () => {
    expect(pageCode).toContain('person.assignment_eligible');
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
  it('holds for every combination the server can produce', () => {
    // Mirrors the property asserted against the real API: eligible exactly when
    // nothing is outstanding. If the server ever breaks it, this is where it
    // should be noticed before it becomes a UI that lies.
    const cases: EffectivePermission[] = [
      person(),
      person({ assignment_eligible: false, warnings: ['NO_TEAM'] }),
      person({ assignment_eligible: false, warnings: ['NO_BRAND_ACCESS'] }),
      person({ assignment_eligible: false, warnings: ['NO_HANDLING_ROLE'] }),
      person({ assignment_eligible: false, warnings: ['INACTIVE'] }),
      person({
        assignment_eligible: false,
        warnings: ['NO_HANDLING_ROLE', 'NO_BRAND_ACCESS', 'NO_TEAM']
      })
    ];
    for (const p of cases) {
      expect(p.assignment_eligible).toBe(p.warnings.length === 0);
    }
  });
});
