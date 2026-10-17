-- ============================================================================
-- P0.3-C — durable idempotency record for the one-time handoff acknowledgment.
--
-- WHEN A CUSTOMER ASKS FOR A HUMAN
-- -------------------------------
-- The AI stops and the conversation is queued. The customer is then told, ONCE,
-- that a person will pick this up. That single message is the whole feature.
--
-- WHY A DEDICATED TABLE, NOT A `messages` ROW
-- -------------------------------------------
-- 1. Migration 016 put a UNIQUE index on
--    messages (tenant_id, conversation_id, idempotency_key) WHERE idempotency_key
--    IS NOT NULL. That index is P0.2's reason manual replies cannot double-send.
--    Writing acknowledgments into `messages` would make the two idempotency
--    systems share one namespace, so a manual reply and an acknowledgment would
--    start blocking each other for no good reason.
--
-- 2. `messages` rows carry `sender_type`. The truthful value here is neither
--    'employee' (no human wrote this) nor 'ai' (the AI deliberately did NOT
--    produce this). Inventing a value would make the thread lie about who spoke.
--
-- 3. The acknowledgment is an ASSURANCE with its own lifecycle
--    (sent / failed / unknown / skipped). `messages.delivery_status` is shaped
--    for replies whose retry is driven by `claimFailedOutboundForRetry`. An
--    acknowledgment is NEVER retried, so routing it through that machinery would
--    create a retry path the design explicitly forbids.
--
-- WHY ONE ROW PER CONVERSATION
-- -----------------------------
-- idx_handoff_acknowledgments_conversation is the durable idempotency record.
-- The service INSERTs BEFORE it calls the provider and treats zero affected rows
-- as "already acknowledged, do not send". That makes a duplicate impossible on:
--   - a Meta webhook redelivery,
--   - a Worker retry,
--   - a process restart between the insert and the send,
--   - two events racing on separate connections.
-- The insert is the lock: it is the only thing standing between "decided to
-- acknowledge" and "called the provider", and it is atomic.
--
-- The deliberate cost: a conversation that is resumed and then asks for a human
-- AGAIN gets no second acknowledgment. That is the conservative direction — a
-- duplicate "someone will reply soon" is a visible failure, a missing one is
-- only a small promise kept late. Documented as a limitation, not hidden.
--
-- ONE CONVERSATION, ONE RECIPIENT
-- -------------------------------
-- `external_key` is copied from the conversation rather than joined at send time
-- so the exact address the acknowledgment went to is recoverable from the record
-- itself. It is the same value `messages` already stores for replies.
--
-- NO BACKFILL
-- -----------
-- This table is written ONLY by the live acknowledgment path, at the moment a
-- handoff happens. There is deliberately no migration statement that inserts a
-- row for pre-existing escalations, so deploying this can never send a
-- historical customer a message about a complaint that is already in the past.
-- ============================================================================

CREATE TABLE IF NOT EXISTS handoff_acknowledgments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id)      ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id          uuid REFERENCES channels(id) ON DELETE SET NULL,
  brand_id            uuid REFERENCES brands(id)    ON DELETE SET NULL,

  -- what we tried to do, recorded so the record survives the channel changing
  provider            text NOT NULL,
  external_key        text,
  language            text,

  -- pending | sent | failed | unknown | skipped
  --   pending  the record is claimed, the provider has not answered yet
  --   sent     the provider accepted it
  --   failed   the provider definitively refused; nothing was delivered
  --   unknown  the request may or may not have been delivered. NOT retried.
  --   skipped  we never attempted a send (policy, channel or window)
  status              text NOT NULL,
  skip_reason         text,
  message_text        text,
  idempotency_key     text NOT NULL,

  delivery_status     text,
  delivery_error      text,
  provider_message_id text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);

-- THE idempotency guard. See "WHY ONE ROW PER CONVERSATION" above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_acknowledgments_conversation
  ON handoff_acknowledgments (tenant_id, conversation_id);

-- The key is also unique on its own, so a caller can never address two different
-- conversations with one key and have that mistake look like a success.
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_acknowledgments_idempotency
  ON handoff_acknowledgments (tenant_id, idempotency_key);

-- Staff read the record through the handoff panel, which lists by tenant and
-- orders by most recent.
CREATE INDEX IF NOT EXISTS idx_handoff_acknowledgments_tenant_recent
  ON handoff_acknowledgments (tenant_id, created_at DESC);

-- The acknowledgment is scoped to a brand exactly like the conversation is, so
-- brand-isolation queries can filter on it without a join.
CREATE INDEX IF NOT EXISTS idx_handoff_acknowledgments_brand
  ON handoff_acknowledgments (tenant_id, brand_id);

COMMENT ON TABLE handoff_acknowledgments IS
  'One-time customer acknowledgment sent when a CUSTOMER requests a human. At most one row per conversation; the insert is the idempotency lock that runs BEFORE the provider call. ''unknown'' means the outcome is genuinely undetermined and is never retried. Written only at handoff time - never backfilled.';
COMMENT ON COLUMN handoff_acknowledgments.status IS
  'pending | sent | failed | unknown | skipped. ''unknown'' is not a synonym for ''failed'': it must never be retried, because the customer may already have the message.';
COMMENT ON COLUMN handoff_acknowledgments.skip_reason IS
  'Why no send was attempted: not_customer_requested | channel_unsupported | channel_inactive | window_closed | language_undetermined | conversation_missing.';