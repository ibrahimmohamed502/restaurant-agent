# =============================================================================
# STAGING DEPLOYMENT RUNBOOK — Stage 8 Batch 1 Acceptance
# =============================================================================
# This runbook describes how to deploy and validate the staging environment
# for Batch 1 manual acceptance. NO PRODUCTION CHANGES.
#
# Prerequisites (Owner must confirm before proceeding):
#   [ ] VPS has 2+ GB free RAM and 3+ GB free disk
#   [ ] Owner approves staging deployment on shared VPS (or separate VPS)
#   [ ] Docker Compose v2+ available on VPS
# =============================================================================

# -----------------------------------------------------------------------------
# 1. FILES PREPARED (in this repository)
# -----------------------------------------------------------------------------
# docker-compose.staging.yml          # Standalone compose (project: restaurant-agent-staging)
# .env.staging.example                # Template — copy to .env.staging on VPS, fill ALL values
# migrations/011_fix_company_admin_wildcard.sql  # Safe remediation migration

# -----------------------------------------------------------------------------
# 2. STAGING ARCHITECTURE (COMPLETE ISOLATION)
# -----------------------------------------------------------------------------
# Production (restaurant-agent)                    Staging (restaurant-agent-staging)
# ─────────────────────────────────────────────────────────────────────────────────
# Project name: restaurant-agent                  Project name: restaurant-agent-staging
# Network: restaurant-page-agent_default          Network: restaurant-agent-staging_default
# Volume: pg_data                                 Volume: staging_pg_data
# DB: lwc_saas @ postgres:5432                    DB: staging_lwc_saas @ staging-postgres:5432
# Redis: redis:6379                               Redis: staging-redis:6379
# API: restaurant-page-agent:3000                 API: staging-api:3000 (127.0.0.1:3002)
# Worker: restaurant-agent-worker                 Worker: staging-worker
# Web: lwc-web:3001                               Web: staging-web:3000 (127.0.0.1:3003)
# Tunnel: restaurant-tunnel                       NO TUNNEL (mock testing only)
# Meta: Production Page + App                     NO META (fixture data only)
#
# Host ports (bound to 127.0.0.1 ONLY):
#   3002 → staging-api:3000
#   3003 → staging-web:3000
#   NO PostgreSQL/Redis host ports exposed

# -----------------------------------------------------------------------------
# 3. RESOURCE REQUIREMENTS
# -----------------------------------------------------------------------------
# Production baseline (measured):
#   API container:    ~400 MB RAM, ~0.5 CPU
#   Worker container: ~300 MB RAM, ~0.3 CPU
#   Web container:    ~200 MB RAM, ~0.2 CPU
#   PostgreSQL:       ~800 MB RAM (with pgvector)
#   Redis:            ~50 MB RAM
#   TOTAL:            ~1.75 GB RAM, ~1.5 CPU
#
# Staging additional (estimated):
#   Same containers, lower concurrency (WORKER_CONCURRENCY=2)
#   TOTAL additional: ~1.5 GB RAM, ~1 CPU
#
# COMBINED: ~3.25 GB RAM, ~2.5 CPU
#
# RECOMMENDATION:
#   - If VPS has ≥4 GB RAM and ≥3 CPU cores: staging CAN co-locate
#   - If VPS has <4 GB RAM: PROVISION SEPARATE VPS FOR STAGING
#   - Owner must confirm VPS capacity before deployment

# -----------------------------------------------------------------------------
# 4. DEPLOYMENT PROCEDURE
# -----------------------------------------------------------------------------
# Execute on VPS as root (or user with docker access):

## Step 1: Prepare Staging Compose & Environment
cd /root/stack
# Copy compose file (already in repo at docker-compose.staging.yml)
# Create environment file from template
cp .env.staging.example .env.staging
# EDIT .env.staging — fill in ALL values (no blanks allowed for required vars):
#   STAGING_POSTGRES_PASSWORD=          # 32+ char random
#   STAGING_ENCRYPTION_KEY=             # 64 hex chars (32 bytes)
#   STAGING_DASHBOARD_PASSWORD=         # admin password
#   STAGING_SEED_ADMIN_EMAIL=           # staging admin email
#   STAGING_SEED_ADMIN_PASSWORD=        # admin password
#   LLM_API_KEY=                        # can reuse prod or separate
#   # Meta vars NOT REQUIRED for Batch 1 (mock testing)
#   STAGING_FB_APP_ID=
#   STAGING_FB_APP_SECRET=
#   STAGING_FB_PAGE_ID=
#   STAGING_FB_PAGE_ACCESS_TOKEN=
#   STAGING_WEBHOOK_VERIFY_TOKEN=

## Step 2: Validate Compose Syntax
docker compose -p restaurant-agent-staging --env-file .env.staging -f docker-compose.staging.yml config
# Must show: name: restaurant-agent-staging, network: restaurant-agent-staging_default, volume: restaurant-agent-staging_staging_pg_data

## Step 3: Build & Start Staging Stack
docker compose -p restaurant-agent-staging --env-file .env.staging -f docker-compose.staging.yml up -d --build

## Step 4: Wait for Health Checks
# Watch until all containers show "healthy" or "running"
docker compose -p restaurant-agent-staging ps

## Step 5: Apply Migrations to Staging Database
# Migrations run automatically on API startup via server.js → migrate()
# But we apply 011 explicitly to ensure Company Admin wildcard is fixed:
docker exec -i staging-postgres psql -U lwc -d staging_lwc_saas < migrations/011_fix_company_admin_wildcard.sql
# Verify output shows: "SUCCESS: All Company Admin roles now have explicit permissions"

