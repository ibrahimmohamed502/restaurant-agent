/**
 * Stage 5 — Unified Inbox API (tenant-scoped).
 *
 * GET  /            list conversations in the caller's brand scope
 * GET  /:id         one conversation + its messages
 * POST /:id/reply   P0.2 — an employee replies to the customer
 *
 * All three derive tenant and brand scope from the AUTHENTICATED SESSION. No
 * identifier that decides access is ever read from the request body or query.
 */
import express from 'express';
import { requireV1Auth } from './index.js';
import { requireAbility } from './stage7-rbac.js';
import { brandScopeFromSession, brandScopeSql, isUuid } from './brandAccess.js';
import {
  sendManualReply,
  evaluateReplyEligibility,
  resolveReplyAuthority,
  REPLY_REASONS,
  REPLYABLE_STATES,
  MAX_REPLY_CHARS,
  messagingWindowSeconds,
  SENDABLE_CHANNEL_PROVIDERS,
  ReplyError,
  ReplyValidationError,
  REPLY_ERRORS
} from '../../services/manualReplies.js';

/** Fixed cap on how much of a thread one request returns. */
const MAX_THREAD_MESSAGES = 200;

export function createConversationsRouter({ pool, auditFn, deps = {} }) {
  const router = express.Router();
  router.use(requireV1Auth);

  /** Load the conversation facts the inbox list needs, scoped as R1 requires. */
  const loadForList = async (scope, tenantId, limit) => {
    const bs = brandScopeSql('ch', { tenantWideParam: 1, brandIdsParam: 2 });
    const { rows } = await pool.query(
      `SELECT c.id, c.state, c.language, c.last_message_at,
              c.assigned_user_id, c.priority, c.resolved_at,
              cu.display_name AS customer_name,
              ch.provider, ch.status AS channel_status,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
              (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at_ts
         FROM conversations c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         LEFT JOIN channels ch ON ch.id = c.channel_id
        WHERE c.tenant_id = $3 AND ${bs.sql}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $4`,
      [...bs.params(scope), tenantId, limit]
    );
    return rows;
  };

  router.get('/', requireAbility('conversation.read'), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    try {
      // R1: the list is filtered by the caller's brand scope inside the same
      // statement that reads it, so a conversation outside the scope is never
      // selected and cannot leak through ordering or pagination.
      const scope = brandScopeFromSession(req.v1);
      const rows = await loadForList(scope, req.v1.tenantId, limit);
      return res.json({ data: rows.map(toListItem) });
    } catch {
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'unexpected error' } });
    }
  });

  router.get('/:id', requireAbility('conversation.read'), async (req, res) => {
    try {
      // R1: detail enforces the same scope. An out-of-scope conversation returns
      // 404, identical to "does not exist", so this is not an existence oracle.
      if (!isUuid(req.params.id)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'conversation not found' } });
      }
      const scope = brandScopeFromSession(req.v1);
      const bs = brandScopeSql('ch', { tenantWideParam: 1, brandIdsParam: 2 });
      const { rows: [conv] } = await pool.query(
        `SELECT c.id, c.state, c.language, c.created_at,
                c.assigned_user_id, c.priority, c.resolved_at,
                cu.display_name AS customer_name,
                ch.provider, ch.display_name AS channel_name,
                ch.status AS channel_status, ch.brand_id,
                (SELECT u.display_name FROM users u WHERE u.id = c.assigned_user_id) AS assigned_user_name,
                (SELECT max(m.created_at) FROM messages m
                  WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS last_inbound_at
           FROM conversations c
           LEFT JOIN customers cu ON cu.id = c.customer_id
           LEFT JOIN channels ch ON ch.id = c.channel_id
           LEFT JOIN users u ON u.id = c.assigned_user_id
          WHERE c.id = $3 AND c.tenant_id = $4 AND ${bs.sql}`,
        [...bs.params(scope), req.params.id, req.v1.tenantId]
      );
      if (!conv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'conversation not found' } });

      const { rows: messages } = await pool.query(
        `SELECT id, direction, sender_type, sender_user_id, text, created_at, provider_ts,
                delivery_status, delivery_error
           FROM messages WHERE conversation_id = $1 AND tenant_id = $2
          ORDER BY created_at ASC LIMIT $3`,
        [conv.id, req.v1.tenantId, MAX_THREAD_MESSAGES]
      );
      const { rows: assignees } = await pool.query(
        `SELECT u.id, u.display_name, u.email
           FROM users u
          WHERE u.tenant_id = $1 AND u.status = 'active'
            AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                         WHERE ur.user_id = u.id AND r.name IN ('Company Admin','Supervisor','Agent'))
          ORDER BY u.display_name NULLS LAST`,
        [req.v1.tenantId]
      );

      const conversation = {
        id: conv.id,
        customerName: conv.customer_name,
        provider: conv.provider,
        channelName: conv.channel_name,
        brandId: conv.brand_id,
        state: conv.state,
        priority: conv.priority,
        resolvedAt: conv.resolved_at,
        assignedUserId: conv.assigned_user_id,
        assignedUserName: conv.assigned_user_name,
        language: conv.language,
        createdAt: conv.created_at
      };

      return res.json({
        data: {
          conversation,
          messages: messages.map(toMessage),
          // Server-authoritative reply permissions. The UI uses these to enable
          // or explain the composer; they never grant anything, because the
          // write path re-decides the same question inside its own statement.
          reply: describeReply(req.v1, conversation),
          assigneeOptions: assignees.map((a) => ({
            id: a.id, name: a.display_name, email: a.email
          }))
        }
      });
    } catch {
      return res.status(500).json({ error: { code: 'INTERNAL', message: 'unexpected error' } });
    }
  });

  /* ------------------------------------------------------- P0.2: reply */

  /**
   * POST /api/v1/conversations/:id/reply
   *
   * Deliberately NOT wrapped in requireAbility('conversation.reply'): the two
   * abilities are different (reply = any conversation in scope, reply_own =
   * only an assigned one) and the assignment record lives in the database, so
   * the whole question is answered in one statement inside the service.
   */
  router.post('/:id/reply', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'conversation not found' } });
      }
      const result = await sendManualReply({
        session: req.v1,
        conversationId: req.params.id,
        body: req.body,
        deps: { pool, auditFn, ip: req.ip ?? null, ...deps }
      });
      return res.status(result.duplicate ? 200 : 201).json({
        data: {
          messageId: result.messageId,
          providerMessageId: result.providerMessageId,
          deliveryStatus: result.deliveryStatus,
          deliveryError: result.deliveryError,
          // True only for a refusal Meta documented as transient. An ambiguous
          // outcome is NEVER reported as retryable — see deliveryOutcome.js.
          retryable: result.retryable === true,
          mechanism: result.mechanism,
          duplicate: result.duplicate
        }
      });
    } catch (err) {
      if (err instanceof ReplyError || err instanceof ReplyValidationError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
        });
      }
      // Anything unexpected is reported without its internals: a stack trace or
      // a driver message can carry connection strings and row contents.
      console.error('manual reply failed:', err?.code ?? err?.name ?? 'error');
      return res.status(500).json({ error: { code: REPLY_ERRORS.INTERNAL, message: 'unexpected error' } });
    }
  });

  return router;
}

