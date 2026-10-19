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
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
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
  /** True while the AI owns the conversation — drives the row badge. */
  aiActive?: boolean;
  channelStatus?: string | null;
  messageCount: number;
  lastText: string | null;
  lastMessageAt: string | null;
};

export type ConversationMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  senderType: 'customer' | 'ai' | 'employee' | 'system';
  senderUserId?: string | null;
  text: string | null;
  createdAt: string | null;
  /** Only outbound rows carry one; null on inbound. */
  deliveryStatus?: 'pending' | 'sent' | 'failed' | null;
  deliveryError?: string | null;
};

/**
 * Server-authoritative reply permissions.
 *
 * These decide what the composer DRAWS. They never grant anything: the API
 * re-evaluates company, brand, state, assignment and channel inside the same SQL
 * statement that writes the message, so a doctored client gains nothing by
 * ignoring them.
 */
export type ConversationReplyReason =
  | 'ok'
  | 'no_ability'
  | 'not_assigned'
  | 'ai_active'
  | 'closed'
  | 'invalid_state'
  | 'channel_unsupported'
  | 'channel_inactive'
  | 'channel_missing'
  | 'window_closed'
  | 'not_found';

export type ConversationReplyPolicy = {
  canReply: boolean;
  reason: ConversationReplyReason;
  reasonText: string;
  canReplyAnyConversation: boolean;
  canReplyOnlyAssigned: boolean;
  maxLength: number;
  messagingWindowSeconds: number;
  sendableProviders: string[];
  replyableStates: string[];
  /** The AI still owns it — an explicit handoff is required, and that is P0.3. */
  requiresHandoff: boolean;
};

/**
 * P0.3-A handoff context — GET /api/v1/conversations/:id/handoff
 *
 * Mirrors the server response exactly. `permissions` is SERVER-AUTHORITATIVE: it
 * describes what this caller may attempt right now. The UI renders from it and the
 * write path re-decides the same questions inside its own transaction, so hiding a
 * button is a courtesy, never a boundary.
 */
export type HandoffPermission = {
  canClaim: boolean;
  canAssign: boolean;
  canReassign: boolean;
  canUnassign: boolean;
  canResolve: boolean;
  canResumeAi: boolean;
  resumeAiBlockedReason: string | null;
  isAssignee: boolean;
  canHandoff: boolean;
  canResolveEscalations: boolean;
};

export type OpenEscalation = {
  id: string;
  category: string | null;
  status: string;
  priority: string;
  createdAt: string | null;
};

export type AssignmentHistoryEntry = {
  id: string;
  action: 'assigned' | 'reassigned' | 'unassigned' | 'resumed' | 'resolved';
  userId: string | null;
  userName: string | null;
  assignedBy: string | null;
  assignedByName: string | null;
  reason: string | null;
  createdAt: string | null;
};

// NOTE: EligibleMember is declared ONCE, below, alongside the other v1 types.
// `users.email` is NOT NULL in the schema, so `email: string` is correct; a second,
// looser copy of this type is exactly how the two drift apart.

/**
 * P0.3-C — the one-time customer acknowledgment, as staff see it.
 *
 * Read-only and advisory: it can never re-enable the AI or unlock an action. Its
 * purpose is to make a failed or skipped reassurance findable, so a customer who
 * was told "someone will reply" and then got nothing is visible to the team
 * responsible for them.
 *
 * `unknown` is the important one. It means the provider may or may not have
 * delivered, and it is never retried — so staff must treat it as "we cannot tell",
 * not as either success or failure, and must not tell the customer it was sent.
 */
