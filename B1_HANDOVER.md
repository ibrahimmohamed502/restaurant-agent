# B1 — Facebook Page Self-Service OAuth · Handover

**Branch:** `b1-facebook-oauth`
**Base:** `05d0c0c` (A1, owner-accepted)
**Head at time of writing:** see git log; CI run `39212007748`
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

## 7. The A1 PostgreSQL suite was reporting success without running — RESOLVED

This was **not** a B1 change. It surfaced because B1 needed a working
PostgreSQL job. **A1's official acceptance is unaffected** — what was broken was
test *reliability*, not A1 behaviour.

### The three defects

1. The CI service ran stock `postgres:16`, which has no pgvector, while
   `migrations/001_init.sql` does `CREATE EXTENSION IF NOT EXISTS vector`. The
   migration ledger could not be applied at all.
2. `test-roles-pg.mjs` printed its summary and called `process.exit()` at the
   **end of the `try` block**. Any throw jumped to the `catch`, which recorded
   the failure and then let the process exit **0**. A fatal was a green step.
3. All 37 service calls passed `db: client` — an already-connected `pg.Client`,
   which throws on the `connect()` the services use for transactions.

**Consequence: run `39193539197`, reported as "PostgreSQL suite success", had
executed zero assertions.** A1's PostgreSQL coverage was unverified.

### What it was hiding

Once the mechanics were fixed, the suite ran — and a **count floor** (see below)
revealed that the first abort had been masking further defects. **Seven** test
defects in total were found and corrected. **No A1 production code was changed:**
no RBAC, no permission ceiling, no tenant isolation, no behaviour.

| # | Assertion | Root cause | Kind |
|---|---|---|---|
| 1 | `a duplicate name is refused` | Sent `permissions: []`; `canDelegateRole` fail-closes on an empty ability list, so `NOT_DELEGABLE` fired before the name check | Test |
| 2 | `privilege escalation is refused` | Asked Company Admin for `user.disable` + `brand.grant_all`. **Company Admin holds both** (verified against `ROLE_ABILITIES`), so the ceiling was right to allow it | Test |
| 3 | `cross-tenant creation is refused` | Expected a service-level `ROLE_FORBIDDEN` that does not exist. The guarantee lives at the route, and the test never tested it | Test |
| 4 | `a role can be soft-deleted` | Expected `'disabled'`; migration 022 made soft delete set `'deleted'` | Test |
| 5 | `fatal: check is not a function` | `const { rows: [check] } = …` shadowed the assertion helper, aborting the suite — sections 10+ never ran | Test |
| 6 | `no partial row left after rollback` | Wrapped service calls in the caller's `BEGIN/ROLLBACK`, but `acquire()` borrows its own pooled client, so the caller's rollback could never affect it | Test |
| 7 | `brand.grant_all in custom role is refused` | Expected a write-time 422. The control is **read-time stripping** (see below) | Test |

### Findings that are *not* defects

- **Cross-tenant role creation — no hole.** Every route in `api/v1/roles.js`
  takes `tenantId` from `scope(req, res)` → `req.v1`/`req.auth`, never from the
  body. The service correctly does not re-check what the route guarantees. A new
  test now proves a `tenantId` smuggled into the body never lands a role in the
  other company.
- **`brand.grant_all` in a custom role — inert, not exploitable.** The control is
  `CUSTOM_ROLE_FORBIDDEN_ABILITIES`, stripped by `normalizeCustomAbilities`, which
  every session passes through (`sessions.js` → `effectiveCustomAbilities`).
  Verified: storing it yields effective abilities `[]` and `can()` is `false`.
  Read-time placement is the *stronger* one — it holds even for a row written
  directly to the database. Every consumer of `roles.permissions` was checked;
  the session loader is the only one that converts the column into abilities.

### One integrity finding, deliberately not fixed

`GET /roles` returns the **stored** permissions, so a role can display
`brand.grant_all` in the UI while not actually possessing it. Misleading, not a
vulnerability. Changing the API response is A1 production behaviour and needs
owner approval.

