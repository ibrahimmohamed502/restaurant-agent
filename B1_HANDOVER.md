# B1 — Facebook Page Self-Service OAuth · Handover

**Branch:** `b1-facebook-oauth`
**Base:** `05d0c0c` (A1, owner-accepted)
**Head at time of writing:** `b8a6ed0`
**CI run:** `39200973618`
**Status:** code complete, CI green, **NOT deployed, NOT merged, NOT verified against real Meta**

Everything below is development-only. Nothing was deployed, no migration was
executed on production, no Meta setting was changed, no Traefik/DNS/Cloudflare
change was made, and nothing was merged to `main`.

---

## 0. Status legend used throughout

| Label | Meaning |
|---|---|
| **Implemented** | Code exists on the branch. |
| **Mock-tested** | Proven by automated tests against a deterministic Meta mock and a real PostgreSQL. |
| **Real Meta verified** | Proven against Meta's live API. **Nothing in B1 carries this label.** |
| **Blocked** | Cannot be completed until an external dependency resolves. |
| **Not tested** | No coverage exists. Stated plainly rather than implied safe. |

---

## 1. Branch and commits

| Commit | Content |
|---|---|
| `3ce70f6` | B1 backend: migration 023, OAuth state service, Meta adapter, connection service, routes, suite |
| `e5c1fc8` | Transport indirection fix; callback redirects into the app instead of rendering JSON |
| `d873216` | Connect page, AR/EN RTL UI, sidebar entry, CI pgvector fix |
| `072f9c8` | Fixture ids; concurrent-connect conflict mapping; deterministic scope assertions |
| `1cc684c` | Callback binding check fix; the silently-passing PostgreSQL suite (§7) |
| `2d05b04` | A1 suite: pool instead of a connected Client |
| `664337a` | Split A1 and B1 PostgreSQL suites into independent CI jobs |
| `783b9c6` | **Product fix:** page token was dropped before storage — no connect could ever succeed |
| `eb43e21` | **Security fix:** page token was leaking out of `GET /pages` |
| `b8a6ed0` | Test correction (once-only stash guard) |

Four of these are defects the suite caught in code I had written earlier in the
same branch. Two of them (§4) were functional or security bugs, not test gaps.

---

## 2. Changed files

**New**
- `migrations/023_facebook_oauth.sql`
- `src/services/oauthState.js`
- `src/services/facebookConnections.js`
- `src/providers/meta/oauth.js`
- `src/api/v1/metaOAuth.js`
- `scripts/test-meta-oauth-pg.mjs`
- `apps/web/app/(app)/integrations/facebook/page.tsx`
- `apps/web/tests/facebook-connect.test.tsx`

**Modified**
- `src/api/v1/index.js` — mounts the B1 router
- `apps/web/lib/api.ts` — `facebookApi` client + types
- `apps/web/lib/navigation.ts` — sidebar entry
- `apps/web/components/shell/sidebar.tsx` — icon
- `apps/web/messages/en.json`, `ar.json` — 46 new keys each
- `apps/web/tests/integrations-page.test.tsx`, `sidebar.test.tsx`, `navigation.test.tsx`
- `.github/workflows/a1-tests.yml` — pgvector, branch triggers, split jobs
- `scripts/test-roles-pg.mjs` — §7

**Not touched:** `GROUP-C-PATCH/`, any other stack, `src/facebook.js`,
`src/services/roles.js`, `src/auth/abilities.js`, `src/api/v1/brandAccess.js`,
`src/api/v1/stage7-rbac.js`.

---

## 3. Implemented functionality

