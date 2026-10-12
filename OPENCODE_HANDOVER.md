# 🔄 OPENCODE SESSION HANDOVER

> **Read this ENTIRE document before doing anything.**
> Purpose: continue this project from the exact current point WITHOUT re-auditing, re-discovering
> architecture, or guessing previous decisions.
> **NEVER include access tokens, passwords, encryption keys, secrets, sensitive env values, or
> decrypted credentials in this file or in any command output.**

---

# 1. PROJECT SUMMARY

AI customer-engagement platform for restaurant/business brands: auto-replies to Facebook Page
comments and Messenger DMs in the commenter's own language (Arabic→Kuwaiti dialect, English, etc.)
from brand-scoped knowledge, with escalation detection (complaints/collaborations/reservations/
contact-data) that alerts staff, plus an admin SaaS platform (Unified Inbox, Knowledge Base, Teams).

Evolved from a single Facebook bot → multi-tenant SaaS foundation (PostgreSQL multi-tenant schema,
encrypted per-channel credentials, RBAC auth, unified inbox, DB-driven Meta routing, queue/worker
processing, tenant/brand-scoped AI context, structured Knowledge Base management).

**Stack:** Node 18+ (ESM) / Express 4 · PostgreSQL 16 + pgvector · Redis 7 · BullMQ (queue/worker) ·
Google Gemini via OpenAI-compatible endpoint · Meta Graph API v21.0 · Next.js 14 (App Router) +
React 18 + TypeScript + Tailwind + shadcn/Radix · next-intl (AR/EN, RTL/LTR) · Docker/Compose ·
Cloudflare quick tunnel (temporary ingress).

---

# 2. OFFICIAL ROADMAP (source of truth = Stage 0 audit; do NOT invent a replacement)

- **Stage 0** — Audit: **COMPLETE**
- **Stage 1** — Foundation (PostgreSQL + Redis + tenant/brand seed): **COMPLETE**
- **Stage 2** — Auth / Users / RBAC / Sessions: **COMPLETE**
- **Stage 3** — Unified Inbox / normalized conversation+message persistence: **COMPLETE**
- **Stage 4** — Meta provider abstraction + queue/worker: **COMPLETE**
- **Stage 5** — SaaS Admin Platform: Knowledge Base + Dashboard + Inbox + Login:
  **IMPLEMENTED AND DEPLOYED — WAITING_FOR_MANUAL_VISUAL_ACCEPTANCE**

Remaining roadmap (do NOT start without instruction):

- **Stage 6** — Per-tenant AI config + retrieval / pgvector
- **Stage 7** — Handoff + assignments + notes + notifications
- **Stage 8** — Instagram
- **Stage 9** — WhatsApp
- **Stage 10** — Additional providers
- **Stage 11** — Automations engine
- **Stage 12** — Analytics
- **Stage 13** — SaaS readiness
- **Stage 14** — Hardening / backup / DR / monitoring / load tests

---

# 3. CURRENT STAGE

`STAGE_5_STATUS = WAITING_FOR_MANUAL_VISUAL_ACCEPTANCE`

Stage 6 **MUST NOT** be started. See §8.

---

# 4. COMPLETED ARCHITECTURE

## Backend (Express, unchanged architecture in this handover)
- `server.js` — entry; mounts webhook router, legacy dashboard router (+ `/legacy` mount),
  users router, `/api/v1` router, and the **Stage 5 UI proxy** (`src/uiProxy.js`) that serves the
  Next.js frontend from the same public hostname.
- `src/webhook.js` — Meta webhook intake: signature verify → immediate HTTP 200 ACK →
  `handlePayload` → per entry `buildRouteContext(entry)` **once** → `processComment` /
  `processMessage` with request-scoped `ctx { pageId, channelId, tenantId, brandId, metaClient }`.
  - Routed inbound persisted BEFORE AI (Stage 4.4.6), outbound `delivery_status`
    (`pending|sent|failed`) + retry metadata + manual retry endpoint.
  - Scoped AI via `analyzeAndDraft({ ..., ctx })` (Stage 4.4.3) + deterministic grounding guard.
