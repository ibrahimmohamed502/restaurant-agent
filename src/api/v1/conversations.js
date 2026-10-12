/**
 * Stage 5 + Stage 7 — Unified Inbox API.
 *
 * Stage 5 gave us the read-only tenant-scoped list/detail. Stage 7 turns the
 * same router into the customer-service workspace: handoff, assignment,
 * unassignment, activation, resolution, Resume AI, human reply and notes.
 *
 * HARD RULES (unchanged from Stage 5):
 *  - every query is scoped by req.v1.tenantId taken from the SERVER session
 *  - the browser never supplies a tenant, brand, channel, page or customer id
 *  - internal notes are NEVER part of the message timeline payload
 *  - all mutations require CSRF (enforced globally in ./index.js) + audit
 *
 * ROUTE ORDER: static segments (`/eligible-members`) are registered BEFORE the
 * dynamic `/:id` so they can never be captured as a conversation id.
 */
import express from 'express';
import { requireV1Auth, apiError, validate, ApiError } from './index.js';
import { requireAbility, can, isSupervisorOrAdmin } from './stage7-rbac.js';
import { audit } from '../../auth/audit.js';
import { pool } from '../../db/pg.js';
import {
  CONVERSATION_STATES, HANDLED_STATES, REQUESTED_BY,
  requestHandoff, claimConversation, assignConversation, unassignConversation,
  activateHumanHandling, resolveConversation, resumeAi,
  listEligibleMembers, getConversationHandoffView, listAssignmentHistory,
  HandoffError, HANDLING_ROLES
} from '../../services/handoff.js';
import { HANDOFF_REASONS } from '../../services/handoffDetector.js';
import {
  createNotifications, NOTIFICATION_TYPES, resolveNotificationRecipients
} from '../../services/notifications.js';
import {
  sendHumanReply, retryHumanReply, HumanReplyError, canUserReplyToConversation,
  defaultCredentialResolver
} from '../../services/humanReply.js';
import { createNotesRouter } from './notes.js';

const STATE_FILTERS = new Set([...Object.values(CONVERSATION_STATES), 'needs_human']);