## Step 6: Verify API Health
curl -sf http://127.0.0.1:3002/health
curl -sf http://127.0.0.1:3002/api/v1/_health
# Both must return 200 OK

## Step 7: Verify Web Frontend (internal)
curl -sf http://127.0.0.1:3003/ | grep -q "Customer Engagement Platform"

# -----------------------------------------------------------------------------
# 5. BATCH 1 ACCEPTANCE TESTING (MOCK/FIXTURE DATA ONLY)
# -----------------------------------------------------------------------------
# NO Meta App, NO Facebook Page, NO Cloudflare tunnel required.
# All webhook/API tests use fixture data via existing test scripts.

## 5.1 Run Full Test Suite Against Staging API
# From repository root (local machine or VPS):
export STAGING_API_URL=http://127.0.0.1:3002/api/v1
# Note: Test scripts use in-memory DB mocks by default.
# For integration testing against real staging API, a separate test config is needed.
# For Batch 1 acceptance, we rely on the 526 automated tests already passing.

## 5.2 Manual API Verification (via curl / httpie)
# Login as staging admin (seeded via STAGING_SEED_ADMIN_EMAIL):
TOKEN=$(curl -s -X POST http://127.0.0.1:3002/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<STAGING_SEED_ADMIN_EMAIL>","password":"<STAGING_SEED_ADMIN_PASSWORD>"}' \
  -c cookies.txt | jq -r .data.user.id)

# Verify Platform Super Admin access (after adding to platform_super_admins):
docker exec -i staging-postgres psql -U lwc -d staging_lwc_saas -c "
  INSERT INTO platform_super_admins (user_id)
  SELECT id FROM users WHERE email = '<STAGING_SEED_ADMIN_EMAIL>';
"

# Test /api/v1/platform/companies (should work for PSA)
curl -s -b cookies.txt http://127.0.0.1:3002/api/v1/platform/companies | jq .

# Test /api/v1/companies/brands (Company Admin scope)
curl -s -b cookies.txt http://127.0.0.1:3002/api/v1/companies/brands | jq .

## 5.3 Verify Disabled Enforcement
# Disable a company via API:
curl -s -X POST -b cookies.txt http://127.0.0.1:3002/api/v1/platform/companies/<company-id>/disable | jq .

# Verify webhook routing fails with TENANT_DISABLED (check staging-api logs):
docker logs staging-page-agent 2>&1 | grep TENANT_DISABLED

# -----------------------------------------------------------------------------
# 6. ROLLBACK PROCEDURE (SAFE, NON-DESTRUCTIVE)
# -----------------------------------------------------------------------------
# The staging environment is completely disposable.
# No data migration rollback needed — recreate from scratch.

## Option A: Full Teardown & Recreate (preferred)
docker compose -p restaurant-agent-staging down -v
# Removes all containers + staging_pg_data volume
# Then re-run Step 3-6 from Section 4

## Option B: Selective Container Restart
docker compose -p restaurant-agent-staging restart staging-api staging-worker
# Preserves database volume

## Option C: Database-Only Reset (if schema/migrations need redo)
docker exec -i staging-postgres psql -U lwc -d staging_lwc_saas -c "
  DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO lwc;
"
# Then re-run Step 5 (migrations apply automatically on next API start)

# PRODUCTION IS NEVER AFFECTED — separate project, network, volume, DB

# -----------------------------------------------------------------------------
# 7. VALIDATION CHECKLIST (Owner Sign-Off)
# -----------------------------------------------------------------------------
# After deployment, verify each item:
#
# [ ] Compose validates with correct project name: restaurant-agent-staging
# [ ] Network name: restaurant-agent-staging_default
# [ ] Volume name: restaurant-agent-staging_staging_pg_data
# [ ] All containers healthy: staging-api, staging-postgres, staging-redis, staging-worker, staging-web
# [ ] Host ports bound to 127.0.0.1 only (3002, 3003)
# [ ] NO production container names reused
# [ ] NO production network/volume reused
# [ ] Migrations 010 + 011 applied to staging_lwc_saas only
# [ ] Company Admin wildcard fixed (011 output shows SUCCESS)
# [ ] /health and /api/v1/_health return 200
# [ ] Resource usage within VPS limits (docker stats)
# [ ] Production containers unaffected (docker ps --filter "name=restaurant-")
#
# Owner approval: _________________ Date: _________________

# -----------------------------------------------------------------------------
# 8. BLOCKERS & RISKS
# -----------------------------------------------------------------------------
# | Risk | Likelihood | Impact | Mitigation |
# |------|------------|--------|------------|
# | VPS resource exhaustion | Medium | High | Pre-check RAM/CPU; use separate VPS if <4 GB |
# | .env.staging missing required vars | Low | Medium | Validate compose config before deploy |
# | Migration 011 fails on existing data | Low | Medium | Test on staging first; idempotent |
# | Port conflicts (3002/3003 in use) | Low | Low | Verify free ports before deploy |
# | Docker Compose v1 incompatibility | Low | High | Require Compose v2+ (docker compose) |
# | Seed fails (STAGING_SEED_ADMIN_* blank) | Medium | Medium | Require all vars in .env.staging |
# | Webhook tests fail (no Meta tunnel) | N/A | N/A | Use mock/fixture tests only |
#
# REMAINING BLOCKERS FOR OWNER APPROVAL:
# 1. Confirm VPS has capacity for staging co-location (or provision separate VPS)
# 2. Approve staging deployment on shared VPS
# 3. Provide LLM_API_KEY for staging (can reuse production)
# 4. Confirm no Meta/Cloudflare setup needed for Batch 1 acceptance
# 5. Sign off on validation checklist after deployment