/**
 * A1 - typed client for /api/v1/roles.
 */

import { api, ApiError } from './api';

export type RoleStatus = 'active' | 'disabled' | 'deleted';

export type Role = {
  id: string;
  name: string;
  permissions: string[];
  status: RoleStatus;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
};

export type RoleUser = {
  id: string;
  name: string | null;
  email: string;
  status: string;
};

export const rolesApi = {
  list: () => api.get<{ roles: Role[] }>('/roles').then((d) => d.roles),

  create: (name: string, permissions: string[]) =>
    api.post<{ role: Role }>('/roles', { name, permissions }).then((d) => d.role),

  update: (roleId: string, name: string, permissions: string[]) =>
    api.patch<{ role: Role }>(`/roles/${roleId}`, { name, permissions }).then((d) => d.role),

  setStatus: (roleId: string, status: RoleStatus) =>
    api.post<{ role: Role }>(`/roles/${roleId}/status`, { status }).then((d) => d.role),

  remove: (roleId: string) =>
    api.del<{ role: Role }>(`/roles/${roleId}`).then((d) => d.role),

  users: (roleId: string) =>
    api.get<{ users: RoleUser[] }>(`/roles/${roleId}/users`).then((d) => d.users)
};

export function describeRoleError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'ROLE_SYSTEM': return 'system-role';
      case 'ROLE_NAME_TAKEN': return 'name-taken';
      case 'ROLE_NOT_DELEGABLE': return 'not-delegable';
      case 'ROLE_INVALID': return 'invalid';
      case 'ROLE_NOT_FOUND': return 'not-found';
      default: return e.code;
    }
  }
  return 'UNKNOWN';
}