export type HandoffAcknowledgment = {
  status: 'pending' | 'sent' | 'failed' | 'unknown' | 'skipped';
  skipReason: string | null;
  language: string | null;
  provider: string | null;
  deliveryError: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type HandoffContext = {
  conversation: {
    id: string;
    state: ConversationState;
    assignedUserId: string | null;
    assignedUserName: string | null;
    assignedTeamId: string | null;
    assignedTeamName: string | null;
    brandId: string | null;
    brandName: string | null;
    channelProvider: string | null;
    channelName: string | null;
    priority: string | null;
    resolvedAt: string | null;
    createdAt: string | null;
  };
  openEscalations: OpenEscalation[];
  history: AssignmentHistoryEntry[];
  eligibleMembers: EligibleMember[];
  permissions: HandoffPermission;
  /** `null` when no acknowledgment was ever attempted — the normal case. */
  acknowledgment?: HandoffAcknowledgment | null;
};

/** Shared shape of every P0.3-A mutation response. */
export type HandoffOperationResult = {
  conversationId: string;
  state: ConversationState;
  assignedUserId: string | null;
  brandId?: string | null;
  /**
   * True when the postcondition already held and this request changed nothing.
   * Rendered as a neutral "already done", NOT an error — a retried request must not
   * look like a failure.
   */
  duplicate: boolean;
  action: string | null;
};

export type EscalationResolveResult = {
  conversationId: string;
  escalationId: string;
  conversationState: ConversationState;
  state: ConversationState;
  duplicate: boolean;
  /** Always false. Closing an escalation never resumes the AI. */
  aiResumed: boolean;
  remainingOpenEscalations?: number;
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
  /** P0.2 — server-authoritative reply permissions + limits. */
  reply: ConversationReplyPolicy;
  /** Active team members of the caller's own company, for the assignee list (P0.3). */
  assigneeOptions: Array<{ id: string; name: string | null; email: string }>;
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

  /**
   * P0.3-A handoff context. Read-only; grants nothing.
   *
   * Returns `permissions` describing what THIS caller may attempt right now, so the
   * Inbox never re-derives a rule the server already decided.
   */
  handoffContext: (id: string) => api.get<HandoffContext>(`/conversations/${id}/handoff`),

  /**
   * P0.3-A staff-initiated handoff: AI_ACTIVE -> QUEUED.
   *
   * Requires `conversation.handoff` and a real reason on the server. Idempotent: a
   * retry on an already-queued conversation returns `duplicate: true` rather than a
   * second handoff. A conversation another actor has advanced is a 409.
   */
  requestHandoff: (id: string, reason: string, teamId?: string) =>
    api.post<HandoffOperationResult>(`/conversations/${id}/handoff`, { reason, teamId }),

  /**
   * P0.3-A escalation closure — closes exactly ONE escalation.
   *
   * Requires `conversation.resolve` (supervisory) and a reason. Never deletes the
   * row, never touches a sibling, and NEVER resumes the AI: the response carries
   * `aiResumed: false`, and Resume AI remains a separate explicit action.
   */
  resolveEscalation: (id: string, escalationId: string, reason: string) =>
    api.post<EscalationResolveResult>(`/conversations/${id}/escalations/${escalationId}/resolve`, { reason }),

  /** Race-safe self-assign. Loser receives HANDOFF_CONFLICT (409). */
  claim: (id: string, reason?: string) =>
    api.post<HandoffOperationResult>(
      `/conversations/${id}/claim`,
      { reason }
    ),

  /**
   * Assign / reassign. `userId` must be one of `handoffContext().eligibleMembers`.
   *
   * The server additionally enforces that the target holds LIVE access to this
   * conversation's brand, and refuses with `OPS_ASSIGNEE_NO_BRAND_ACCESS` otherwise —
   * so the member list is a convenience, not the boundary.
   */
  assign: (id: string, userId: string, reason?: string) =>
    api.post<HandoffOperationResult>(
      `/conversations/${id}/assign`,
      { userId, reason }
    ),

  unassign: (id: string, reason?: string) =>
    api.post<HandoffOperationResult>(`/conversations/${id}/unassign`, { reason }),

  // NOTE: there is deliberately no `activate` method. One used to be declared here
  // pointing at /conversations/:id/activate, a route that has never existed on the
  // server — a dead promise that would have 404ed the moment anyone called it.
  // ASSIGNED -> HUMAN_ACTIVE happens implicitly when an employee replies, inside the
  // P0.2 write path, so there is nothing for the client to invoke.

  resolve: (id: string, reason?: string) =>
    api.post<HandoffOperationResult>(`/conversations/${id}/resolve`, { reason }),

  /**
   * P0.3-A Resume AI — the ONLY way a conversation returns to the AI.
   *
   * The server refuses this while any escalation is unresolved, while a human is
   * engaged, or while an employee reply is undelivered, and reports which. There is
   * deliberately no override parameter anywhere in the stack.
   */
  resumeAi: (id: string, reason: string) =>
    api.post<HandoffOperationResult>(`/conversations/${id}/resume-ai`, { reason }),

  /**
   * Human reply — delivered to the real customer through the company's channel.
   *
   * `idempotencyKey` is REQUIRED, not optional. The Graph send endpoint carries no
   * idempotency key of its own, so this key — held unique by the database on
   * (company, conversation, key) — is the only thing preventing a retried request
   * from delivering a second copy. Generate it ONCE per draft and reuse it for
   * every attempt to send that same draft; see components/inbox/composer.tsx.
   */
  reply: (id: string, text: string, idempotencyKey: string) =>
    api.post<{
      messageId: string | null;
      providerMessageId: string | null;
      deliveryStatus: 'pending' | 'sent' | 'failed';
      deliveryError: string | null;
      /** True only for a refusal Meta documented as transient. Never for ambiguity. */
      retryable: boolean;
      mechanism: string | null;
      duplicate: boolean;
    }>(`/conversations/${id}/reply`, { text, idempotencyKey }),

  retryMessage: (id: string, messageId: string) =>
    api.post<{ messageId: string; deliveryStatus: string }>(
      `/conversations/${id}/messages/${messageId}/retry`,
      {}
    ),

  // NOTE: there is deliberately no `eligibleMembers` method. One used to be declared
  // here pointing at /conversations/eligible-members, a route that has never existed
  // on the server. P0.3-A serves the assignee list inside
  // `handoffContext()`, brand-scoped and tenant-scoped in one place; a second
  // unscoped endpoint for the same data would be one more surface to get wrong.

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

/* ----------------------------------- Stage 8 Batch 1: Platform Super Admin ----------------------------------- */

export type CompanyInfo = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  createdAt: string;
  brandsCount: number;
  usersCount: number;
};

export type CompanyDetail = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  createdAt: string;
  brands: Array<{
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'disabled';
    createdAt: string;
  }>;
};

