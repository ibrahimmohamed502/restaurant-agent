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

export type BrandOption = {
  id: string;
  name: string;
  slug?: string;
  status?: string;
};

export const teamsApi = {
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
