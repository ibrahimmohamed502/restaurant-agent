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

### Outbound delivery states

Every AI reply is recorded in `messages` and moves through an explicit
lifecycle. The important rule: **a delivery whose outcome was never
established is never retried.**

| `delivery_status` | `delivery_error` | Meaning | Retry offered? |
| --- | --- | --- | --- |
| `sent` | — | Meta returned success | no |
| `failed` | `meta_rate_limit` | Verified Graph error with a **documented throttling code** (4 / 17 / 32 / 613) | **yes** |
| `failed` | `meta_auth_expired` / `meta_permission` | Verified Graph auth or permission refusal; needs a credential fix | no |
| `failed` | `meta_api_error` | Any other 4xx — refusal confirmed, cause not vouched for | no |
| `pending` | `delivery_unknown` | timeout, reset socket, 5xx, malformed error, a bare HTTP 429, or a bookkeeping write that failed after a confirmed send — **the customer may already have the reply** | **never** |

The allow-list lives in the SQL of `claimFailedOutboundForRetry`, so the rule is
enforced by the database, not by the UI. The dashboard shows a Retry button only
for `meta_rate_limit` and explains every refusal it makes. This is deliberate:
the Graph API has no idempotency key, so re-sending after an unknown outcome is
the only way to guarantee a duplicate reply.

**A retry requires all three of:** a verified Graph error response (the error
object produced by the Meta client), a 4xx HTTP status, and an explicitly
allow-listed throttling code. Anything else fails closed:

- A **bare HTTP 429** with no throttling code is NOT retried. Meta refused the
  request, but we cannot prove it is the documented throttling path.
- **Message text is never evidence.** An error whose text contains "rate limit"
  or "too many requests" cannot make it retryable; provider text is not a
  contract.
- A recognised auth/permission **code wins over the HTTP status**, so a
  contradictory pair such as (429, 190) is never re-read as throttling.
- Malformed, contradictory and transport errors are `delivery_unknown`.

Fail-closed rule: if the inbound customer message cannot be persisted, no reply
is generated or sent at all — otherwise the event would have no idempotency
record and no duplicate detection.

Events that will not be retried automatically (they are silent by design, and
reported by the worker on every sweep):

- `processing` — a worker died mid-flight; its side effects are unknown.
- `unknown` — a send was attempted and the event then failed.
- `received` with `error` like `REDISPATCHED:%` — a stranded row hit the
  re-dispatch cap.

```sql
SELECT status, error, count(*) FROM webhook_events
WHERE status IN ('processing', 'unknown')
   OR (status = 'received' AND error LIKE 'REDISPATCHED:%')
GROUP BY 1, 2;
```

### Worker alert — unresolved outbound (cross-tenant)

The worker is a single process for the whole platform. It has no request context
and so cannot supply a tenant id, and it must never invent one.
`summarizeUnresolvedOutbound` therefore returns an explicit
`unavailable / TENANT_REQUIRED` for a missing tenant rather than an all-zero
result, so a missing context can never be read as "nothing is wrong". It used to
return zeros, which is why the worker alert silently never fired.

`reportUnresolvedOutbound()` uses `summarizeUnresolvedOutboundAllTenants()`, a
counter-only aggregate:

- it returns **numbers only** — no tenant id, no customer id, no message text, no
  credential, and no per-tenant breakdown, so a log line identifies nobody;
- `tenants_affected` is **how many** distinct tenants are affected, not which;
- rows younger than five minutes are excluded — a message that went `pending`
  seconds ago is legitimately in flight, not unresolved;
- it never mutates anything and never triggers a retry;
- if the report itself fails, the worker logs a sanitized `REPORT_UNAVAILABLE`
  line and explicitly does **not** claim a clean state.

The per-tenant, brand-scoped drill-down stays behind the authorization check on
`GET /dashboard/api/reconciliation`. That endpoint is unchanged and never uses
the cross-tenant aggregate.

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