export type PlatformMetrics = {
  companies: { total: number; active: number };
  users: { total: number; active: number };
  conversations: { total: number };
  channels: { total: number; active: number };
};

/* ------------------------- P0.3: escalation-resolve owner bootstrap ------------------------- */

/** One person who holds the escalation role in a given company. */
export type EscalationManagerHolder = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  role: string;
  /** The role's STORED permissions, shown so the operator can see what is being handed out. */
  permissions: string[];
  /** When the grant happened, taken from the audit row written with the assignment. */
  grantedAt: string | null;
};

/** An active user who could be granted the role (possibly already holding it). */
export type EscalationManagerCandidate = {
  id: string;
  email: string;
  name: string | null;
  already_granted: boolean;
};

/**
 * The server's own description of the grant, not a client-side guess.
 *
 * `permissions` is included so the UI never hardcodes what this role carries: if
 * the server's approved set ever changes, the screen follows it.
 */
export type EscalationManagersView = {
  role: string;
  permissions: string[];
  holders: EscalationManagerHolder[];
  candidates: EscalationManagerCandidate[];
};

export type EscalationGrantResult = {
  granted: boolean;
  /** True when the person already held it — a repeat request, not a new grant. */
  alreadyGranted: boolean;
  tenantId: string;
  userId: string;
  email: string;
  role: string;
  permissions: string[];
  reason: string;
};

