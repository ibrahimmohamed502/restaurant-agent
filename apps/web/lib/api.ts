/**
 * API client for the existing Express backend (/api/v1).
 * - cookies always included (session)
 * - CSRF double-submit header on mutations
 * - typed error envelope mapping
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  return document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.split('=')[1] ?? null;
}

export function csrfToken(): string | null {
  return readCookie('csrf_token');
}

/**
 * Ensures the double-submit CSRF cookie exists before a mutating request.
 * GET /auth/me never returns credentials (401 when anonymous) but the API's
 * csrfGuard sets a fresh `csrf_token` cookie on any first touch — so calling
 * it once "warms up" the cookie without weakening CSRF in any way.
 * Safe to call repeatedly: no-op when the cookie is already present.
 */
export async function ensureCsrfToken(): Promise<string | null> {
  const existing = csrfToken();
  if (existing) return existing;
  await api.get<MeResponse>('/auth/me').catch(() => {});
  return csrfToken();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }
  let res: Response;
  try {
    // never let an unsettled request pin the UI forever
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        credentials: 'include',
        signal: controller.signal,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'network error');
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(res.status, err.code || 'UNKNOWN', err.message || 'unexpected error', err.details);
  }
  return payload?.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path)
};

export type MeResponse = {
  user: { id: string; email: string; name: string | null; roles: string[] };
  tenantId: string;
  roles: string[];
};

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ user: MeResponse['user']; tenantId: string }>('/auth/login', { email, password }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  me: () => api.get<MeResponse>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: true }>('/auth/password', { currentPassword, newPassword })
};

/* ----------------------------------- channels (read-only routing view) */

export type ChannelInfo = {
  id: string;
  provider: string;
  externalId: string | null;
  displayName: string | null;
  status: string;
  brandName: string | null;
  health: 'ok' | 'degraded' | 'down' | null;
  lastEventAt: string | null;
  createdAt: string;
};

export const channelsApi = {
  list: () => api.get<ChannelInfo[]>('/channels')
};

/* ----------------------------------- AI config (Stage 6) */

export type AiConfig = {
  agentName: string;
  brandId: string | null;
  tone: 'professional' | 'friendly' | 'kuwaiti' | 'custom';
  languages: string[];
  rules: Record<string, unknown>;
  workingHours: Record<string, unknown>;
  customInstructions: string;
  updatedAt: string | null;
  fallbackPolicy: { minSimilarity: number; note: string };
};

export const aiApi = {
  config: () => api.get<AiConfig | null>('/ai/config'),
  saveConfig: (payload: Partial<AiConfig>) => api.put<AiConfig>('/ai/config', payload),
  replySources: (messageId: string) => api.get<ReplySource[]>(`/ai/reply-sources?messageId=${messageId}`)
};

export type ReplySource = {
  id: string;
  intent: string;
  retrieval: string;
  confidence: number;
  fallbackUsed: boolean;
  knowledgeVersion: number | null;
  indexStatus: string | null;
  createdAt: string;
  sources: Array<{
    type: 'chunk' | 'fact';
    id?: string;
    section: string | null;
    entityKey?: string | null;
    score?: number;
    content: string | null;
    resolved: boolean;
    source?: string;
  }>;
};

/* ----------------------------------- users (Team & Access) */

export type TeamUser = {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  created_at: string;
  last_login_at: string | null;
  roles: string[];
};

export const usersApi = {
  list: () => api.get<TeamUser[]>('/users'),
  create: (payload: { email: string; name: string; password: string; roles: string[] }) =>
    api.post<TeamUser>('/users', payload),
  setStatus: (id: string, status: 'active' | 'disabled') =>
    api.post<TeamUser>(`/users/${id}/status`, { status }),
  setRoles: (id: string, roles: string[]) =>
    api.post<{ ok: true; roles: string[] }>(`/users/${id}/roles`, { roles }),
  remove: (id: string) => api.del<{ ok: true; id: string }>(`/users/${id}`)
};

/* ----------------------------------- Stage 7: conversations workspace */

export const CONVERSATION_STATES = [
  'AI_ACTIVE',
  'HUMAN_REQUIRED',
  'QUEUED',
  'ASSIGNED',
  'HUMAN_ACTIVE',
  'RESOLVED'
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export type ConversationListItem = {
  id: string;
  customerName: string | null;
  provider: string | null;
  state: ConversationState;
  priority: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedTeamId: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  brandId: string | null;
  brandName: string | null;
  channelName: string | null;
  needsHuman: boolean;
  language: string | null;
  messageCount: number;
  lastText: string | null;
  lastMessageAt: string | null;
};

export type ConversationMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  senderType: 'customer' | 'ai' | 'employee' | 'system';
  text: string | null;
  createdAt: string | null;
  deliveryStatus?: 'pending' | 'sent' | 'failed';
  deliveryError?: string | null;
};