| Capability | State |
|---|---|
| OAuth initiation with single-use expiring state | Implemented · Mock-tested |
| State bound to user + tenant + brand + redirect URI | Implemented · Mock-tested |
| CSRF protection on every mutation | Implemented · Mock-tested (shared guard) |
| Redirect URI exact-match allowlist | Implemented · Mock-tested |
| Code exchange, PKCE (configurable) | Implemented · Mock-tested |
| Page discovery (`/me/accounts`) | Implemented · Mock-tested |
| Page ownership + task validation | Implemented · Mock-tested |
| Encrypted token storage | Implemented · Mock-tested |
| Connect / reconnect / disconnect | Implemented · Mock-tested |
| Duplicate Page prevention | Implemented · Mock-tested |
| Company/brand RBAC | Implemented · Mock-tested |
| Tenant + brand isolation | Implemented · Mock-tested |
| Audit logging incl. refusals | Implemented · Mock-tested |
| AR/EN UI, RTL, 7 states | Implemented · Mock-tested |
| Token expiry → needs reconnect | Implemented · **Not tested against real Meta** |
| Long-lived token exchange / refresh | **Out of scope** (later batch) |
| Webhooks, Inbox, AI, IG DM, automation | **Out of scope** |

**No new permission surface.** B1 reuses the A1 abilities that already existed:
`brand.integration.connect`, `.disconnect`, `.reconnect`, `.status`.

### Endpoint map

| Method | Path | Gate |
|---|---|---|
| POST | `/api/v1/integrations/facebook/connect` | session + `brand.integration.connect` + brand in scope |
| GET | `/api/v1/integrations/facebook/callback` | **the OAuth state itself** (browser may carry no session) |
| GET | `/api/v1/integrations/facebook/pages` | session + connect ability + state owned by this user/tenant |
| POST | `/api/v1/integrations/facebook/confirm` | session + connect/reconnect + state owned + brand in scope |
| GET | `/api/v1/integrations/facebook/connections` | session + status ability + brand scope |
| DELETE | `/api/v1/integrations/facebook/connections/:id` | session + disconnect ability + tenant match |
| POST | `/api/v1/integrations/facebook/purge-states` | session + status ability |

---

## 4. Defects the suite caught (and that I had introduced)

Listed because they are the strongest evidence the tests are real.

1. **Every Facebook callback would have returned 403.**
   `consumeOAuthState()` compared the state's tenant and user unconditionally. A
   callback authenticates *by* the state and does not know the tenant yet, so
   every real redirect would have been refused `OAUTH_STATE_MISMATCH`. Each
   binding is now verified only when supplied.

2. **No Page could ever be connected.**
   `listAvailablePages()` did not carry `pageAccessToken` through, so
   `connectPage()` always hit the `CREDENTIAL_MISSING` guard. The whole feature
   was non-functional.

3. **A Page access token leaked to the browser.**
   After fix 2, `GET /integrations/facebook/pages` returned the discovery array
   untouched, so the token rode out in cleartext. The route now re-projects to
   six safe fields. Three assertions pin it.

4. **A concurrent connect surfaced as HTTP 500.**
   Two connects of the same Page could both pass the ownership pre-check; the
   loser hit the unique index and the raw `pg` error escaped. Now
   `PAGE_ALREADY_CONNECTED` → 409.

---

## 5. Security and tenant isolation verification

| Claim | How proven | Count |
|---|---|---|
| Plaintext state never stored | column-shape check + hash comparison | 2 |
| State is single-use | replay, plus 3 concurrent consumes → exactly 1 wins | 3 |
| State expires | TTL-expiry is refused | 1 |
| State bound to user / tenant / session / redirect | four separate refusal cases | 4 |
| Redirect URI allowlist is exact, not prefix/wildcard | allowed, unrelated, prefix, suffix | 4 |
| Cross-tenant callback theft refused | another company's session using this stateId | 2 |
| Cross-tenant page claim refused | same Page, second company | 1 |
| Cross-brand page refused (same company) | brand outside the caller's scope | 1 |
| Zero-brand scope refused | explicit `[]` and absent scope | 2 |
| Page outside the grant refused | arbitrary pageId | 1 |
| Insufficient Page permissions refused | read-only Page | 1 |
| Duplicate Page prevented | reconnect, and 2 concurrent connects | 2 |
| Token encrypted at rest | ciphertext ≠ plaintext, and decrypts back | 2 |
| No token in any HTTP response | connect, pages, confirm, connections | 6 |
| No token in any URL | app secret, user token, page token | 3 |
| No token in the parked grant's HTTP projection | `/pages` and confirm responses | 3 |
| App secret never in a URL | code exchange uses POST | 2 |
| Graph error body never echoed | JSON error, non-JSON, unreachable host | 6 |
| Graph token travels as a header | Authorization, not query string | 1 |
| Open redirect impossible | origin from allowlist + fixed path + fixed keys | 3 |
| Every mutation audited | connect, reconnect, disconnect, conflict | 4 |
| Conflict audit names no token and no owner | metadata + object_id | 2 |

