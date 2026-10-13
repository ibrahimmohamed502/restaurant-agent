-- ============================================================================
-- Stage 8 Batch 1 — Platform Super Admin Foundation
-- ============================================================================
-- Adds Platform Super Admin role with separate platform-level security boundary.
-- Platform Super Admin manages companies; Company Admin manages their own company.
-- No cascade deletes — companies/brands are archived (status='disabled').
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Platform Super Admins (platform-level, not tenant-scoped)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_super_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- ----------------------------------------------------------------------------
-- Tenants: add status for safe disable/archive (no cascade delete)
-- ----------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Ensure existing tenants have a status
UPDATE tenants SET status = 'active' WHERE status IS NULL;

-- ----------------------------------------------------------------------------
-- Brands: add status for safe disable/archive
-- ----------------------------------------------------------------------------
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

UPDATE brands SET status = 'active' WHERE status IS NULL;

-- ----------------------------------------------------------------------------
-- Platform Super Admin role seed (idempotent)
-- ----------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO roles (tenant_id, name, permissions) VALUES
      (t.id, 'Platform Super Admin', '["platform.*"]'::jsonb),
      (t.id, 'Company Admin', '[
        "brand.read","brand.create","brand.update","brand.disable",
        "user.read","user.create","user.update","user.disable",
        "brand.integration.connect","brand.integration.disconnect",
        "brand.integration.reconnect","brand.integration.status",
        "company.read","company.update",
        "conversation.read","conversation.handoff","conversation.assign",
        "conversation.reassign","conversation.unassign","conversation.resolve",
        "conversation.resume_ai","conversation.reply",
        "note.read","note.create","note.delete_any","notification.read",
        "conversation.assign_self","conversation.reply_own","conversation.resolve_own",
        "note.delete_own"
      ]'::jsonb),
      (t.id, 'Supervisor', '[
        "conversation.read","conversation.handoff","conversation.assign",
        "conversation.reassign","conversation.unassign","conversation.resolve",
        "conversation.resume_ai","conversation.reply",
        "note.read","note.create","note.delete_any","notification.read",
        "brand.read","brand.update","brand.integration.connect",
        "brand.integration.disconnect","brand.integration.reconnect",
        "brand.integration.status","user.read","user.update"
      ]'::jsonb),
      (t.id, 'Agent', '[
        "conversation.read","conversation.handoff","conversation.assign_self",
        "conversation.reply_own","conversation.resolve_own",
        "note.read","note.create","note.delete_own","notification.read",
        "brand.read","brand.integration.status"
      ]'::jsonb)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Indexes for new columns
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_brands_status ON brands(status);