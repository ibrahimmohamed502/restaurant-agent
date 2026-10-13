-- ============================================================================
-- Stage 8 Batch 1 — Fix Company Admin Wildcard Permissions
-- ============================================================================
-- Migration 010 seeded roles with explicit permissions for NEW tenants.
-- However, tenants seeded BEFORE 010 (via seed.js) received Company Admin
-- with permissions = ['*'] which grants platform.* via wildcard match.
-- This migration replaces ['*'] with the explicit permission set for
-- Company Admin, matching the intended RBAC in stage7-rbac.js.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Identify affected roles (Company Admin with wildcard '*')
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  affected_count int;
BEGIN
  SELECT count(*) INTO affected_count
  FROM roles
  WHERE name = 'Company Admin'
    AND permissions @> '["*"]'::jsonb;

  RAISE NOTICE 'Found % Company Admin role(s) with wildcard permissions', affected_count;

  IF affected_count = 0 THEN
    RAISE NOTICE 'No remediation needed — all Company Admin roles already have explicit permissions';
    RETURN;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Replace wildcard with explicit Company Admin permissions
-- ----------------------------------------------------------------------------
UPDATE roles
SET permissions = '[
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
]'::jsonb
WHERE name = 'Company Admin'
  AND permissions @> '["*"]'::jsonb;

-- ----------------------------------------------------------------------------
-- 3. Verification — should return 0 rows
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  remaining_count int;
BEGIN
  SELECT count(*) INTO remaining_count
  FROM roles
  WHERE name = 'Company Admin'
    AND permissions @> '["*"]'::jsonb;

  IF remaining_count = 0 THEN
    RAISE NOTICE 'SUCCESS: All Company Admin roles now have explicit permissions (no wildcards)';
  ELSE
    RAISE WARNING 'ATTENTION: % Company Admin role(s) still have wildcard permissions', remaining_count;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. Optional: Show final state for audit
-- ----------------------------------------------------------------------------
-- SELECT tenant_id, name, permissions FROM roles WHERE name = 'Company Admin' ORDER BY tenant_id;