**Not proven by any of this:** that Meta actually issues the tokens, that the
App's permission configuration allows it, or that the task model matches what
Meta returns. That is §8.

---

## 6. Graph API version — documented decision

Read from Meta's published *Available Graph API Versions* table on 2026-10-19:

| Version | Introduced | Available until |
|---|---|---|
| **v26.0** | 2026-07-29 | TBD — current |
| v23.0 | 2025-05-29 | 2027-10-08 |
| v21.0 | 2024-10-02 | **2027-01-21** — used by `src/facebook.js` |

**B1 pins `v26.0`.** The endpoints used (`/oauth/access_token`, `/me/accounts`)
are the most stable in the platform, so version risk is low, and pinning an old
version on new code would buy only ~3 months before `v21.0` end-of-life.

**`src/facebook.js` stays on v21.0.** Moving a proven production reply/comment
path onto an API surface this batch never exercises is a separate deliberate
change. **It is a follow-up, not a task for B1**, and v21.0 is EOL 2027-01-21.

There is **no silent fallback**: an unsupported `META_GRAPH_VERSION` fails
loudly rather than degrading.

**Deliberate deviation from Meta's documented example.** Meta shows the code
exchange as a `GET` with `client_secret` in the query string. B1 uses `POST`.
Identical parameters and response; a `GET` would put the app secret into every
proxy and access log on the path.

---

## 7. Finding: the A1 PostgreSQL suite was reporting success without running

This is **not a B1 change** and it needs an owner decision. It surfaced because
B1 needed a working PostgreSQL job.

Three independent defects:

1. The CI service ran stock `postgres:16`, which has no pgvector, while
   `migrations/001_init.sql` does `CREATE EXTENSION IF NOT EXISTS vector`. The
   migration ledger could not be applied at all.
2. `test-roles-pg.mjs` printed its summary and called `process.exit()` at the
   **end of the `try` block**. Any throw jumped to the `catch`, which recorded
   the failure and then let the process exit **0**. A fatal was a green step.
3. All 37 service calls passed `db: client` — an already-connected `pg.Client`,
   which throws on the `connect()` the services use for transactions.

**Consequence: run `39193539197`, reported as "PostgreSQL suite success", had
executed zero assertions.** The A1 PostgreSQL coverage should be treated as
**unverified**.

### Current state of that suite (expected red, left red deliberately)

With pgvector fixed it runs, and **164 A1 assertions now execute; 5 fail**. I
did not change A1's expectations — three are wrong expectations, one may be a
real gap, and that judgement is the owner's.

| Failing assertion | Assessment |
|---|---|
| `a duplicate name is refused` | **Test bug.** Sends `permissions: []`; `canDelegateRole` fail-closes on an empty ability list, so `NOT_DELEGABLE` fires before the name check. |
| `cross-tenant creation is refused` | **Test bug, no hole.** Same cause. Separately verified: every roles route takes `tenantId` from `req.v1`/`req.auth`, never from the body, so a client cannot name another company. The service correctly does not re-check what the route already guarantees. |
| `privilege escalation is refused` | **Test bug.** Asks Company Admin for `user.disable` + `brand.grant_all`. Verified against `ROLE_ABILITIES`: Company Admin holds **both**. The ceiling is right to allow it. |
| `a role can be soft-deleted` | **Undiagnosed.** |
| `fatal: check is not a function` | **Undiagnosed** helper misuse. |

**Recommended:** correct the three wrong expectations (use an ability Company
Admin does *not* hold, e.g. `company.metrics`), and investigate the last two.
I have not done this — it is A1 scope, it is a security-posture judgement, and
A1 is owner-accepted.

