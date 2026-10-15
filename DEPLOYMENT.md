# Deployment & Stack Recovery — restaurant-agent

This document describes the reproducible Portainer stack deployment and the
recovery procedure for the current manually-created `restaurant-page-agent`
container.

---

## 1. Architecture (single stack, project name `restaurant-agent`)

| Service (compose)      | Container name        | Ports      | Notes |
|------------------------|-----------------------|------------|-------|
| `restaurant-agent`     | `restaurant-page-agent` | 3000:3000 | API + bot + legacy dashboard + `/api/v1`. Alias `restaurant-agent`. |
| `postgres`             | `restaurant-postgres` | –          | pgvector:pg16, volume `restaurant-agent_pg_data`, alias `postgres`. |
| `redis`                | `restaurant-redis`    | –          | alias `redis`. |
| `cloudflared`          | `restaurant-tunnel`   | –          | quick tunnel → `http://restaurant-agent:3000` (public webhook URL). |
| `web`                  | `lwc-web`             | 3001:3000  | Stage 5 Next.js frontend. Internal only; same-origin proxy to the API. |

Data stays in the **same named volume** (`restaurant-agent_pg_data`), so there is
no database migration, dump, or restore at any point.

## 2. Why stack management was lost (incident summary)

`restaurant-page-agent` had been created with a bare `docker create` during an
emergency env restore. That container lacks the compose bookkeeping labels
(`com.docker.compose.project.config_files` / `working_dir`) that Portainer uses
to manage project members. It **did** keep the original image labels, which is
why it still appears in the right network but is invisible to the stack.
Additionally the stack's working directory (`/data/compose/47`) on the server is
empty, so a Portainer "pull and redeploy" could not rebuild the compose file.

This commit restores a canonical `docker-compose.yml` + Dockerfiles in the
repository so the stack is fully reproducible.

## 3. Secret handling

* No secret values live in Git. `docker-compose.yml` only references variable
  **names**; values are injected from:
  * the server-side `.env` next to the compose file (recommended), and/or
  * Portainer → Stack → Environment variables.
* `.env.example` documents every variable **name** (see repo root).
* `.dockerignore` excludes `.env*` so images cannot contain secrets.

## 4. Env completeness (names expected by the stack)

