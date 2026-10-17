-- ============================================================================
-- P0.2 — Manual Replies (employee replies from the Social Agent inbox)
--
-- WHY THIS EXISTS
-- ---------------
-- The Meta Graph API send endpoints carry NO idempotency key. The message id
-- only exists AFTER a successful send, so it cannot be used to prevent a second
-- send: by the time we know it, the customer already has the first copy.
--
-- That leaves one guard: a key the CLIENT chooses, checked by the DATABASE
-- before the provider is ever called. A double-clicked Send button, a retried
-- HTTP request, an impatient employee — all of them carry the same key and the
-- second INSERT loses. The customer receives one message.
--
-- SCOPE
-- -----
-- Adds exactly one nullable column and two indexes. No table is dropped or
-- renamed, no existing row is rewritten, and no constraint on existing data is
-- tightened. Every pre-existing row (all 55 outbound AI messages in
-- production today) has idempotency_key IS NULL and therefore does not
-- participate in the new unique index at all.
--
-- The index is PARTIAL precisely so this is true: rows without a key never
-- conflict with each other, so adding the index cannot fail on a table that
-- already holds thousands of AI-generated messages.
--
-- ROLLBACK
-- --------
-- Fully reversible and non-destructive:
--
--     DROP INDEX IF EXISTS idx_messages_reply_idempotency;
--     DROP INDEX IF EXISTS idx_messages_conversation_employee;
--     ALTER TABLE messages DROP COLUMN IF EXISTS idempotency_key;
--
-- Employee reply rows written while this migration was live keep their content
-- (text, sender_user_id, delivery_status) — only the key and its unique
-- guarantee are removed. No customer data is lost by rolling back.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The client-supplied idempotency key.
--
--    Length is bounded so a hostile client cannot use this column as unbounded
--    storage. 200 characters comfortably covers a UUID, a ULID, or any
--    "<conversation>:<timestamp>:<counter>" scheme a client composes.
-- ---------------------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS idempotency_key text
    CONSTRAINT messages_idempotency_key_length CHECK (
      idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200
    );

-- ---------------------------------------------------------------------------
-- 2. The duplicate-send guard.
--
--    UNIQUE per (tenant, conversation) — so the same key in two different
--    conversations is two genuinely different messages and must both succeed,
--    and so a key can never be probed across companies.
--
--    tenant_id is part of the key (not derived) so the constraint is provably
--    tenant-scoped even if a caller ever got a conversation id from elsewhere.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_reply_idempotency
  ON messages (tenant_id, conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Fast "which employee sent this, newest first" for the inbox thread.
--    Partial: only employee rows, which are a small subset of `messages`.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_conversation_employee
  ON messages (conversation_id, created_at DESC)
  WHERE sender_type = 'employee';

-- ---------------------------------------------------------------------------
-- 4. Actor/company matching is deliberately NOT a foreign key here.
--
--    `messages.sender_user_id` already references `users(id) ON DELETE SET
--    NULL` (001_init.sql), so the actor is always a real user.
--
--    A composite FK on (sender_user_id, tenant_id) would look stronger, but
--    Postgres' `ON DELETE SET NULL` with no column list nulls BOTH columns,
--    which would violate `tenant_id NOT NULL` the moment an employee who had
--    ever replied is deleted — turning a supported "remove team member" action
--    into a hard failure. `ON DELETE SET NULL (sender_user_id)` would avoid it
--    but pins the deployment to PG 15+.
--
--    The invariant is enforced where it can actually be trusted: the atomic
--    claim in src/services/manualReplies.js inserts sender_user_id from the
--    AUTHENTICATED SESSION and selects the conversation under the SAME tenant
--    predicate, in one statement. The two ids cannot come from different
--    companies because neither comes from the client at all.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN messages.idempotency_key IS
  'Client-supplied per-request key that makes an employee reply safe to retry. '
  'NULL for inbound and AI-generated messages, which never participate in the '
  'duplicate-send guard.';