The A1 and B1 suites now run in **separate CI jobs**, so B1's green is B1's.

---

## 8. Meta assumptions and external blockers

### Mock-tested, NOT verified against Meta

Everything in §3 runs against a deterministic mock. A pass proves our logic. It
proves nothing about Meta.

### Blockers (need owner action, §10)

| # | Blocker | Consequence if wrong |
|---|---|---|
| 1 | **Login type**: Facebook Login vs Facebook Login for Business | The authorize URL may be rejected |
| 2 | **App mode**: Development vs Live | In Development, only App-role users/admins/testers can authorize |
| 3 | **Page Management access** | If absent, `/me/accounts` returns nothing and no Page can be connected |
| 4 | **App Review status** | `pages_show_list` + `pages_read_engagement` are the discovery baseline; posting/ commenting permissions are out of B1 scope and need their own review |
| 5 | **PKCE support** for the configured login type | B1 enables PKCE by default; set `META_OAUTH_PKCE=false` if unsupported |
| 6 | **Stable callback URL** | §9 |

### Assumptions B1 makes, stated plainly

- A Page needs `MANAGE` **and** `CREATE_CONTENT` **and** `MODERATE` tasks.
  **Unverified.** If Meta returns a different task set in this app's
  configuration, every Page will be refused as "not connectable". The UI shows
  exactly which tasks are missing, so this will be visible immediately rather
  than silent.
- `/me/accounts` returns `tasks`. Documented, but unverified for this app.
- `pages_show_list` + `pages_read_engagement` are the right discovery scopes.
- **A Page access token's lifetime is not asserted.** `credentialExpiresAt` is
  reported as `null` when Meta states no expiry, and the UI says "needs
  reconnecting" rather than "never expires". Token renewal is a later batch.

---

## 9. Traefik router proposal — **NOT APPLIED**

### Current verified state

| Fact | Value |
|---|---|
| Traefik container | `traefik-traefik-1` |
| Traefik networking | `network_mode: host` |
| Entry points | `web` :80, `websecure` :443; `web` redirects to `websecure` |
| Providers | `--providers.docker=true --providers.docker.exposedbydefault=false` |
| Certresolver | `letsencrypt` (HTTP challenge on `web`) |
| Routers defined today | 6: `menu.lifewithcacao.com`, `menu.universalfoodco.com`, `odoo.universalfoodco.com`, `bitwarden.universalfoodco.com`, `remote.universalfoodco.com`, `portainer.universalfoodco.com` |
| `social.universalfoodco.com` | **No router.** Returns Traefik's default 404. DNS and TLS both correct. |
| Restaurant stack network | `restaurant-agent_default` (Traefik is **not** on it) |
| `restaurant-page-agent` | Express API, container 3000, published `0.0.0.0:3000` |
| `lwc-web` | Next.js, container 3000, published `0.0.0.0:3001` |

### Key finding that makes this small

`apps/web/next.config.mjs` rewrites `/api/:path*` →
`http://restaurant-page-agent:3000/api/:path*`, and the browser client uses
`API_BASE = '/api/v1'`.

**Therefore one router to `lwc-web` serves the web app *and* the API
same-origin.** No second service, no CORS, no cookie changes. The OAuth callback
`https://social.universalfoodco.com/api/v1/integrations/facebook/callback`
works through the same path as the app.

### Proposal (labels only — **do not apply without approval**)

On the `web` service in `docker-compose.yml`:

```yaml
  web:
    labels:
      - traefik.enable=true
      - traefik.docker.network=restaurant-agent_default
      - traefik.http.routers.social.rule=Host(`social.universalfoodco.com`)
      - traefik.http.routers.social.entrypoints=websecure
      - traefik.http.routers.social.tls.certresolver=letsencrypt
      - traefik.http.services.social.loadbalancer.server.port=3000
```