Application: `WEBHOOK_VERIFY_TOKEN`, `FB_APP_ID`, `FB_APP_SECRET`,
`FB_GRAPH_VERSION`, `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`, `LLM_BASE_URL`,
`LLM_API_KEY`, `LLM_MODEL`, `LLM_FALLBACK_MODELS`,
`MAX_REPLIES_PER_USER_PER_HOUR`, `STAFF_ALERT_WEBHOOK_URL`, `RESEND_API_KEY`,
`STAFF_EMAIL_TO`, `STAFF_EMAIL_FROM`, `DASHBOARD_PASSWORD`, `DATABASE_URL`,
`REDIS_URL`, `ENCRYPTION_KEY`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`,
`DATA_DIR`, `API_CORS_ORIGINS`, `NEXT_PUBLIC_API_URL`, `PORT`, `NODE_ENV`.

Infrastructure: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.

## 5. Safe recovery / redeployment plan (requires approval before execution)

Phase A — **staging check (no production change)**
1. On the server: place the repo's `docker-compose.yml` in a stack dir with the
   existing `.env`, run `docker compose -p restaurant-agent config` to validate.
2. `docker compose -p restaurant-agent build` (builds images only; no container
   changes).

Phase B — **cutover (short, controlled)**
3. `docker compose -p restaurant-agent up -d --no-deps restaurant-agent`
   → replaces only the app container (same name, alias, ports, env, volume).
   Postgres/Redis/Tunnel/`lwc-web` keep running.
4. `docker compose -p restaurant-agent up -d --no-deps web` → replaces the
   frontend container with the stack-managed `lwc-web` (same 3001 mapping).

Phase C — **verify** (see check list below) then continue normal operation:
`docker compose -p restaurant-agent up -d` should report everything up-to-date.

Expected downtime: ~5–10 seconds for the app container restart (Phase B.3).
Meta webhook retries are harmless (idempotent processing + dedupe), and the
public URL does not change because the tunnel and network alias are unchanged.

Rollback: keep the previous image tag (`<image>:previous`) and run
`docker compose -p restaurant-agent up -d --no-deps --force-recreate
restaurant-agent` with the old tag, or simply re-run the manual
`docker create`/`docker network connect` steps that were used for recovery.
The database is never touched by either path.

## 6. Post-deployment verification checklist

* `restaurant-page-agent` healthy, `/health` → 200 (public URL unchanged)
* `/webhook` reachable (403 for a wrong verify token is the expected probe)
* legacy dashboard `/dashboard/login` → 200
* `/api/v1/_health` → 200 with a `csrf_token` cookie
* `lwc-web` → 3001, `/login` renders (RTL for ar, LTR for en), `/api/*` proxies
* routing check: Page `738688299520738` → channel `19002b89-…` → UFC → LWC
* `conversations` / `messages` counts unchanged

## Stage 4 completion — queue/worker

- `src/providers/meta/` — provider boundary: normalizer (raw Meta payload ->
  normalized internal event) + provider (outbound delivery via the existing
  MetaClient, always with a freshly resolved DB credential).
- `src/workers/metaEventPipeline.js` — processes a queued event with the SAME
  core functions as the inline path (scoped AI, grounding, persist-first,
  delivery_status, one plain reply, retry-compatible).
- `src/queues/` — BullMQ queue (`meta-events`) + shared ioredis connection.
  Job payloads carry ids/context only, never credentials.
- `src/services/webhookEvents.js` — provider-level idempotency via the existing
  `webhook_events` UNIQUE (provider, external_id); message-level dedupe stays.
- `worker` service in docker-compose.yml runs
  `node src/workers/metaEventWorker.js` (same image/code, own process).

Processing mode (`WEBHOOK_QUEUE_MODE`):
- `inline` (default) — current behavior, nothing changes.
- `queue` — the worker processes instead of the request path.

Intake and dispatch are two separate phases in both modes, and the order is
part of the contract:
- **Intake** (before the HTTP 200) normalizes the payload and writes one
  `webhook_events` row per event. The `UNIQUE (provider, external_id)` index
  is what suppresses a concurrent Meta redelivery.
- **Dispatch** (after the HTTP 200) enqueues, or processes inline when the
  queue is unavailable. No AI inference and no outbound Meta call happens
  before the ACK, so the webhook response stays fast.

Failure behaviour:
- **Queue (Redis) unavailable** → the durable row is KEPT and the event is
  processed inline. The customer is still answered.
- **Database unavailable** → the request is answered **503**, not 200. 200
  would make Meta stop retrying and lose the event; 503 makes Meta redeliver.
  Nothing is processed without a durable intake record.
- **Worker dies mid-flight** → the row stays `processing` and is never
  auto-reclaimed, because its side effects are unknown. Inspect those rows
  manually; do not bulk-reset them.
- **Stranded `received` row** (API died between intake and dispatch) → the
  worker sweeper re-dispatches it once it has been `received` for more than
  120s (`olderThanSeconds` in `claimStaleWebhookEvents`). It only re-queues;
  it never runs message or comment logic. Attempts are counted in the row’s
  `error` column and capped at 5 (`maxRedispatches`); a row that reaches the
  cap is left `received` for manual intervention.

The sweeper interval is `STALE_SWEEP_INTERVAL_MS` (default 60s, 15s floor),
unref’d so it never holds the process open, and disabled when no database is
configured.

Cutover: set `WEBHOOK_QUEUE_MODE=queue` in the stack env and
`docker compose -p restaurant-agent up -d` (worker already deployed).
Rollback: set it back to `inline`.
## Stage 5 — Knowledge Base drafts/publish (migration 006)

- `migrations/006_knowledge_drafts_versions.sql` (additive): `knowledge_drafts`,
  `knowledge_publications`, and `knowledge_documents.status` (default 'published').
- `src/services/knowledge.js` — published reads, draft CRUD, authoritative
  server-side validation, human-readable diff for preview, atomic publish
  (archive previous + insert new published version + history in one transaction).
- `src/api/v1/knowledge.js` — `/api/v1/knowledge` (GET overview, POST draft,
  PUT draft with optimistic baseVersion conflict, POST validate/preview/publish/
  discard, GET history). Tenant always from the session; publish = Company Admin,
  edit = Company Admin/Supervisor, Agent = read-only.
- `src/services/aiContext.js` now reads only `status='published'` documents,
  newest version first — drafts are never consumed by production AI.
- Frontend: `apps/web/app/(app)/knowledge` workspace (overview, menu, branches,
  FAQs, policies, sources) with sticky action bar, drawer editors, validation
  panel, preview review, publish confirmation, unsaved-change guard.

Apply the migration before deploying:
  docker exec -i restaurant-postgres psql -U "`$POSTGRES_USER" -d "`$POSTGRES_DB" < migrations/006_knowledge_drafts_versions.sql
The migration is additive and keeps every existing document published.