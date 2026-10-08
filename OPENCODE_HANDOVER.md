# 🔄 OPENCODE SESSION HANDOVER

> **Read this ENTIRE document before doing anything.**
> Purpose: continue this project from the exact current point WITHOUT repeating previous audits, rediscovering architecture, or guessing previous decisions.
> Anything uncertain is marked **UNKNOWN / NEEDS VERIFICATION**.
> **NEVER include access tokens, passwords, encryption keys, secrets, sensitive env values, or decrypted credentials in this file.**

---

# 1. PROJECT OVERVIEW

## What the system currently does
An **AI customer engagement platform** that auto-replies to Facebook Page comments and Messenger DMs in the commenter's own language (Arabic→Kuwaiti dialect, English, etc.), using a restaurant/business knowledge base, with escalation detection (complaints/collaborations/contact-data) that alerts staff, plus an admin dashboard (Unified Inbox, stats, team management).

## How it evolved
Started as a **single Facebook restaurant bot** (one page, one env token, knowledge.json in repo) → evolved into a **multi-tenant SaaS foundation** (PostgreSQL multi-tenant schema, encrypted per-channel credentials, RBAC auth, unified inbox, DB-driven routing in progress).

## Current technology stack
- **Runtime:** Node.js 18+ (ESM), Express 4
- **DB:** PostgreSQL 16 + pgvector (multi-tenant schema, RLS-ready)
- **Queue:** Redis (deployed, **not yet used** — queue/BullMQ deferred)
- **LLM:** Google Gemini (OpenAI-compatible endpoint) — chain: `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.8-flash` with retry/backoff + localized fallback replies
- **Deploy:** Docker + docker-compose, Portainer (git-pull redeploys)
- **Ingress:** Cloudflare quick-tunnel (temporary; permanent `bot.lifewithcacao.com` planned — **UNKNOWN / NEEDS VERIFICATION** whether domain is configured yet)
- **Meta:** Graph API **v21.0** (from `FB_GRAPH_VERSION` env)
- **Auth (dashboard):** DB sessions + bcryptjs + RBAC (Company Admin / Supervisor / Agent) + brute-force lockout