| Question | Answer |
|---|---|
| Affected service | `web` (`lwc-web`) only |
| Host rule | `Host(`social.universalfoodco.com`)` — a new hostname, matching no existing rule |
| Target internal port | `3000` |
| Entry point | `websecure` (:443), consistent with all 6 existing routers |
| TLS | `letsencrypt` HTTP challenge, same resolver as the others |
| Docker network | **Compatible as-is.** Traefik is on `host` networking and already reaches containers on other bridge networks (all 6 existing routers do). `traefik.docker.network` is stated explicitly so the provider does not have to infer it. **No network attach required.** |
| Security impact | Exposes `social.universalfoodco.com` publicly — it already resolves publicly and already answers on 443. Net change is 404 → the app. All existing routers keep their own `Host` rules and are unaffected. |
| Conflicts | None by hostname. Port 443 is already bound by Traefik's `host` networking; no new port is published. |

### Rollback

1. Remove the seven labels from the `web` service.
2. `docker compose up -d web` — recreates only `lwc-web`.
3. `social.universalfoodco.com` returns to 404. **No other stack is touched at
   any point**, because every other router is label-driven and unaffected.

Rollback is a label deletion and a single-container recreate. No database, no
data, no other service.

---

## 10. Meta Dashboard owner checklist

Read-only. **Report values and statuses only — never paste a secret.**

**A. App identity**
1. App ID — confirm it matches `FB_APP_ID` already on the VPS.
2. App mode: **Development or Live?**
3. If Development: who are the App Roles (Admin / Developer / Tester)?

**B. Login configuration** — the single most important unknown
4. Is **Facebook Login** configured, or **Facebook Login for Business**?
5. Does the configured login support **PKCE** (`code_challenge_method=S256`)?
   If not, set `META_OAUTH_PKCE=false` on the API container.
6. Under *Facebook Login → Settings*, what are the **Valid OAuth Redirect URIs**?
   Confirm `https://social.universalfoodco.com/api/v1/integrations/facebook/callback` is present **exactly**.

**C. Permissions**
7. Which permissions are requested, and at what level:
   `pages_show_list`, `pages_read_engagement`, `business_management`?
8. App Review status for each: not requested / pending / approved?
9. Is the app **Live**, and does it have **Advanced Access** for the above?

**D. Page access**
10. On a test Page, what **Page Tasks** does the authorizing Facebook user hold?
    B1 requires `MANAGE`, `CREATE_CONTENT`, `MODERATE`.
11. Does `/me/accounts` return Pages for this app in this mode?
12. Can a non-admin (editor/analyst) authorize, and what tasks do they get?

**E. Operational**
13. Which Graph API versions does this app have enabled?
14. Is there a Data Deletion Callback configured?
15. Any rate limits or restrictions on this app?

---

## 11. Deployment and rollback proposal — **NOT EXECUTED**

### Environment variables to add

| Variable | Value | Notes |
|---|---|---|
| `META_OAUTH_REDIRECT_URI` | `https://social.universalfoodco.com/api/v1/integrations/facebook/callback` | Must also appear in the Meta allowlist |
| `META_OAUTH_REDIRECT_URIS` | same value | Comma-separated exact-match allowlist |
| `META_OAUTH_PKCE` | `true` | Set `false` only if §10 B5 says no |
| `META_OAUTH_APP_PATH` | `/integrations/facebook` | Post-callback landing path; default is the same |
| `META_GRAPH_VERSION` | unset → `v26.0` | Do **not** set it to match `FB_GRAPH_VERSION` |

`FB_*` variables are untouched.

### Migration

`migrations/023_facebook_oauth.sql` — additive only: one new table, three
nullable columns, three indexes, one check constraint. Every statement is
guarded, so it is re-runnable. It modifies **no existing row**.

Risk: `CREATE INDEX` takes a share lock on `channels`. At current row counts
this is negligible. Run it in a transaction during a low-traffic window.

Rollback: dropping the code needs no schema change. If the objects must go,
`DROP TABLE oauth_states` and `ALTER TABLE channels DROP COLUMN` — no channel
row is modified by either, so history cannot be orphaned.

### Deploy order

1. Back up the database (A1 pattern: `pg_dump` + verify a restore).
2. Snapshot the stack.
3. Apply migration 023.
4. Deploy the API image.
5. Rebuild and deploy `lwc-web`.
6. **Then** the Traefik router (§9).
7. **Then** the Meta allowlist entry (§10 B6).