export function createConversationsRouter({ pool: db = pool, resolveCredential = null } = {}) {
  const router = express.Router();
  router.use(requireV1Auth);

  /** Injected credential resolver (defaults to the real DB path). */
  const cred = (externalId, tenantId) =>
    resolveCredential
      ? resolveCredential(externalId, tenantId)
      : defaultCredentialResolver(externalId, tenantId);

  /* ---------------------------------------------------------------- */
  /* Stage 7 hooks: audit + notifications                              */
  /* ---------------------------------------------------------------- */

  function stage7Deps(req) {
    const tenantId = req.v1.tenantId;
    return {
      db,
      actorUserId: req.v1.user.id,
      onHandoffRequested: async ({ conversationId, reason, priority, requestedBy, assignedTeamId }) => {
        audit({
          tenantId, actorUserId: req.v1.user.id, action: 'conversation.handoff',
          objectType: 'conversation', objectId: conversationId, ip: req.ip,
          metadata: { requestedBy, reason, priority }
        });
        const recipients = await resolveNotificationRecipients({ tenantId, teamId: assignedTeamId, db });
        await createNotifications({
          tenantId, userIds: recipients, type: NOTIFICATION_TYPES.HANDOFF_REQUESTED,
          title: 'A conversation needs a human',
          data: { conversationId, reason, requestedBy, priority }
        });
      },
      onAssigned: async ({ conversationId, userId, previousAssignee, action }) => {
        audit({
          tenantId, actorUserId: req.v1.user.id, action: 'conversation.assign',
          objectType: 'conversation', objectId: conversationId, ip: req.ip,
          metadata: { userId, previousAssignee, action }
        });
        const recipients = new Set([userId]);
        if (previousAssignee && previousAssignee !== userId) recipients.add(previousAssignee);
        await createNotifications({
          tenantId, userIds: [...recipients],
          type: action === 'reassigned' ? NOTIFICATION_TYPES.REASSIGNED : NOTIFICATION_TYPES.ASSIGNED,
          title: action === 'reassigned' ? 'A conversation was reassigned to you' : 'A conversation was assigned to you',
          data: { conversationId, action }
        });
      },
      onUnassigned: async ({ conversationId, previousAssignee, reason }) => {
        audit({
          tenantId, actorUserId: req.v1.user.id, action: 'conversation.unassign',
          objectType: 'conversation', objectId: conversationId, ip: req.ip,
          metadata: { previousAssignee, reason }
        });
        if (previousAssignee) {
          await createNotifications({
            tenantId, userIds: [previousAssignee], type: NOTIFICATION_TYPES.UNASSIGNED,
            title: 'A conversation was unassigned', data: { conversationId }
          });
        }
      },
      onResolved: async ({ conversationId, userId }) => {
        audit({
          tenantId, actorUserId: req.v1.user.id, action: 'conversation.resolve',
          objectType: 'conversation', objectId: conversationId, ip: req.ip
        });
        if (userId) {
          await createNotifications({
            tenantId, userIds: [userId], type: NOTIFICATION_TYPES.RESOLVED,
            title: 'A conversation was resolved', data: { conversationId }
          });
        }
      },
      onAiResumed: async ({ conversationId, reason }) => {
        audit({
          tenantId, actorUserId: req.v1.user.id, action: 'conversation.resume_ai',
          objectType: 'conversation', objectId: conversationId, ip: req.ip,
          metadata: { reason }
        });
        const recipients = await resolveNotificationRecipients({ tenantId, db });
        await createNotifications({
          tenantId, userIds: recipients, type: NOTIFICATION_TYPES.AI_RESUMED,
          title: 'AI handling was resumed', data: { conversationId }
        });
      }
    };
  }

  function fail(res, err) {
    if (err instanceof HandoffError) {
      return apiError(res, err.status, err.code, err.message);
    }
    if (err instanceof HumanReplyError) {
      return apiError(res, err.status, err.code, err.message);
    }
    if (err instanceof ApiError) {
      return apiError(res, err.status, err.code, err.message, err.details);
    }
    console.error('stage7 conversations error:', err?.message);
    return apiError(res, 500, 'INTERNAL', 'unexpected error');
  }

  /* ---------------------------------------------------------------- */
  /* STATIC routes — must be registered BEFORE /:id                    */
  /* ---------------------------------------------------------------- */

  /** GET /conversations/eligible-members?teamId= */
  router.get('/eligible-members', requireAbility('conversation.read'), async (req, res, next) => {
    try {
      const members = await listEligibleMembers({
        tenantId: req.v1.tenantId,
        teamId: req.query.teamId || null,
        db
      });
      return res.json({
        data: members.map((m) => ({ id: m.id, name: m.name, email: m.email, roles: m.roles ?? [] }))
      });
    } catch (err) { return next(err); }
  });

  /** GET /conversations — Stage 5 list + Stage 7 fields + filters */
  router.get('/', requireAbility('conversation.read'), async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const { state, assignedTo, brandId } = req.query;

      const where = ['c.tenant_id = $1'];
      const params = [req.v1.tenantId];

      if (state && STATE_FILTERS.has(state)) {
        if (state === 'needs_human') {
          where.push(`c.state = ANY($${params.length + 1}::text[])`);
          params.push(HANDLED_STATES);
        } else {
          where.push(`c.state = $${params.length + 1}`);
          params.push(state);
        }
      }
      if (assignedTo === 'me') {
        where.push(`c.assigned_user_id = $${params.length + 1}`);
        params.push(req.v1.user.id);
      } else if (assignedTo === 'unassigned') {
        where.push(`c.assigned_user_id IS NULL`);
      } else if (assignedTo) {
        where.push(`c.assigned_user_id = $${params.length + 1}`);
        params.push(assignedTo);
      }
      if (brandId) {
        where.push(`ch.brand_id = $${params.length + 1}`);
        params.push(brandId);
      }
      params.push(limit);

      const { rows } = await db.query(
        `SELECT c.id, c.state, c.language, c.last_message_at, c.priority,
                c.assigned_user_id, c.assigned_team_id, c.resolved_at, c.created_at,
                cu.display_name AS customer_name,
                ch.provider, ch.brand_id, b.name AS brand_name, ch.display_name AS channel_name,
                au.name AS assigned_user_name,
                (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
                (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at_ts
           FROM conversations c
           LEFT JOIN customers cu ON cu.id = c.customer_id
           LEFT JOIN channels ch ON ch.id = c.channel_id
           LEFT JOIN brands b ON b.id = ch.brand_id
           LEFT JOIN users au ON au.id = c.assigned_user_id
          WHERE ${where.join(' AND ')}
          ORDER BY c.last_message_at DESC NULLS LAST
          LIMIT $${params.length}`,
        params
      );

      return res.json({
        data: rows.map((r) => ({
          id: r.id,
          customerName: r.customer_name,
          provider: r.provider,
          state: r.state,
          priority: r.priority,
          assignedUserId: r.assigned_user_id,
          assignedUserName: r.assigned_user_name,
          assignedTeamId: r.assigned_team_id,
          resolvedAt: r.resolved_at,
          createdAt: r.created_at,
          brandId: r.brand_id,
          brandName: r.brand_name,
          channelName: r.channel_name,
          needsHuman: HANDLED_STATES.includes(r.state),
          language: r.language,
          messageCount: Number(r.message_count ?? 0),
          lastText: r.last_text,
          lastMessageAt: r.last_message_at_ts ?? r.last_message_at
        }))
      });
    } catch (err) {
      console.error('api/v1 conversations list failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /* ---------------- notes sub-router (static "notes" segment) --------------- */
  router.use('/:conversationId/notes', createNotesRouter());

  /* ---------------------------------------------------------------- */
  /* DYNAMIC routes                                                    */
  /* ---------------------------------------------------------------- */

  /** GET /conversations/:id — timeline (customer + AI + human), state, assignment. */
  router.get('/:id', requireAbility('conversation.read'), async (req, res, next) => {
    try {
      const { rows: [conv] } = await db.query(
        `SELECT c.id, c.state, c.language, c.created_at, c.priority, c.resolved_at,
                c.assigned_user_id, c.assigned_team_id,
                cu.display_name AS customer_name,
                ch.provider, ch.display_name AS channel_name, ch.brand_id,
                b.name AS brand_name,
                au.name AS assigned_user_name
           FROM conversations c
           LEFT JOIN customers cu ON cu.id = c.customer_id
           LEFT JOIN channels ch ON ch.id = c.channel_id
           LEFT JOIN brands b ON b.id = ch.brand_id
           LEFT JOIN users au ON au.id = c.assigned_user_id
          WHERE c.id = $1 AND c.tenant_id = $2`,
        [req.params.id, req.v1.tenantId]
      );
      if (!conv) return apiError(res, 404, 'NOT_FOUND', 'conversation not found');

      // Messages are tenant-scoped too (defence in depth — conv is already tenant-verified).
      const { rows: messages } = await db.query(
        `SELECT id, direction, sender_type, text, created_at, provider_ts,
                delivery_status, delivery_error, provider_message_id
           FROM messages
          WHERE conversation_id = $1 AND tenant_id = $2
          ORDER BY created_at ASC LIMIT 200`,
        [conv.id, req.v1.tenantId]
      );

      const history = await listAssignmentHistory({ tenantId: req.v1.tenantId, conversationId: conv.id, db });
      const roles = req.v1.roles;
      const canReply =
        can(roles, 'conversation.reply') || can(roles, 'conversation.reply_own');

      return res.json({
        data: {
          conversation: {
            id: conv.id,
            customerName: conv.customer_name,
            provider: conv.provider,
            channelName: conv.channel_name,
            brandId: conv.brand_id,
            brandName: conv.brand_name,
            state: conv.state,
            priority: conv.priority,
            resolvedAt: conv.resolved_at,
            assignedUserId: conv.assigned_user_id,
            assignedUserName: conv.assigned_user_name,
            assignedTeamId: conv.assigned_team_id,
            needsHuman: HANDLED_STATES.includes(conv.state),
            language: conv.language,
            createdAt: conv.created_at
          },
          messages: messages.map((m) => ({
            id: m.id,
            direction: m.direction,
            senderType: m.sender_type,
            text: m.text,
            createdAt: m.created_at ?? m.provider_ts,
            deliveryStatus: m.delivery_status,
            deliveryError: m.delivery_error
          })),
          assignmentHistory: history.map((h) => ({
            id: h.id, action: h.action, userId: h.user_id, teamId: h.team_id,
            reason: h.reason, createdAt: h.created_at,
            actorUserName: h.actor_user_name, assignedByName: h.assigned_by_name
          })),
          permissions: {
            canRequestHandoff: can(roles, 'conversation.handoff'),
            canClaim: can(roles, 'conversation.assign_self'),
            canAssignOthers: isSupervisorOrAdmin(roles),
            canReassign: isSupervisorOrAdmin(roles),
            canUnassign: isSupervisorOrAdmin(roles),
            canResumeAi: isSupervisorOrAdmin(roles),
            canResolve: can(roles, 'conversation.resolve') || can(roles, 'conversation.resolve_own'),
            canReply,
            canReadNotes: can(roles, 'note.read'),
            canCreateNotes: can(roles, 'note.create')
          }
        }
      });
    } catch (err) {
      console.error('api/v1 conversation detail failed:', err.message);
      return apiError(res, 500, 'INTERNAL', 'unexpected error');
    }
  });

  /** POST /conversations/:id/handoff — staff-initiated handoff. */
  router.post('/:id/handoff', requireAbility('conversation.handoff'), async (req, res) => {
    try {
      const { reason, priority, teamId } = validate(req.body, {
        reason: { required: true, type: 'string', min: 2, max: 500 },
        priority: { type: 'string', max: 20 },
        teamId: { type: 'string', max: 60 }
      });
      const result = await requestHandoff(
        {
          tenantId: req.v1.tenantId,
          conversationId: req.params.id,
          reason,
          priority: priority || 'high',
          requestedBy: REQUESTED_BY.STAFF,
          category: HANDOFF_REASONS.STAFF_REQUESTED,
          assignedTeamId: teamId || null
        },
        stage7Deps(req)
      );
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/claim — race-safe self-assign (agents included). */
  router.post('/:id/claim', requireAbility('conversation.assign_self'), async (req, res) => {
    try {
      const { reason, teamId } = req.body ?? {};
      const result = await claimConversation(
        {
          tenantId: req.v1.tenantId,
          conversationId: req.params.id,
          userId: req.v1.user.id,
          teamId: teamId || null,
          reason: reason ? String(reason).slice(0, 200) : 'claimed'
        },
        stage7Deps(req)
      );
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/assign — assign/reassign to another eligible user. */
  router.post('/:id/assign', requireAbility('conversation.assign'), async (req, res) => {
    try {
      const { userId, teamId, reason } = validate(req.body, {
        userId: { required: true, type: 'string', min: 3, max: 60 },
        teamId: { type: 'string', max: 60 },
        reason: { type: 'string', max: 200 }
      });
      const result = await assignConversation(
        {
          tenantId: req.v1.tenantId,
          conversationId: req.params.id,
          userId,
          teamId: teamId || null,
          reason: reason ? String(reason) : null
        },
        stage7Deps(req)
      );
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/unassign — ASSIGNED/HUMAN_ACTIVE → QUEUED. */
  router.post('/:id/unassign', requireAbility('conversation.unassign'), async (req, res) => {
    try {
      const { reason } = req.body ?? {};
      const result = await unassignConversation(
        {
          tenantId: req.v1.tenantId,
          conversationId: req.params.id,
          reason: reason ? String(reason).slice(0, 200) : null
        },
        stage7Deps(req)
      );
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/activate — ASSIGNED → HUMAN_ACTIVE. */
  router.post('/:id/activate', requireAbility('conversation.assign_self'), async (req, res) => {
    try {
      const view = await getConversationHandoffView({ tenantId: req.v1.tenantId, conversationId: req.params.id, db });
      if (!view) return apiError(res, 404, 'NOT_FOUND', 'conversation not found');
      // An agent may only activate a conversation assigned to them.
      if (!isSupervisorOrAdmin(req.v1.roles) && view.assigned_user_id !== req.v1.user.id) {
        return apiError(res, 403, 'FORBIDDEN', 'you can only work on conversations assigned to you');
      }
      const result = await activateHumanHandling(
        { tenantId: req.v1.tenantId, conversationId: req.params.id },
        { db, actorUserId: req.v1.user.id }
      );
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id, action: 'conversation.activate',
        objectType: 'conversation', objectId: req.params.id, ip: req.ip
      });
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/resolve — ASSIGNED/HUMAN_ACTIVE → RESOLVED. */
  router.post('/:id/resolve', async (req, res) => {
    try {
      const view = await getConversationHandoffView({ tenantId: req.v1.tenantId, conversationId: req.params.id, db });
      if (!view) return apiError(res, 404, 'NOT_FOUND', 'conversation not found');
      const isOwner = view.assigned_user_id === req.v1.user.id;
      if (!isSupervisorOrAdmin(req.v1.roles) && !isOwner) {
        return apiError(res, 403, 'FORBIDDEN', 'you can only resolve conversations assigned to you');
      }
      if (!can(req.v1.roles, 'conversation.resolve') && !can(req.v1.roles, 'conversation.resolve_own')) {
        return apiError(res, 403, 'FORBIDDEN', 'insufficient permissions');
      }
      const result = await resolveConversation(
        { tenantId: req.v1.tenantId, conversationId: req.params.id },
        stage7Deps(req)
      );
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/resume-ai — Admin/Supervisor only, reason required. */
  router.post('/:id/resume-ai', requireAbility('conversation.resume_ai'), async (req, res) => {
    try {
      const { reason } = validate(req.body, {
        reason: { required: true, type: 'string', min: 2, max: 500 }
      });
      const result = await resumeAi(
        { tenantId: req.v1.tenantId, conversationId: req.params.id, reason },
        stage7Deps(req)
      );
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/reply — HUMAN reply sent through the provider. */
  router.post('/:id/reply', requireAbility('conversation.reply', 'conversation.reply_own'), async (req, res) => {
    try {
      const { text, idempotencyKey } = validate(req.body, {
        text: { required: true, type: 'string', min: 1, max: 4000 },
        idempotencyKey: { type: 'string', max: 80 }
      });
      const result = await sendHumanReply({
        tenantId: req.v1.tenantId,
        conversationId: req.params.id,
        userId: req.v1.user.id,
        roles: req.v1.roles,
        text,
        idempotencyKey: idempotencyKey || null,
        resolveCredential: cred
      });
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id, action: 'conversation.human_reply',
        objectType: 'conversation', objectId: req.params.id, ip: req.ip,
        metadata: { messageId: result.messageId, deliveryStatus: result.deliveryStatus, duplicate: Boolean(result.duplicate) }
        // NOTE: the reply text is deliberately NOT written to the audit log.
      });
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  /** POST /conversations/:id/messages/:messageId/retry — retry a FAILED human message. */
  router.post('/:id/messages/:messageId/retry', requireAbility('conversation.reply', 'conversation.reply_own'), async (req, res) => {
    try {
      const result = await retryHumanReply({
        tenantId: req.v1.tenantId,
        conversationId: req.params.id,
        userId: req.v1.user.id,
        roles: req.v1.roles,
        messageId: req.params.messageId,
        resolveCredential: cred
      });
      audit({
        tenantId: req.v1.tenantId, actorUserId: req.v1.user.id, action: 'conversation.human_reply_retry',
        objectType: 'conversation', objectId: req.params.id, ip: req.ip,
        metadata: { messageId: req.params.messageId, deliveryStatus: result.deliveryStatus }
      });
      return res.json({ data: result });
    } catch (err) { return fail(res, err); }
  });

  return router;
}