### CI hardening

- **Assertion count floor**, not just a zero check. `pass > 0` is too weak: a
  suite that dies halfway still has passes — exactly how the broken ledger hid.
  **A1 floor 111, B1 floor 178** (both the verified counts). The floor found
  defects 6 and 7 immediately.
- Summary and exit code moved outside the `try` block, so a thrown error can no
  longer exit 0.
- A1 and B1 run in **separate CI jobs**, so B1's green is B1's.

---

## 7a. OAuth security review — findings

Reviewed against the implementation, not the handover.

### Verified sound

| Area | Basis |
|---|---|
| State cannot be forged | Only SHA-256 is stored; a DB read yields no usable token |
| State cannot be replayed | Single conditional `UPDATE … WHERE consumed_at IS NULL`; 3 concurrent consumes → exactly 1 wins |
| State bound to identity | tenant, user, session and redirect URI each verified; each verified **only when supplied**, because a callback cannot know them yet |
| No session confusion | The callback creates no session and never authenticates anyone; it only resolves a grant |
| Cross-tenant / cross-brand | State usable only by its own user+tenant; brand scope re-checked inside the connect transaction |
| Tokens never in responses | `/connect`, `/pages`, `/confirm`, `/connections` — no token in any body; `/pages` re-projects to six safe fields |
| Tokens never in URLs | App secret, user token and page token all asserted absent |
| Grants expire | 10-minute TTL; expired, spent and unknown states are three distinct refusals |
| Uniqueness enforced | Pre-existing global index + `channels_meta_tenant_owner_uidx`; the concurrent race resolves to 409, not 500 |
| Open redirect | Origin comes from an allowlisted URI, path and parameter names are fixed configuration |
| No token logging | No `console.*` in any B1 module |

### Two items worth the owner's attention

**1. The code exchange now defaults to GET — the documented form.**
Researched 2026-10-19 across every official Meta page that shows
`/oauth/access_token`: the manual login flow guide, the long-lived token guide,
"Access Tokens for Meta Technologies" and Marketing API authentication **all use
GET**. POST appears only in community threads where developers report it works —
evidence of *tolerance*, not of documented support.

The default therefore flipped from POST to GET. Betting the whole connect flow
on undocumented tolerance was the wrong call for a first real integration.
`META_OAUTH_EXCHANGE_METHOD=POST` remains available; its advantage (the app
secret never touches a URL) is preserved and tested. Because the documented GET
form *does* carry `client_secret` in the query string, the guarantee is now
explicitly that **the URL is never logged and no failure path can echo it** —
asserted for network errors and non-JSON error bodies.

**2. `/confirm` takes `brandId` from the body, not the state — NOW ENFORCED.**
The state pins a `brand_id`, but `/confirm` previously used the body value, so
the binding recorded at issuance was decorative. It was never exploitable —
`connectPage` re-checks the brand against the tenant and the caller's brand scope
inside the transaction — but the one moment the user was shown "you are
connecting this page to THIS brand" was not the moment the database recorded it.

`/confirm` now compares the request brand against the grant's brand and returns
`409 BRAND_DOES_NOT_MATCH_GRANT` on a mismatch. Changing brand is still possible,
but only by starting a **new** connect flow with the new brand selected, which
re-authorizes and re-binds the state. There is deliberately no override flag: an
explicit re-selection flow would have to be designed and reviewed, not bolted on
as an escape hatch.

### Task threshold — connect scope, not feature scope

Required Page Tasks default to **`MANAGE` only**. Conflating *"may this Page be
linked?"* with *"may the agent post / reply / moderate?"* was what made the
original `MANAGE + CREATE_CONTENT + MODERATE` wrong: it demanded capability for
features that do not exist yet and refused legitimate Pages on their behalf.

`MANAGE` is the smallest task that establishes genuine Page administration rather
than visibility, so it remains a real gate. `READ_CONTENT` stays refused — a Page
the app can see but not act on would connect and then fail silently.

