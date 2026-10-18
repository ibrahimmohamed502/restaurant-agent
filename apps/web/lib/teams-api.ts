/**
 * P0.5-B — typed client for /api/v1/teams.
 *
 * Deliberately thin. The server is the only authority on eligibility and on who
 * may do what: this file sends requests and shapes nothing. In particular it
 * does NOT recompute `assignment_eligible`, because a client that derives its
 * own answer will eventually disagree with the server's - and the server is the
 * one that decides whether work can actually be assigned.
 *
 * The one invariant worth restating because the UI depends on it:
 *   assignment_eligible === (warnings.length === 0)
 */

import { api, ApiError } from './api';

export type TeamStatus = 'active' | 'disabled';

export type Team = {
  id: string;
  name: string;
  status: TeamStatus;
  brand_id: string | null;
};

/** Membership is a soft delete, so `role_in_team` is display metadata only. */
export type TeamMember = {
  team_id: string;
  user_id: string;
  role_in_team: string | null;
  has_handling_role: boolean;
  added_at?: string | null;
  revoked_at?: string | null;
};

export const ELIGIBILITY_WARNINGS = [
  'NO_HANDLING_ROLE',
  'NO_BRAND_ACCESS',
  'NO_TEAM',
  'INACTIVE'
] as const;

export type EligibilityWarning = (typeof ELIGIBILITY_WARNINGS)[number];

export type PersonTeamRef = {
  id: string;
  name: string;
  role_in_team: string | null;
};

/**
 * The caller may take work by hand: active, holds a handling role, and can
 * reach the brand in question. It deliberately does NOT require department
 * membership, because assigning by hand never did.
 */
export type EffectivePermission = {
  id: string;
  name: string | null;
  email: string;
  status: string;
  roles: string[];
  teams: PersonTeamRef[];
  all_brands: boolean;
  brand_ids: string[];
  has_handling_role: boolean;
  assignment_eligible: boolean;
  warnings: EligibilityWarning[];
};

/**
 * Three states, not two - because `assignment_eligible` and `warnings` answer
 * DIFFERENT questions and the UI used to collapse them into one badge:
 *
 *   assignment_eligible  -> may this person be assigned BY HAND?
 *   NO_TEAM warning      -> may AI routing ever reach them? (rules target a
 *                           team, so without one, never)
 *
 * A person with a handling role and brand access but no department is
 * therefore genuinely assignable and genuinely unroutable at the same time.
 * Showing a green "Ready" beside a "Not in any department" warning is not a
 * styling nit - it tells an administrator the opposite of the truth.
 *
 * A note on what "ready" does NOT promise: it means the displayed conditions
 * are met. It does not guarantee the person will be handed an automatic
 * conversation - eligibility is necessary, not sufficient, and load balancing,
 * brand scope on the conversation, and the queue all still apply.
 */
export type EligibilityState = 'ready' | 'manual_only' | 'not_ready';

export function eligibilityState(p: {
  assignment_eligible: boolean;
  warnings: readonly string[];
}): EligibilityState {
  if (!p.assignment_eligible) return 'not_ready';
  // "Ready" requires an EMPTY warning list, not merely the absence of NO_TEAM.
  // The server's own rule makes any other warning alongside eligibility
  // impossible today, but keying the green badge off one specific code would
  // mean a future server change could paint it green beside a warning - the
  // exact thing this function exists to prevent. Checking emptiness cannot lie.
  if (p.warnings.length === 0) return 'ready';
  // Eligible by hand, but routing targets a department: with none, routing can
  // never select them.
  return 'manual_only';
}

/** How many people are in at least one department - routing's real pool. */
export function inAnyDepartment(people: readonly EffectivePermission[]): number {
  return people.filter((p) => p.teams.length > 0).length;
}


export type BrandOption = {
  id: string;
  name: string;
  slug?: string;
  status?: string;
};

/**
 * The team abilities this caller holds.
 *
 * Presentation only. The server re-checks every one of them on every route; the
 * screen uses this to avoid offering a button that will only be refused. A
 * stale answer costs an error message, never access.
 */
export type TeamAbilities = {
  abilities: Array<'team.read' | 'team.create' | 'team.update' | 'team.disable' | 'team.assign'>;
};

export const teamsApi = {
  /**
   * Read before rendering write controls. Resolves to an empty list rather than
   * throwing when the caller holds nothing - an accurate "you cannot do any of
   * this" is more useful to a screen than a 403 it cannot explain.
   */
  capabilities: () =>
    api.get<TeamAbilities>('/teams/capabilities').then((d) => d.abilities ?? []),

  list: () => api.get<{ teams: Team[] }>('/teams').then((d) => d.teams),

  /** `brandId` narrows only the eligibility maths; it never changes who is listed. */
  permissions: (brandId?: string | null) =>
    api
      .get<{ people: EffectivePermission[]; warning_count: number }>(
        `/teams/permissions${brandId ? `?brandId=${encodeURIComponent(brandId)}` : ''}`
      )
      .then((d) => d),

  members: (teamId: string) =>
    api.get<{ members: TeamMember[] }>(`/teams/${teamId}/members`).then((d) => d.members),

  create: (name: string, brandId?: string | null) =>
    api.post<{ team: Team }>('/teams', { name, brandId: brandId ?? null }).then((d) => d.team),

  rename: (teamId: string, name: string) =>
    api.patch<{ team: Team }>(`/teams/${teamId}`, { name }).then((d) => d.team),

  // Needs `team.disable`; needs `team.update` as well. A 403 here means the
  // caller holds one without the other, which the UI surfaces rather than hides.
  setStatus: (teamId: string, status: TeamStatus) =>
    api.patch<{ team: Team }>(`/teams/${teamId}`, { status }).then((d) => d.team),

  addMember: (teamId: string, userId: string, roleInTeam = 'agent') =>
    api
      .post<{ member: TeamMember }>(`/teams/${teamId}/members`, { userId, roleInTeam })
      .then((d) => d.member),

  // Soft revoke. Re-adding the same person revives the same row.
  removeMember: (teamId: string, userId: string) =>
    api.del<{ member: TeamMember }>(`/teams/${teamId}/members/${userId}`).then((d) => d.member),

  /** Reuses the existing brands router; the teams screen does not own brands. */
  brands: () => api.get<BrandOption[]>('/companies/brands')
};

/**
 * Turn a server error into something a screen can branch on.
 *
 * Kept here rather than inline so every call site agrees on what "forbidden"
 * means. `FORBIDDEN` is a missing ability; `TEAM_FORBIDDEN` is a session with
 * no company scope. They are different failures and must not collapse into one
 * generic "something went wrong".
 */
export function describeError(e: unknown): {
  kind: 'forbidden' | 'unauthorized' | 'conflict' | 'error';
  code: string;
  /** True when the session has no company scope, rather than lacking a permission. */
  noScope: boolean;
} {
  if (e instanceof ApiError) {
    if (e.status === 403) {
      return { kind: 'forbidden', code: e.code, noScope: e.code === 'TEAM_FORBIDDEN' };
    }
    if (e.status === 401) return { kind: 'unauthorized', code: e.code, noScope: false };
    if (e.status === 409) return { kind: 'conflict', code: e.code, noScope: false };
    return { kind: 'error', code: e.code, noScope: false };
  }
  return { kind: 'error', code: 'UNKNOWN', noScope: false };
}