- `src/services/` — `channelResolver.js` (Page→channel/tenant/brand/credential, fail-closed),
  `routeContext.js` (`buildRouteContext`), `aiContext.js` (tenant/brand-scoped AI context;
  PUBLISHED knowledge only, newest version), `knowledge.js` (draft/validate/preview/atomic publish
  + version history), `grounding.js` (URL/phone/price grounding), `webhookEvents.js`
  (provider-level idempotency), `conversations.js` (persistence + delivery status + retry).
- `src/providers/meta/` — normalizer + provider boundary (`sendMetaReply`).
- `src/queues/`, `src/workers/` — BullMQ `meta-events` queue + worker (bounded retries, backoff).
- `src/api/v1/` — versioned API: `index.js` (auth/CSRF/tenant-context/RBAC foundation),
  `knowledge.js`, `dashboard.js` (real KPI summary), `conversations.js` (real Unified Inbox data).
- `src/auth/` — DB sessions (httpOnly cookie), bcrypt, RBAC, rate-limited login.
- `src/db/` — `pg.js` (pool), `migrate.js` (runner), `crypto.js` (AES-256-GCM), `seed.js`.
- `migrations/` — `001_init.sql`, `002_auth.sql`, `003_meta_channel_unique.sql`,
  `004_message_delivery_status.sql`, `005_message_retry_metadata.sql`,
  `006_knowledge_drafts_versions.sql` — **all applied in production**.

## Frontend (`apps/web/`, Next.js App Router)
- Shell: `components/shell/` — sidebar (grouped nav, collapse, mobile drawer), topbar
  (Company/Brand context chips, language, theme, user menu), `app-shell.tsx` / `session-gate.tsx`.
- Dashboard: `components/dashboard/view.tsx` — executive header, 4 real KPI cards,
  Recent Conversations, Platform Status, Knowledge status, Quick Actions, AI agent panel.
- Inbox: `app/(app)/inbox/page.tsx` + `components/inbox/view.tsx` — real tenant-scoped data via
  `/api/v1/conversations`, list + detail message timeline, loading/empty/error states.
- Knowledge: `app/(app)/knowledge/page.tsx` + `components/kb/*` — Overview / Menu /
  Branches / FAQs / Policies / Sources&Versions; draft → save → validate → preview → publish.
- Login: `app/login/page.tsx` — split premium layout with local inline-SVG cacao hero,
  language + theme toggles, validation/error/loading states.
- i18n: `messages/en.json`, `messages/ar.json` (namespaces: common, nav, navGroups, auth, states,
  shell, placeholder, inbox, dashboard) — EN/AR key parity enforced by tests.
- API client `lib/api.ts` (same-origin, CSRF double-submit), `lib/navigation.ts`.

---

# 5. PRODUCTION DEPLOYMENT

**Browser → public Cloudflare hostname → Express app (public entry)**
**→ Next.js web for SaaS UI routes (proxied) → Express API for `/api/*` → Express webhook for `/webhook`**

- Compose project: `restaurant-agent` (stack dir `/root/stack` on the VPS).
- Services (containers): `restaurant-page-agent` (Express, port 3000), `lwc-web` (Next.js, host port
  3001), `restaurant-agent-worker` (BullMQ worker), `restaurant-postgres`, `restaurant-redis`,
  `restaurant-tunnel` (cloudflared quick tunnel).
- Routing mechanism: public tunnel → `restaurant-page-agent:3000`; Express `uiProxy` forwards
  browser UI routes (`/`, `/login`, `/dashboard`, `/knowledge`, `/inbox`, `/_next/*`, …) to
  `http://lwc-web:3000` (`WEB_UPSTREAM`); `/api/*` and `/webhook` stay on Express
  (same-origin → cookies/CSRF keep working).
- Processing mode: `WEBHOOK_QUEUE_MODE=queue` (inline fallback if Redis is unreachable).
- Health endpoints: `/health` (Express), `/api/v1/_health` (API). `/webhook` returns 403 for an
  invalid verify token (expected proof of reachability).
- **Public URL is a temporary quick-tunnel hostname — it changes if the tunnel is recreated.
  Do not recreate the tunnel.** The Meta webhook callback points at this hostname.

---