export type EscalationRevokeResult = {
  revoked: boolean;
  alreadyRevoked: boolean;
  tenantId: string;
  userId: string;
  email: string;
  role: string;
  reason: string;
};

export const platformApi = {
  listCompanies: () => api.get<CompanyInfo[]>('/platform/companies'),
  getCompany: (id: string) => api.get<CompanyDetail>(`/platform/companies/${id}`),
  createCompany: (payload: { name: string; slug: string; adminEmail: string; adminName: string; adminPassword: string }) =>
    api.post<{ company: { id: string; name: string; slug: string; status: string; createdAt: string };
      brand: { id: string; name: string; slug: string; status: string };
      admin: { id: string; email: string; name: string; status: string; createdAt: string } }>('/platform/companies', payload),
  updateCompany: (id: string, payload: { name?: string; slug?: string }) =>
    api.patch<{ id: string; name: string; slug: string; status: string; createdAt: string }>(`/platform/companies/${id}`, payload),
  disableCompany: (id: string) =>
    api.post<{ id: string; name: string; slug: string; status: string }>(`/platform/companies/${id}/disable`),
  getMetrics: () => api.get<PlatformMetrics>('/platform/metrics'),
  /* ------------------------ P0.3: escalation-resolve owner bootstrap ------------------- */
  /* The only path by which the complaint-closing ability reaches a person.
     Server-side the whole /platform router requires BOTH a platform_super_admins row
     AND the platform role, so hiding these buttons is a convenience, never the
     control. The ability NAME deliberately appears nowhere in this client: authority
     is whatever the server reports, and a client that could name an ability could
     one day start branching on it. */
  listEscalationManagers: (tenantId: string) =>
    api.get<EscalationManagersView>(`/platform/escalation-managers?tenantId=${encodeURIComponent(tenantId)}`),
  grantEscalationManager: (payload: { tenantId: string; userId: string; reason: string }) =>
    api.post<EscalationGrantResult>('/platform/escalation-managers', payload),
  revokeEscalationManager: (payload: { tenantId: string; userId: string; reason: string }) =>
    api.post<EscalationRevokeResult>('/platform/escalation-managers/revoke', payload)
};

/* ----------------------------------- Stage 8 Batch 1: Company Admin ----------------------------------- */

export type BrandInfo = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  createdAt: string;
  defaultLanguage?: string;
};

export type CompanyInfoForAdmin = {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  createdAt: string;
  brands: BrandInfo[];
};

export type CompanyUpdatePayload = {
  name?: string;
  slug?: string;
  timezone?: string;
  locale?: string;
};

export type BrandCreatePayload = {
  name: string;
  slug: string;
  defaultLanguage?: string;
};

export type BrandUpdatePayload = {
  name?: string;
  slug?: string;
  status?: 'active' | 'disabled';
  defaultLanguage?: string;
};

export const companiesApi = {
  getCompany: () => api.get<CompanyInfoForAdmin>('/companies/company'),
  updateCompany: (payload: CompanyUpdatePayload) =>
    api.patch<{ id: string; name: string; slug: string; status: string; createdAt: string }>('/companies/company', payload),
  listBrands: () => api.get<BrandInfo[]>('/companies/brands'),
  createBrand: (payload: BrandCreatePayload) =>
    api.post<BrandInfo>('/companies/brands', payload),
  updateBrand: (id: string, payload: BrandUpdatePayload) =>
    api.patch<BrandInfo>(`/companies/brands/${id}`, payload),
  disableBrand: (id: string) =>
    api.post<BrandInfo>(`/companies/brands/${id}/disable`, {})
};

/* ----------------------------------- Stage 8 Batch 2: integrations ----------------------------------- */

export type ProviderInfo = {
  key: string;
  label: string;
  channelProviders: string[];
  capabilities: { comments: boolean; directMessages: boolean };
};

