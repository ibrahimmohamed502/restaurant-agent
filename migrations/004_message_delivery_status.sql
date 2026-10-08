-- Stage 4.4.6 — Outbound delivery lifecycle for messages.
-- Adds an idempotent-friendly delivery status + sanitized error category to
-- messages so a failed Meta delivery never hides the customer's message.
-- Existing rows stay valid: any pre-4.4.6 message is treated as 'sent'.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  ADD COLUMN IF NOT EXISTS delivery_error text; -- sanitized category only (never tokens/secrets)

-- Fast lookup for staff "what failed to send" views and future retry tooling.
CREATE INDEX IF NOT EXISTS idx_messages_delivery_status ON messages (tenant_id, delivery_status)
  WHERE delivery_status <> 'sent';
