-- ============================================================================
-- Stage 7 — Handoff + Assignments + Internal Notes + Notifications + Human Reply
--
-- ADDITIVE ONLY. No table is dropped or renamed, no historical row is rewritten.
-- Every change below is idempotent so the migration is safe to re-run manually.
--
-- Reuses the existing Stage 1 schema:
--   conversations.state / assigned_user_id / assigned_team_id / priority / resolved_at
--   assignments            (append-only assignment history)
--   escalations            (handoff / attention trigger record)
--   internal_notes         (staff-only notes)
--   notifications          (in-app notifications)
--   teams / team_members   (eligible assignees)
--   audit_logs             (auditability)
--   messages               (human outbound uses sender_type = 'employee')
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Actor for a handoff / escalation trigger.
--    'customer' (customer asked for a human) | 'staff' (authorized staff action)
--    | 'ai' (legacy escalation rows created by the webhook before Stage 7).
-- ---------------------------------------------------------------------------
ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS requested_by text NOT NULL DEFAULT 'ai';

-- ---------------------------------------------------------------------------
-- 2) Assignment history action: assigned | reassigned | unassigned | resumed |
--    resolved. `assignments` stays APPEND-ONLY — history is never rewritten.
-- ---------------------------------------------------------------------------
ALTER TABLE assignments
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'assigned';

ALTER TABLE assignments
  DROP CONSTRAINT IF EXISTS assignments_action_check;
ALTER TABLE assignments
  ADD CONSTRAINT assignments_action_check
  CHECK (action IN ('assigned', 'reassigned', 'unassigned', 'resumed', 'resolved'));

-- ---------------------------------------------------------------------------
-- 3) RBAC role gap fix.
--    The Team & Access UI already offered Supervisor/Agent, but seed.js only
--    created 'Company Admin' — so assigning those roles silently no-opped
--    (src/routes/users.js inserts by name with ON CONFLICT DO NOTHING).
--    Registered here idempotently for EVERY existing tenant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO roles (tenant_id, name, permissions) VALUES
      (t.id, 'Company Admin', '["*"]'::jsonb),
      (t.id, 'Supervisor', '[
        "conversation.read","conversation.handoff","conversation.assign",
        "conversation.reassign","conversation.unassign","conversation.resolve",
        "conversation.resume_ai","conversation.reply",
        "note.read","note.create","note.delete_any","notification.read"
      ]'::jsonb),
      (t.id, 'Agent', '[
        "conversation.read","conversation.handoff","conversation.assign_self",
        "conversation.resolve_own","conversation.reply_own",
        "note.read","note.create","note.delete_own","notification.read"
      ]'::jsonb)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Indexes for the new Stage 7 access patterns.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_internal_notes_conversation
  ON internal_notes (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assignments_conversation
  ON assignments (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assignments_tenant_user
  ON assignments (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user
  ON notifications (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_escalations_conversation
  ON escalations (conversation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5) Conversation lifecycle constraint.
--    conversations.state is the AUTHORITATIVE Stage 7 lifecycle.
--    NOT VALID: existing rows are not scanned at ALTER time (production rows
--    are all 'AI_ACTIVE' — verified — and no code path writes any other value).
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_state_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_state_check
  CHECK (state IN (
    'AI_ACTIVE',
    'HUMAN_REQUIRED',
    'QUEUED',
    'ASSIGNED',
    'HUMAN_ACTIVE',
    'RESOLVED'
  )) NOT VALID;

-- ---------------------------------------------------------------------------
-- 6) Human outbound messages reuse the existing messages model.
--    sender_type already supports 'employee' (001_init.sql) — NO new column.
--    The delivery/retry columns come from 004/005 and are reused as-is.
--    The sender check below is a defensive guard, added NOT VALID so historical
--    rows (which only ever carry 'customer' | 'ai') are not re-scanned.
-- ---------------------------------------------------------------------------
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_sender_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_sender_type_check
  CHECK (sender_type IN ('customer', 'ai', 'employee', 'system')) NOT VALID;
