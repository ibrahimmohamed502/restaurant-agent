-- Stage 4.4.7 — Manual delivery retry metadata (additive only).
-- Enables safe, idempotent retries of FAILED outbound messages from the Inbox.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz;

-- Index for "what needs retry" views (failed outbound AI messages only).
CREATE INDEX IF NOT EXISTS idx_messages_retryable
  ON messages (tenant_id, created_at)
  WHERE direction = 'outbound' AND sender_type = 'ai' AND delivery_status = 'failed';