# 6. IMPORTANT IDs / NON-SECRET REFERENCES

- Meta Page (CV Elite Hub test page): `738688299520738`
- Meta routing channel (provider='meta'): `19002b89-9884-42fa-8388-41cebb48af86`
- Tenant: `82d867f0-8a52-42ab-a055-9267bdacd7f4` (slug `ufc`)
- Brand: `50b669d9-008b-414b-b643-a01cddde0d01` (slug `lwc`)
- Company Admin login identifier: `ibrahimmohamedahmed502@gmail.com` (password NOT stored anywhere
  readable; reset only via `scripts/create-admin.mjs` with explicit approval)

---

# 7. STAGE 5 IMPLEMENTATION

- Structured Knowledge Base management (Overview / Menu / Branches / FAQs / Policies / Sources).
- Draft → validate → preview → publish, atomic publish with version history
  (`knowledge_drafts`, `knowledge_publications`, `knowledge_documents.status='published'`).
- Tenant + brand scoping everywhere; RBAC (Company Admin publishes, Supervisor edits, Agent
  read-only; enforced API-side).
- Real dashboard KPIs and real Unified Inbox from persisted data. Premium shell/login/theme,
  EN/AR + RTL/LTR, light/dark.

---

# 8. CURRENT UI STATE

`STAGE_5_STATUS = WAITING_FOR_MANUAL_VISUAL_ACCEPTANCE`

The user will inspect: Login, Dashboard, Unified Inbox, Knowledge Base, sidebar/hamburger,
English/Arabic, RTL/LTR, light/dark, desktop responsiveness. The next session must NOT assume the
design is final and must NOT redesign proactively — only make focused corrections if requested.

---

# 9. SECURITY / SAFETY RULES

- Never print secrets: no access tokens, PATs, API keys, DB passwords, encryption keys, decrypted
  provider credentials, session cookies.
- Never fabricate credentials; never log them; never put them in argv, files, or commits.
- Do not modify Meta configuration unless explicitly requested; never change the webhook callback
  casually.
- Do not recreate PostgreSQL/Redis unnecessarily; never restart the Cloudflare tunnel casually.
- Do not modify active LWC knowledge casually (draft/publish workflow only).
- Preserve tenant isolation, queue/worker behavior, same-origin auth/session/CSRF.
- Use official APIs only. Do not manufacture production Facebook events.
- Do not start later roadmap stages without instruction.
- Commits/pushes go through the GitHub Contents API workflow (no local git working tree).

---

# 10. KNOWN CONSTRAINTS

- No local `git` working tree — GitHub is the source of truth (Contents API pushes).
- Production stack dir `/root/stack` holds compose + `.env` (secrets live only there / in Portainer).
- Quick-tunnel hostname changes on recreation; a permanent domain (`app.<domain>`) is planned but
  NOT configured.
- No compose CLI locally — deployments run via the stack dir with Docker API access.
- Seed/test data is single-tenant (UFC/LWC) plus the CV test page.

---

# 11. LATEST COMMITS (verified)

- `a510e4ef3af8c612609591031bf64cc9ec070216` — "Stage 5: premium login artwork, real Unified
  Inbox data, full EN/AR localization" (current HEAD / origin/main)
- `3e10147257a3bc5128f7f247207b9f98abda2ce9` — "Stage 5: premium executive dashboard with real
  tenant-scoped operational data"
- `373d62a97a91b9196169fa738a1fbe0ae263ab93` — "Stage 5: premium SaaS UI polish for shell,
  dashboard foundation and Knowledge Base workspace"
- `add8bd87ee4bd1c51c7038a3236e31a7edff8ab1` — "Stage 5: route public SaaS UI through Next.js"
- `81468ad1df2ed30fb8883959c324547f0772b206` — "Stage 5: add structured Knowledge Base management"
- `60fa…/54c3…/2c76…` — Stage 4 completion (queue/worker), Stage 4.4.6/4.4.7 reliability work.

---

# 12. IMMEDIATE NEXT ACTION

Wait for the user's manual visual review of the deployed Stage 5 UI. If UI corrections are requested,
make only focused corrections. Do not start Stage 6 until Stage 5 receives final user acceptance.