/* ------------------------------------------------------------------ mappers */

function toListItem(r) {
  return {
    id: r.id,
    customerName: r.customer_name,
    provider: r.provider,
    state: r.state,
    language: r.language,
    priority: r.priority,
    assignedUserId: r.assigned_user_id,
    resolvedAt: r.resolved_at,
    channelStatus: r.channel_status,
    // AI owns it when the state says so; surfaced so the list can badge a row
    // without the client re-deriving the rule.
    aiActive: r.state === 'AI_ACTIVE',
    messageCount: Number(r.message_count ?? 0),
    lastText: r.last_text,
    lastMessageAt: r.last_message_at_ts ?? r.last_message_at
  };
}

function toMessage(m) {
  return {
    id: m.id,
    direction: m.direction,
    senderType: m.sender_type,
    senderUserId: m.sender_user_id,
    text: m.text,
    createdAt: m.created_at ?? m.provider_ts,
    // Only outbound rows carry a delivery state; inbound is 'sent' by default
    // in the schema, so it is reported as-is.
    deliveryStatus: m.direction === 'outbound' ? (m.delivery_status ?? 'pending') : null,
    deliveryError: m.direction === 'outbound' ? (m.delivery_error ?? null) : null
  };
}

/** The composer's permission block, plus the limits it must enforce. */
function describeReply(session, conversation) {
  const authority = resolveReplyAuthority(session);
  const eligibility = evaluateReplyEligibility({ authority, conversation });
  return {
    canReply: eligibility.allowed,
    reason: eligibility.reason,
    reasonText: REPLY_REASONS[eligibility.reason] ?? REPLY_REASONS.invalid_state,
    canReplyAnyConversation: authority.canReplyAny,
    canReplyOnlyAssigned: authority.canReplyAny ? false : authority.canReplyOwn,
    maxLength: MAX_REPLY_CHARS,
    messagingWindowSeconds: messagingWindowSeconds(),
    sendableProviders: [...SENDABLE_CHANNEL_PROVIDERS],
    replyableStates: [...REPLYABLE_STATES],
    // A conversation the AI still owns needs an explicit handoff, and handoff
    // routes are P0.3 — so the UI must say "not yet", not offer a dead button.
    requiresHandoff: conversation.state === 'AI_ACTIVE'
  };
}