Order matters: the callback must be reachable before Meta is told it may
redirect there, or the first real user sees a 404 mid-consent.

### Rollback

| Layer | Action | Blast radius |
|---|---|---|
| App code | Redeploy previous image | API only |
| Frontend | Redeploy previous `lwc-web` | Web only |
| Router | Remove labels, recreate `lwc-web` | One hostname returns to 404 |
| Migration | Leave in place | Additive and unused by the old code |
| Meta | Remove the redirect URI | Stops new authorizations |

Existing integrations are untouched throughout: `oauth_provider` is NULL on
every pre-B1 channel and the old code never reads it.

---

## 12. Manual acceptance test plan

Run **after** the owner approves deploy, migration, Traefik and Meta changes.

**Prerequisites** — a brand the tester administers; a Facebook account with
full admin on a test Page; a second company to test isolation.

| # | Steps | Expected |
|---|---|---|
| 1 | Open `/integrations/facebook` as a Company Admin | Page renders, brand selector populated, no console errors |
| 2 | Switch to Arabic | Full RTL mirror, no clipped text, no missing keys |
| 3 | Click *Continue to Facebook* with no popup | Clear blocked-popup guidance |
| 4 | Complete consent | Returns to the Page chooser; **no token in the URL** |
| 5 | Inspect the chooser | Pages listed; insufficient ones disabled with the missing tasks named |
| 6 | DevTools Network → `GET /pages` | Response has **no `pageAccessToken` key and no `EAA-` value** |
| 7 | Connect a Page | Success; channel appears; audit row written |
| 8 | Restart the browser, reopen | Connection listed; token still absent from every response |
| 9 | Connect the **same Page from the second company** | Refused: "already connected to another company"; the refusal names no other tenant |
| 10 | Copy a `stateId`, replay the callback URL | Refused: already used / expired |
| 11 | Change the `stateId` by one character | Refused, no stack trace |
| 12 | Change the host in `META_OAUTH_REDIRECT_URI` to a prefix/suffix | Refused |
| 13 | Connect a second Page to a **different brand** of the same company | Rejected: brand outside scope |
| 14 | Disconnect | Page removed, channel row retained, audit written |
| 15 | Reconnect after disconnect | Restored in place, no duplicate channel |
| 16 | Sign in as an Agent | Connect controls hidden **and** the API refuses with 403 |
| 17 | Deny consent at Facebook | Clear Arabic + English message; nothing connected |
| 18 | Facebook unreachable | "Temporarily unavailable"; no leaked upstream text |
| 19 | Audit log | connect, reconnect, disconnect and the refusal all present |
| 20 | Existing integrations page | Unchanged; existing channels still work |

**Explicitly not part of acceptance:** replying to comments, Instagram DMs,
webhooks, AI behaviour, token refresh. Those are later batches.

---

## 13. Open follow-ups

**B1**
1. Deploy, migrate, route and Meta allowlist — each needs owner approval.
2. Verify the required Meta task set against the real dashboard (§10 D10).
3. If PKCE is unsupported, set `META_OAUTH_PKCE=false` and re-test.
4. Token lifecycle (long-lived exchange, refresh, rotation) — separate batch.
5. `purge-expired` states currently has an HTTP endpoint but no scheduler. Harmless
   (states are unusable once expired) but it grows the table.

**A1 — owner decisions**
6. §7: the A1 PostgreSQL suite never ran. Decide how to proceed on the 5 failures.
7. `src/facebook.js` is on Graph v21.0, **EOL 2027-01-21**. Schedule the upgrade.
8. 16 npm audit findings (3 critical, 7 high) — all reported patched in installed
   versions; a recurring update cadence is still needed.
9. `STATUS.md` / `OPENCODE_HANDOVER.md` still reference P0.5 as latest. Left
   untouched: the Arabic files show encoding damage in this environment and I
   would rather not risk corrupting them.

**Security note raised by §7:** `docker compose config` prints every secret in
plaintext. Not changed — noted so it is a deliberate decision rather than an
oversight.