## Application structure (key files)
- `server.js` — Express entry, mounts webhook + dashboard + users routers, runs DB migrations+seed on boot (guarded)
- `src/webhook.js` — Meta webhook intake (GET verify, POST events), comment/DM processing
- `src/agent.js` — AI engine (system prompt, model chain, JSON parse)
- `src/facebook.js` — `createMetaClient({accessToken})` + backward-compat named exports (env fallback)
- `src/services/channelResolver.js` — `resolveMetaChannel(pageId)` (Stage 4.1)
- `src/services/routeContext.js` — `buildRouteContext(entry)` (Stage 4.3B.1, **local only, NOT wired, NOT committed**)
- `src/services/conversations.js` — findOrCreateChannel/Customer/Conversation, persistMessage, createEscalationRecord
- `src/dashboard.js` — admin dashboard (stats, events, escalations, inbox, team, auth)
- `src/db/pg.js` — pg Pool (legacy JSON mode when DATABASE_URL unset)
- `src/db/migrate.js` — migration runner (migrations/*.sql, tracked in `_migrations`)
- `src/db/crypto.js` — AES-256-GCM encrypt/decrypt (provider credentials)
- `src/db/seed.js` — first-tenant seed (ufc + lwc brand + branches + knowledge + encrypted page token + admin user + roles + teams)
- `src/knowledge.js` — loads `knowledge.json` (currently LWC data, **temporary compatibility — KB isolation NOT complete**)
- `scripts/` — `gh-push.mjs` (GitHub Contents API push), `create-admin.mjs`, `provision-meta-channel.mjs`, `test-channelResolver.mjs`, `test-metaClient.mjs`, `test-routeContext.mjs`

## PostgreSQL usage
Multi-tenant schema (~30 tables) with `tenant_id` on tenant-scoped tables. Tables: tenants, brands, branches, users, roles, user_roles, teams, team_members, channels, provider_credentials, integration_health, webhook_events (unused), customers, customer_identities, conversations, messages, internal_notes, tags, conversation_tags, assignments, ai_agents, ai_configs, knowledge_sources, knowledge_documents, knowledge_chunks (vector), escalations, notifications, audit_logs, automation_rules, sessions, login_attempts, `_migrations`.

## Redis usage
Deployed (`redis:7-alpine`, healthy). **Not yet used** — queue/BullMQ deferred to a later stage.

## Docker/Portainer deployment structure
docker-compose services: `restaurant-page-agent` (build from GitHub main), `restaurant-postgres` (pgvector/pgvector:pg16), `restaurant-redis`, `restaurant-tunnel` (cloudflared quick tunnel). Deploys via Portainer "Pull and redeploy". Cloudflare quick-tunnel is the temporary public ingress — **URL changes on every redeploy** (must re-update Meta webhook callback URL via API each time).

## Current Meta/Facebook integration architecture
- Meta App "Restaurant Bot" (App ID known in repo `.env.example`? — ID is non-sensitive; stored in env). App is **Live** mode.
- Webhook callback points to the current Cloudflare tunnel URL.
- Page routing now (Stage 4.3A) provisioned in PostgreSQL: routing channel `provider='meta'` for the test page with encrypted `page_access_token` in `provider_credentials`.
- **Routing channel (`provider='meta'`) is SEPARATE from conversation channels (`meta_comment`/`meta_dm`)** — these must NOT be merged.

## Current Unified Inbox / dashboard architecture
- Dashboard (`src/dashboard.js`): login (email+password DB sessions), stats cards, activity log, escalations tab (resolve), **Inbox tab** (conversations list + message timeline bubbles), **Team tab** (add/disable users, roles — Company Admin only). RBAC enforced on API.
- Conversations/messages persisted in Postgres (customers, customer_identities, conversations, messages) via `src/services/conversations.js`.
- Escalations persisted in `escalations` table linked to conversations; also legacy JSON event log (`data/dashboard.json`) for stats.

## Current multi-tenant architecture
- Single tenant `ufc` + brand `lwc` seeded (Stage 1). All current data is under that tenant.
- Meta routing is now DB-driven in progress (Stage 4): `channels(provider='meta')` per page + `provider_credentials` (encrypted) + `channelResolver` + `routeContext`.
- Tenant isolation enforced by: routing resolution from DB (not defaults), the `channels_meta_external_uidx` partial unique index, and fail-closed behavior for unknown/inactive pages.

## Evolution summary (single bot → multi-tenant foundation)
1. Single-page Facebook bot (Express + Gemini + knowledge.json).
2. Added Messenger channel, escalations, email alerts, dashboard v1.
3. Moved to VPS/Docker/Portainer.
4. Stage 1: PostgreSQL multi-tenant foundation + pgvector + Redis + seed.
5. Stage 2: Auth (DB sessions, bcrypt, RBAC, team management, brute-force lockout, audit logs).
6. Stage 3: Unified Inbox (conversation persistence + Inbox UI + escalations linked).
7. Stage 4 (in progress): DB-driven Meta routing (channelResolver, routeContext) to support multiple pages/tenants without cross-tenant leakage.

---

# 2. CURRENT PRODUCTION STATE

What is ACTUALLY live now (verified against repository + GitHub):

## Production containers/services (Portainer)
- `restaurant-page-agent` (healthy)
- `restaurant-postgres` (pgvector/pgvector:pg16, healthy)
- `restaurant-redis` (healthy)
- `restaurant-tunnel` (cloudflared quick tunnel, healthy)
- **Verified manually:** containers healthy after the last redeploy.

## Current test/working Meta/Facebook page
- **CV Elite Hub** (test/dev page) is the currently configured live page (production bot replies there).
- **Life With Cacao (LWC)** is temporarily paused/disconnected — will be brought back as part of Stage 4 (later).

## Current routing channel setup
- CV Meta routing channel **already provisioned in PostgreSQL** (`provider='meta'`, `external_id` = the CV page's Meta Page ID, status `active`, correct tenant + brand).
- CV page credential stored encrypted in `provider_credentials` (`page_access_token`, AES-256-GCM). **Verified via `resolveMetaChannel(CV_PAGE_ID, {includeCredential:true})` → credentialAvailable: true, credentialMatchesLegacyEnv: true.**

## Current database state
- Migrations applied in production (recorded in `_migrations`):
  - `001_init.sql` (foundation schema ~30 tables)
  - `002_auth.sql` (sessions + login_attempts)
  - `003_meta_channel_unique.sql` (partial unique index) — **APPLIED in production**
- Migration versions currently in the repo `migrations/`: `001_init.sql`, `002_auth.sql`, `003_meta_channel_unique.sql`.
- Tenant `ufc` + brand `lwc` seeded. Admin user exists (Company Admin). Teams seeded (Marketing, Customer Service, Purchasing, IT, Management). Knowledge chunks seeded from LWC knowledge.json. Branches (9) seeded.
- Conversations/messages being persisted for the current test page (CV) in Postgres.

## Current Meta routing uniqueness index
- Index `channels_meta_external_uidx` **verified in production**: `UNIQUE on external_id WHERE provider='meta'`. Purpose: one `provider='meta'` routing record per Meta Page ID across all tenants (one page = one routing owner at a time). Ownership transfer may happen later via a controlled workflow.

## Important production facts already verified manually
- `resolveMetaChannel` works against real DB (4.3A verification passed).
- Dashboard login works (email + bcrypt password; admin user created via `scripts/create-admin.mjs` in container console).
- Bot replies on the CV page work end-to-end (comment → reply → persisted conversation visible in Inbox).

**DO NOT include actual credential/token values here (none are stored in this document).**

---

# 3. COMPLETED PROJECT STAGES

## Stage 0 — Repository/security audit (COMPLETE)
- Purpose: full audit before SaaS transformation.
- Implemented: full repo/security/audit report (architecture, preserve list, P0–P3 findings, security review, target architecture, DB plan, integration plan, AI plan, UI/UX plan, roadmap).
- Files: report only (no code).
- Status: **COMPLETE.**

## Stage 1 — Foundation (COMPLETE)
- Purpose: PostgreSQL multi-tenant foundation + Redis.
- Implemented: `pgvector/pgvector:pg16` + `redis:7-alpine` in compose; ~30-table multi-tenant schema (`migrations/001_init.sql`); `src/db/pg.js` (pool, legacy mode when no DATABASE_URL), `src/db/migrate.js` (runner), `src/db/crypto.js` (AES-256-GCM), `src/db/seed.js` (first-tenant seed); server boots migrations+seed (guarded, no double-seed).
- Architectural decisions: `pg` (pure JS) over Prisma (Alpine/native-binary reliability); dual-run (bot keeps working from knowledge.json while DB builds alongside).
- Files added: migrations/001_init.sql, src/db/pg.js, src/db/migrate.js, src/db/crypto.js, src/db/seed.js; docker-compose.yml, package.json(+lock), .env.example, server.js (edited).
- Tests: crypto roundtrip PASS; seed verified in production (tenant+branches+teams+roles+chunks+encrypted token+channels created).
- Deployment: **DEPLOYED to production.** Status: **COMPLETE.**

## Stage 2 — Auth + RBAC + Team Management (COMPLETE)
- Purpose: real auth replacing the single shared dashboard password.
- Implemented: `migrations/002_auth.sql` (sessions, login_attempts); `src/auth/passwords.js` (bcryptjs), `src/auth/sessions.js` (DB sessions, cookie, validate/revoke), `src/auth/ratelimit.js` (brute-force lockout 5 fails→15 min), `src/auth/audit.js` (fire-and-forget audit), `src/auth/middleware.js` (requireAuth, requireRole, legacy fallback), `src/routes/users.js` (admin user management API), `src/dashboard.js` (rewritten: email+password login, header user info, Team tab for admins, RBAC on API).
- Roles: Company Admin / Supervisor / Agent.
- Files added/changed: migrations/002_auth.sql, src/auth/*, src/routes/users.js, src/dashboard.js, server.js.
- Tests: login verified end-to-end in production (debug proved `compare: true`); RBAC verified (admin-only Team tab).
- Deployment: **DEPLOYED to production.** Status: **COMPLETE.**

## Stage 3 — Unified Inbox (COMPLETE)
- Purpose: persist conversations/messages in Postgres + Inbox UI.
- Implemented: `src/services/conversations.js` (getDefaultTenantId, findOrCreateChannel with auto-provisioning per page, findOrCreateCustomer, findOrCreateConversation, persistMessage with ON CONFLICT dedupe, createEscalationRecord, escalationCategory); webhook.js persists customer/conversation/messages (inbound+outbound, best-effort) + escalations linked; dashboard Inbox tab (conversations list + message timeline bubbles) + 2 API endpoints.
- Files added/changed: src/services/conversations.js, src/webhook.js, src/dashboard.js.
- Tests: end-to-end verified in production (real comment → reply → persisted conversation visible in Inbox with timeline).
- Notable bug fixed during stage: a `\'` inside a server template literal broke the entire client script (SyntaxError) — fixed by switching to event delegation (data-id + addEventListener).
- Deployment: **DEPLOYED to production.** Status: **COMPLETE.**

## Stage 4 (IN PROGRESS) — Provider Abstraction + Multi-Page Routing

### Stage 4.1 — Channel Resolver (COMPLETE)
- Purpose: resolve Meta Page ID → channel/tenant/brand/credential from DB.
- Implemented: `src/services/channelResolver.js` (`resolveMetaChannel(pageId, {includeCredential, db})` — strict fail-closed: UNKNOWN_META_PAGE / CHANNEL_INACTIVE / CREDENTIAL_MISSING; credential scoped to channel_id+tenant_id; AES-256-GCM decrypt reused; no secret in errors/logs).
- Files added: src/services/channelResolver.js, scripts/test-channelResolver.mjs; STATUS.md updated.
- Tests: 11/11 passing (mocked db): known/unknown page, correct tenant/brand, credential, inactive, missing credential, cross-tenant isolation, no-secret-in-errors, not-wired.
- Commit: created via GitHub Contents API (exact SHA not re-verified here — **NEEDS VERIFICATION**).
- Deployment: files pushed to repo; NOT wired into webhook (CV bot unchanged). Status: **COMPLETE.**

### Stage 4.2 — Meta/Facebook Outbound Provider Preparation (COMPLETE)
- Purpose: prepare facebook.js for page-specific credentials.
- Implemented: `createMetaClient({accessToken})` + backward-compat named exports (env fallback); explicit token preferred; `META_CREDENTIAL_MISSING` when both absent; Authorization header auth (no token in URLs); sanitized errors.
- Files changed: src/facebook.js (rewritten); scripts/test-metaClient.mjs (added); STATUS.md updated.
- Tests: 12/12 passing (mocked fetch): explicit>env, env fallback, missing cred, all operations, no-token-in-errors/URL/logs, backward compat, not-wired.
- Commit: fdd180f (facebook.js), cdedf42 (test), 57c98ab (STATUS.md).
- Deployment: files pushed to repo; NOT wired into webhook (routing unchanged; CV uses legacy env path). Status: **COMPLETE.**

### Stage 4.3A — Provision & Verify CV Meta Routing Channel + uniqueness index (COMPLETE)
- Purpose: provision CV as a `provider='meta'` routing channel + encrypted credential; enforce Meta routing uniqueness.
- Implemented: `scripts/provision-meta-channel.mjs` (idempotent provisioning + verification + tenant isolation + integrity report); `migrations/003_meta_channel_unique.sql` (partial unique index `channels_meta_external_uidx` on external_id WHERE provider='meta').
- DB changes: CV routing channel created (provider='meta', external_id=CV page id, status active, correct tenant+brand); CV credential stored encrypted in provider_credentials (AES-256-GCM). Migration 003 applied in production (recorded in `_migrations`; index verified).
- Verification (real DB, in container console): tenantIdMatches: true, brandIdMatches: true, credentialAvailable: true, credentialMatchesLegacyEnv: true, unknown page → UNKNOWN_META_PAGE, disabled channel → CHANNEL_INACTIVE (rolled back).
- Tests: provisioning idempotent; tenant isolation verified; integrity report (no unique constraint existed before 003; no duplicate active credentials).
- Commit: `1f1e3b41913ad33ce0a0e7ae88c484f0f02be6e9` — "Stage 4.3A: enforce Meta routing channel uniqueness" (VERIFIED on GitHub main).
- Deployment: migration applied in production; webhook.js NOT modified; CV uses legacy env path for the bot. Status: **COMPLETE.**

### Stage 4.3B.1 — routeContext (DONE locally, NOT wired, NOT committed, NOT deployed)
- Purpose: resolve a Meta webhook entry/pageId to a request-scoped routing context.
- Files created (LOCAL ONLY — **uncommitted, unpushed**):
  - `src/services/routeContext.js` — `buildRouteContext(entry)` → extract entry.id → resolveMetaChannel(pageId, {includeCredential:true}) → createMetaClient({accessToken: resolved DB credential}) → return `{pageId, channelId, tenantId, brandId, displayName, metaClient}`.
  - `scripts/test-routeContext.mjs` — 9 unit tests.
- Security: DB credential only; ZERO `FB_PAGE_ACCESS_TOKEN` env fallback in this routed path; fail-closed for missing pageId / unknown page / inactive channel / missing credential / resolver-decryption failure; generic errors sanitized; credential never in errors/logs.
- Tests: **9/9 passing** (mocked resolver + client factory): known page → correct context; entry object uses entry.id; missing pageId → MISSING_PAGE_ID; unknown → UNKNOWN_META_PAGE; inactive → CHANNEL_INACTIVE; missing credential → CREDENTIAL_MISSING; generic failure → sanitized RESOLVE_FAILED; credential not in errors; clientFactory receives resolved DB credential (no env fallback).
- Repository status: **LOCAL ONLY — not committed, not pushed, not deployed, NOT wired into webhook.js.**
- Status: **DONE locally; awaiting approval to proceed to 4.3B.2.**

---

# 4. IMPORTANT ARCHITECTURAL DECISIONS

## A. CHANNEL TYPES
- `provider='meta'` is the Meta **integration/routing channel** (owns the encrypted credential, resolves tenant/brand).
- `meta_comment` and `meta_dm` are **conversation classification channels** (for Inbox grouping).
- These concepts **MUST NOT be merged**.

## B. META ROUTING SOURCE OF TRUTH
- PostgreSQL is the source of truth for Meta Page routing: `channels` + `provider_credentials`.
- **Do NOT introduce `FB_PAGES_JSON`** (or any env-based page list).

## C. META PAGE OWNERSHIP INVARIANT
- A Meta Page ID may have only one `provider='meta'` routing record across all tenants at a time. Ownership transfer may happen later through a controlled workflow.
- DB enforcement: `channels_meta_external_uidx` — UNIQUE on external_id WHERE provider='meta'.

## D. TARGET META WEBHOOK ROUTING FLOW
```
Meta webhook
→ entry.id
→ resolveMetaChannel(entry.id)
→ routing channel → tenantId → brandId
→ encrypted DB credential → decrypt
→ createMetaClient({ accessToken })
→ process event using request-scoped routing context (ctx)
```

## E. CREDENTIAL RULE
- The new routed webhook path MUST use the credential resolved from PostgreSQL.
- **NO `FB_PAGE_ACCESS_TOKEN` environment fallback inside the new routed webhook path.**
- Legacy env variables may physically remain for rollback/backward compatibility OUTSIDE the routed path, but routeContext/webhook routing must not use them.
- Unknown/inactive/unconfigured pages must FAIL CLOSED.

## F. TENANT ROUTING
- Once a Meta webhook entry has successfully resolved its routing context: do NOT use `getDefaultTenantId()` for that routed event. Use `ctx.tenantId`.

## G. SECURITY
- Credentials must never be: logged, returned in errors, exposed to dashboard, included in handover, committed to GitHub.

## H. KNOWLEDGE BASE
- Current `knowledge.json` / LWC knowledge behavior is **TEMPORARY compatibility only**. KB isolation is NOT complete.
- Tenant/brand-specific Knowledge Base scoping will be implemented in Stage 4.4/5.
- Stage 4.3B is ROUTING work only. Do not redesign the Knowledge Base during Stage 4.3B.

---

# 5. DATABASE STATE

## Current migrations (repo `migrations/`)
- `001_init.sql` — foundation schema (~30 tables) — applied
- `002_auth.sql` — sessions + login_attempts — applied
- `003_meta_channel_unique.sql` — partial unique index — applied

## channels_meta_external_uidx
- `UNIQUE on external_id WHERE provider='meta'`. Purpose: one `provider='meta'` routing record per Meta Page ID across all tenants (one page = one routing owner at a time; ownership transfer later via controlled workflow). Defense-in-depth for multi-tenant isolation.

## Current routing channel architecture
- `channels` (id, tenant_id, brand_id, provider, external_id, display_name, status, metadata, created_at). Routing channels use `provider='meta'`; conversation channels use `meta_comment`/`meta_dm` (separate, not merged).
- CV routing channel exists (provider='meta', status active, correct tenant+brand).

## provider_credentials architecture
- `provider_credentials` (id, tenant_id, channel_id, kind, value_encrypted bytea, iv bytea, expires_at, last_rotated_at, created_at).
- Encryption strategy: AES-256-GCM (`src/db/crypto.js`) — value_encrypted = authTag(16B)‖ciphertext; iv = 12B nonce. ENCRYPTION_KEY env (64-hex). Verified from repository.
- Resolver credential selection: `ORDER BY created_at DESC LIMIT 1` (latest-wins) — verified from `src/services/channelResolver.js` code.
- **Why NO unique(channel_id, kind) constraint now:** token rotation needs a temporary overlap (new credential added before old removed). Latest-wins supports rotation naturally. A stricter "one current credential" design (e.g., is_active flag) is a future credential-management decision — not now.
- Future rotation consideration: latest-wins already handles overlap; document that rotation = insert new → rely on latest-wins → optionally clean old later.

## Known issue (deliberately deferred)
- There is an existing `meta_comment` conversation channel for the current test page (CV) where `brand_id` is NULL. This was deliberately NOT fixed during Stage 4.3A. It is NOT the `provider='meta'` routing channel. Brand/conversation alignment is deferred to the appropriate routing/conversation/KB scoping work. Do not modify it during this handover.

---

# 6. STAGE 4.3B.1 — CURRENT IMPLEMENTATION STATE

- Implemented LOCALLY: `src/services/routeContext.js` + `scripts/test-routeContext.mjs`.
- Purpose: `buildRouteContext(entry)` resolves a Meta webhook entry/pageId into a request-scoped routing context `{pageId, channelId, tenantId, brandId, displayName, metaClient}`.
- Flow: extract entry.id/pageId → resolveMetaChannel(pageId, {includeCredential:true}) → decrypted DB credential → createMetaClient({accessToken}) → return context.
- Security: DB credential only; ZERO `FB_PAGE_ACCESS_TOKEN` env fallback in this routed path; missing pageId/unknown/inactive/missing credential/resolver-decryption failure all fail closed; generic resolver/decryption errors sanitized; credential never in errors/logs.
- Tests: **9/9 passing** (mocked resolver + client factory) covering all 8 required scenarios + clientFactory credential receipt.
- Repository status: **LOCAL ONLY — uncommitted, unpushed, not deployed, NOT wired into the live webhook.**
- webhook.js has NOT been modified yet. No deployment performed for Stage 4.3B.1. No database changes for Stage 4.3B.1.
- **Do NOT commit or push these files unless explicitly approved.**

---

# 7. CURRENT STOPPING POINT

- The project is stopped AFTER implementation/testing of **Stage 4.3B.1** and BEFORE **Stage 4.3B.2**.
- Do NOT claim Stage 4.3B is complete. Do NOT claim DB-driven webhook routing is live yet.
- The existing webhook.js is still the previous working implementation (env credential path) until Stage 4.3B.2 is implemented, reviewed, committed, deployed, and verified.

---

# 8. NEXT EXACT STEP

- The NEXT sub-stage is **Stage 4.3B.2**.
- Goal: wire webhook.js to resolve the routing context ONCE per Meta webhook entry and pass that context into `processComment(...)` and `processMessage(...)`.
- Expected architecture:
```
handlePayload(body)
  for each entry:
      buildRouteContext(entry) ONCE
      ↓ ctx
      processComment(value, ctx)
      or
      processMessage(event, ctx)
```
- Do NOT implement Stage 4.3B.2 as part of creating this handover.
- The next session must first: read this handover, inspect repository state, verify Stage 4.3B.1 against actual code, report discrepancies, wait for approval, only then begin Stage 4.3B.2.

---

# 9. REMAINING STAGE 4.3B PLAN

- Resolve entry.id once per webhook entry.
- Pass ctx through comment processing.
- Pass ctx through Messenger processing.
- Replace global PAGE_ID self-skip with ctx.pageId.
- Use ctx.metaClient for outbound Meta operations.
- Remove routed webhook dependency on global FB_PAGE_ACCESS_TOKEN.
- Use ctx.tenantId for persistence.
- Propagate brand context where appropriate.
- Review findOrCreateChannel for optional brandId.
- Preserve distinction between routing channel and conversation channels.
- Implement fail-closed behavior.
- Add/update tests.
- Run CV regression tests.
- Deploy only after explicit approval.
- Verify production routing after deployment.

---

# 10. FAIL-CLOSED REQUIREMENTS

The routed webhook must fail closed for:
- missing entry.id
- unknown Meta Page ID
- inactive routing channel
- missing provider credential
- credential decryption failure
- malformed event
- resolver failure

No unknown page may fall through to: default tenant, CV, LWC, legacy FB_PAGE_ACCESS_TOKEN, another tenant, or another brand.

---

# 11. DO-NOT-DO LIST

- Do NOT change the Meta webhook URL unless explicitly instructed.
- Do NOT add the LWC production Meta page yet.
- Do NOT redesign Knowledge Base yet.
- Do NOT expose secrets.
- Do NOT expose tokens.
- Do NOT manually modify production DB without approval.
- Do NOT deploy automatically.
- Do NOT merge routing channels with conversation channels.
- Do NOT restore env-token fallback in the routed webhook flow.
- Do NOT introduce FB_PAGES_JSON.
- Do NOT use getDefaultTenantId() after successful Meta routing resolution.
- Do NOT start later stages before the current sub-stage is reviewed.
- Do NOT assume Stage 4.3B is live just because routeContext.js exists.

---

# 12. REPOSITORY STATUS

**Verified against GitHub (Contents API) as of this handover:**

- **Current branch:** `main`
- **Latest commit SHA:** `1f1e3b41913ad33ce0a0e7ae88c484f0f02be6e9`
- **Latest commit message:** "Stage 4.3A: enforce Meta routing channel uniqueness"
- **Previous commit:** `df7af6f` — "Add scripts/provision-meta-channel.mjs" (verified)
- **Git metadata:** the local workspace `restaurant-page-agent/` is **NOT a local git working tree** (no `.git`). We push to GitHub via the **GitHub Contents API** using `scripts/gh-push.mjs` (fine-grained PAT with Contents Read+write on this repo only). So "git status/diff" locally is unavailable; status is verified via the GitHub API.
- **Migrations on GitHub main:** `001_init.sql`, `002_auth.sql`, `003_meta_channel_unique.sql`.
- **Uncommitted/unpushed files (LOCAL ONLY):**
  - `src/services/routeContext.js` — exists LOCALLY, NOT on GitHub (verified NOT FOUND on main)
  - `scripts/test-routeContext.mjs` — exists LOCALLY, NOT on GitHub (verified NOT FOUND on main)
  - `OPENCODE_HANDOVER.md` — this file, LOCAL ONLY, NOT pushed
- **Whether routeContext.js is committed/pushed:** NOT committed, NOT pushed (local only).
- **Whether test-routeContext.mjs is committed/pushed:** NOT committed, NOT pushed (local only).
- **Files created/modified during this session (routeContext work):** only the two files above (verified via recent-modified-file check).

---

# 13. IMPORTANT KNOWN COMMITS

**Verified against GitHub (Contents API) before documenting:**

- **Stage 4.3A migration commit:** `1f1e3b41913ad33ce0a0e7ae88c484f0f02be6e9` — message "Stage 4.3A: enforce Meta routing channel uniqueness". **VERIFIED on GitHub main.**
- **Previous known commit before that:** `df7af6f` — "Add scripts/provision-meta-channel.mjs". **VERIFIED on GitHub main.**
- (Older commit before df7af6f: `57c98ab` — "Update STATUS.md", verified.)

---

# 14. VALIDATION COMMANDS

Safe commands the next session can use (NO credential decryption, NO secrets printed):

```bash
# routeContext focused tests (mocked resolver + client factory, no DB, no secrets)
node scripts/test-routeContext.mjs

# channelResolver tests (mocked db)
node scripts/test-channelResolver.mjs

# metaClient tests (mocked fetch)
node scripts/test-metaClient.mjs

# latest commits on GitHub main (read-only)
# (uses GITHUB_TOKEN from .env — local dev only)
node -e "fetch('https://api.github.com/repos/ibrahimmohamed502/restaurant-agent/commits?per_page=3',{headers:{Authorization:'Bearer '+process.env.GITHUB_TOKEN,Accept:'application/vnd.github+json'}}).then(r=>r.json()).then(c=>console.log(c.map(x=>({sha:x.sha.slice(0,7),msg:x.commit.message}))))"

# verify routeContext.js is NOT yet on GitHub (should print NOT FOUND)
node -e "fetch('https://api.github.com/repos/ibrahimmohamed502/restaurant-agent/contents/src/services/routeContext.js?ref=main',{headers:{Authorization:'Bearer '+process.env.GITHUB_TOKEN}}).then(r=>console.log(r.status===404?'NOT FOUND (local only)':'EXISTS'))"

# check whether new files differ from GitHub (recent-modified check, local)
# (PowerShell)
Get-ChildItem . -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-60) } | Select-Object FullName
```

(Do NOT run any command that decrypts or prints credentials, tokens, or secrets.)

---

# 15. PRODUCTION SAFETY NOTES

- Production currently works BEFORE webhook.js Stage 4.3B wiring (the bot runs the previous working env-credential path).
- Stage 4.3B.1 is isolated and NOT deployed (verified: routeContext.js and test-routeContext.mjs are local only, NOT on GitHub).
- Do not redeploy just to test local code.
- Future webhook routing deployment requires explicit approval.
- Database routing/credential configuration must remain the source of truth.

---

# 16. NEXT SESSION START PROMPT

**NEXT SESSION START PROMPT:**

Read OPENCODE_HANDOVER.md completely before doing anything.

Then inspect the current repository and verify the handover against the actual code/repository state.

Do NOT modify anything yet.
Do NOT deploy.
Do NOT change the database.
Do NOT change Meta configuration.

Report only:

1. Current completed stage.
2. Current branch/latest commit.
3. Current uncommitted/unpushed changes.
4. Whether Stage 4.3B.1 files exist and their actual repository status.
5. Whether webhook.js is still unchanged from before Stage 4.3B wiring.
6. Last verified production state.
7. Exact next step.
8. Any mismatch between OPENCODE_HANDOVER.md and the actual repository.

Then STOP and wait for approval before implementing Stage 4.3B.2.