export type ConversationDetail = {
  conversation: {
    id: string;
    customerName: string | null;
    provider: string | null;
    channelName: string | null;
    brandId: string | null;
    brandName: string | null;
    state: ConversationState;
    priority: string | null;
    resolvedAt: string | null;
    assignedUserId: string | null;
    assignedUserName: string | null;
    assignedTeamId: string | null;
    needsHuman: boolean;
    language: string | null;
    createdAt: string | null;
  };
  messages: ConversationMessage[];
  assignmentHistory: Array<{
    id: string;
    action: 'assigned' | 'reassigned' | 'unassigned' | 'resumed' | 'resolved';
    userId: string | null;
    teamId: string | null;
    reason: string | null;
    createdAt: string | null;
    actorUserName: string | null;
    assignedByName: string | null;
  }>;
  /** Server-authoritative permissions — the UI only uses these to hide controls. */
  permissions: {
    canRequestHandoff: boolean;
    canClaim: boolean;
    canAssignOthers: boolean;
    canReassign: boolean;
    canUnassign: boolean;
    canResumeAi: boolean;
    canResolve: boolean;
    canReply: boolean;
    canReadNotes: boolean;
    canCreateNotes: boolean;
  };
};

export type EligibleMember = { id: string; name: string | null; email: string; roles: string[] };

export type InternalNote = {
  id: string;
  body: string;
  createdAt: string | null;
  author: { id: string | null; name: string | null; email: string | null };
  canDelete: boolean;
};

export type AppNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string | null;
};

export type ConversationFilters = {
  state?: string;
  assignedTo?: string;
  brandId?: string;
  limit?: number;
};

export const conversationsApi = {
  list: (filters: ConversationFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.state) q.set('state', filters.state);
    if (filters.assignedTo) q.set('assignedTo', filters.assignedTo);
    if (filters.brandId) q.set('brandId', filters.brandId);
    if (filters.limit) q.set('limit', String(filters.limit));
    const qs = q.toString();
    return api.get<ConversationListItem[]>(`/conversations${qs ? `?${qs}` : ''}`);
  },
  detail: (id: string) => api.get<ConversationDetail>(`/conversations/${id}`),

  requestHandoff: (id: string, reason: string, teamId?: string) =>
    api.post<{ conversationId: string; state: ConversationState }>(`/conversations/${id}/handoff`, { reason, teamId }),

  /** Race-safe self-assign. Loser receives HANDOFF_CONFLICT (409). */
  claim: (id: string, reason?: string) =>
    api.post<{ conversationId: string; state: ConversationState; assignedUserId: string }>(
      `/conversations/${id}/claim`,
      { reason }
    ),

  assign: (id: string, userId: string, reason?: string) =>
    api.post<{ conversationId: string; state: ConversationState; assignedUserId: string; action: string }>(
      `/conversations/${id}/assign`,
      { userId, reason }
    ),

  unassign: (id: string, reason?: string) =>
    api.post<{ conversationId: string; state: ConversationState }>(`/conversations/${id}/unassign`, { reason }),

  activate: (id: string) =>
    api.post<{ conversationId: string; state: ConversationState }>(`/conversations/${id}/activate`, {}),

  resolve: (id: string) =>
    api.post<{ conversationId: string; state: ConversationState }>(`/conversations/${id}/resolve`, {}),

  resumeAi: (id: string, reason: string) =>
    api.post<{ conversationId: string; state: ConversationState }>(`/conversations/${id}/resume-ai`, { reason }),

  /** Human reply — sent through the provider to the real customer. */
  reply: (id: string, text: string, idempotencyKey?: string) =>
    api.post<{
      messageId: string | null;
      providerMessageId: string | null;
      deliveryStatus: 'pending' | 'sent' | 'failed';
      mechanism: string | null;
      duplicate: boolean;
    }>(`/conversations/${id}/reply`, { text, idempotencyKey }),

  retryMessage: (id: string, messageId: string) =>
    api.post<{ messageId: string; deliveryStatus: string }>(
      `/conversations/${id}/messages/${messageId}/retry`,
      {}
    ),

  eligibleMembers: (teamId?: string) =>
    api.get<EligibleMember[]>(`/conversations/eligible-members${teamId ? `?teamId=${teamId}` : ''}`),

  notes: (id: string) => api.get<InternalNote[]>(`/conversations/${id}/notes`),
  addNote: (id: string, body: string) =>
    api.post<InternalNote>(`/conversations/${id}/notes`, { body }),
  deleteNote: (id: string, noteId: string) =>
    api.del<{ id: string; deleted: boolean }>(`/conversations/${id}/notes/${noteId}`)
};

export const notificationsApi = {
  list: (unreadOnly = false) =>
    api.get<{ unread: number; items: AppNotification[] }>(
      `/notifications${unreadOnly ? '?unreadOnly=1' : ''}`
    ),
  markRead: (id: string) => api.post<{ id: string; readAt: string }>(`/notifications/${id}/read`, {}),
  markAllRead: () => api.post<{ marked: number }>('/notifications/read-all', {})
};