export type IntegrationInfo = {
  id: string;
  provider: string;
  providerLabel: string;
  externalId: string | null;
  displayName: string | null;
  status: 'active' | 'disabled' | string;
  createdAt: string;
  brand: { id: string; name: string | null } | null;
  /** Presence + expiry only — the API never exposes a credential value. */
  credentials: { present: boolean; expiresAt: string | null };
  health: { status: 'ok' | 'degraded' | 'down' | 'unknown' | string; lastEventAt: string | null; lastError: string | null };
};

export type IntegrationsResponse = {
  integrations: IntegrationInfo[];
  providers: ProviderInfo[];
};

export const integrationsApi = {
  /** Tenant-scoped on the server; `brandId` is only a narrowing filter. */
  list: (brandId?: string) =>
    api.get<IntegrationsResponse>(`/integrations${brandId ? `?brandId=${encodeURIComponent(brandId)}` : ''}`),
  status: (channelId: string) =>
    api.get<{ integration: IntegrationInfo }>(`/integrations/${encodeURIComponent(channelId)}/status`)
};

/* ----------------------------------- B1: Facebook Page self-service OAuth */

/**
 * A Facebook Page the connected account manages, as reported by Meta.
 *
 * `connectable` is decided by the SERVER from Meta's task list, never by this
 * client: a page the app can read but not act on must be refused rather than
 * connected and left to fail silently later. `missingTasks` is what the UI shows
 * to explain why an entry is disabled.
 */
export type DiscoverablePage = {
  pageId: string;
  name: string | null;
  category: string | null;
  tasks: string[];
  connectable: boolean;
  missingTasks: string[];
};

/** A stored Page <-> Brand connection. Never carries a token. */
export type FacebookConnection = {
  id: string;
  brand: { id: string; name: string } | null;
  pageId: string | null;
  pageName: string | null;
  status: string;
  provider: string | null;
  connectedAt: string | null;
  scopes: string[];
  /**
   * `credentialExpiresAt` is null when Meta stated no expiry. That is reported
   * as-is: it is NOT the same as "never expires", and B1 deliberately does not
   * make that claim. Token refresh is a separate batch.
   */
  credentialPresent: boolean;
  credentialExpiresAt: string | null;
};

export const facebookApi = {
  /**
   * Step 1. Mints the OAuth state server-side and returns where to send the
   * browser. The caller navigates; nothing is persisted client-side.
   */
  start: (brandId: string) =>
    api.post<{ authorizeUrl: string; state: string; expiresAt: string }>(
      '/integrations/facebook/connect',
      { brandId }
    ),

  /**
   * Step 3. Re-reads the grant the callback parked, for this session's user and
   * tenant only. Used after the browser returns from Meta.
   */
  pages: (stateId: string) =>
    api.get<{ pages: DiscoverablePage[]; brandId: string | null }>(
      `/integrations/facebook/pages?stateId=${encodeURIComponent(stateId)}`
    ),

  /** Step 4. Persists the chosen page. The server re-derives the page list itself. */
  confirm: (input: { brandId: string; pageId: string; stateId: string; mode?: 'connect' | 'reconnect' }) =>
    api.post<{ connection: { channelId: string; pageId: string; name: string | null; mode: string } }>(
      '/integrations/facebook/confirm',
      input
    ),

  /** Tenant- and brand-scoped on the server. Reports presence and expiry only. */
  connections: (brandId?: string) =>
    api.get<{ connections: FacebookConnection[] }>(
      `/integrations/facebook/connections${brandId ? `?brandId=${encodeURIComponent(brandId)}` : ''}`
    ),

  /** Deactivates the channel and deletes its credential. History is kept. */
  disconnect: (channelId: string) =>
    api.del<{ channelId: string; pageId: string }>(
      `/integrations/facebook/connections/${encodeURIComponent(channelId)}`
    )
};