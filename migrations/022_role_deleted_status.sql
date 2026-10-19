-- A1 (fix): Distinguish soft-deleted roles from temporarily disabled roles.
--
-- Migration 021 added roles.status with CHECK (status IN ('active', 'disabled')).
-- This migration expands the allowed set to include 'deleted', so a soft-deleted
-- role cannot be re-enabled through the normal enable endpoint.
--
-- Additive only: expands the CHECK constraint, no data loss.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_status_check') THEN
    ALTER TABLE roles DROP CONSTRAINT roles_status_check;
  END IF;
  ALTER TABLE roles
    ADD CONSTRAINT roles_status_check CHECK (status IN ('active', 'disabled', 'deleted'));
END $$;
