-- ============================================================================
-- Stage 8 Batch 1 — Add default_language to brands
-- ============================================================================
-- The API (companies.js) references default_language for brand CRUD.
-- Migration 010 added status but default_language was missing.
-- This migration adds it with a safe default.
-- ============================================================================

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS default_language text NOT NULL DEFAULT 'ar';

-- Ensure existing brands have a value
UPDATE brands SET default_language = 'ar' WHERE default_language IS NULL;