`PAGE_TASK_LADDER` documents the progression: `connectOnly` (default) →
`withPublishing` when publishing ships → `withModeration` after Inbox. Raising it
for a later batch is one env var, not a code change.

**The actual task names Meta returns for this App are still unverified** and are
item 5 of `META_INSPECTION.md`.

---

## 7b. PKCE verifier defect - found in review, FIXED

**Severity: this would have failed the first real OAuth attempt.**

B1 sent a `code_challenge` to Meta and stored only `SHA-256(verifier)`, then
called `exchangeCode({ code, redirectUri })` **without a `codeVerifier`**. PKCE
requires the client to present the *original* verifier at the exchange so Meta
can hash it and compare; a digest cannot be reversed. Every real connect would
therefore have been rejected at token exchange.

**Why 196 green assertions missed it.** The suite mocked the Graph transport with
a mock that only *counted* calls. Its single PKCE assertion checked that
`code_challenge` appeared in the authorize URL - the challenge going **out**. No
assertion ever checked the verifier coming **back**. That asymmetry is the blind
spot, and the count floor could not detect an assertion that did not exist.

**The fix.**

1. `code_verifier_encrypted` / `code_verifier_iv` added to the **unapplied**
   migration 023 - free, since it has never run.
2. The raw verifier is encrypted with the same AES-256-GCM key as
   `user_token_encrypted`. The digest is *kept* as an integrity check.
3. `takePkceVerifier()` releases it and **destroys it in the same statement**.
4. The callback passes `codeVerifier` to `exchangeCode()`.
5. If the verifier cannot be encrypted, `/connect` fails with
   `OAUTH_STATE_CRYPTO_UNAVAILABLE` instead of starting a doomed flow.

**Why destroy-on-read is safe, not a regression.** By the time the verifier is
read, the state has already been claimed (`consumed_at` set), so the row cannot be
replayed and there is no retry path to protect. The ciphertext is dead the moment
the claim succeeds; clearing it immediately is strictly better than leaving it for
`expires_at` to sweep.

**Concurrency and single-use are unchanged.** The claim remains a single
conditional `UPDATE ... WHERE consumed_at IS NULL`, and `takePkceVerifier` uses
its own single-statement `UPDATE ... RETURNING`, so two concurrent callbacks cannot
both obtain the verifier. Suite asserts exactly one of three concurrent callbacks
succeeds.

## 7c. Facebook Login for Business Configuration ID

The app is **Login for Business**, where configurations are addressed by an
explicit `config_id`. B1 previously sent none and relied on a default.

`META_OAUTH_CONFIG_ID` is now supported and is **entirely optional**: unset, the
authorize URL is byte-identical to before, so plain Facebook Login is unaffected.
The value is validated (`[A-Za-z0-9_-]{1,64}`) and never hardcoded - a value
carrying URL syntax is refused at connect time rather than producing a request
Meta would reject opaquely.

**The Configuration ID is not known yet.** It is read from the Meta dashboard and
must not be guessed.



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
| `META_OAUTH_CONFIG_ID` | from Meta | **Optional.** Required only if the app has no usable *default* Login for Business configuration. Never hardcode. Omit it entirely for plain Facebook Login. |
| `META_OAUTH_EXCHANGE_METHOD` | unset → `GET` | `GET` is the documented form. `POST` is undocumented. |
| `META_OAUTH_REQUIRED_TASKS` | unset → `MANAGE` | Only raise when a publishing/moderation feature actually ships |
| `META_GRAPH_VERSION` | unset → `v26.0` | Do **not** set it to match `FB_GRAPH_VERSION` |

`FB_*` variables are untouched.

> **`ENCRYPTION_KEY` is now load-bearing for PKCE.** Since the verifier is stored
> encrypted, a missing or wrongly-sized `ENCRYPTION_KEY` makes `/connect` fail
> with `OAUTH_STATE_CRYPTO_UNAVAILABLE` (HTTP 500) rather than silently starting
> a connection that cannot complete. That is intentional: sending a
> `code_challenge` we cannot honour is worse than not using PKCE.

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

