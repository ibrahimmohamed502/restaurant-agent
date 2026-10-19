# B1 — Meta Dashboard read-only inspection

**Purpose:** establish what the Facebook App is actually configured to do, so
B1's assumptions can be confirmed or corrected **before** any real OAuth attempt.
**No changes are made by this inspection.** Nothing here requires the App Secret.

**Status:** B1 is CI Verified. **Not accepted, not deployed, not merged.** Steps 1
and the B1 permission rows of Step 4 are **owner-verified**; the rest remain a
read request. Nothing in this document changes Meta.

---

## Rules of engagement

- **Read only.** Do not save, submit, or toggle anything. If a screen offers a
  Save button, you are on the wrong screen.
- **Never paste the App Secret, any access token, or any `EAA…` string** into
  chat, a document, or a ticket. Only statuses, counts, labels and IDs.
- **App ID is safe** to report (it is a public identifier, not a credential).
- If any screen looks like it would change something, stop and report the screen
  name instead.
- Meta's dashboard relabels navigation regularly. Where a name may have moved,
  the **what to look for** line is authoritative, not the label.

---

## Step 1 — Identify the app, and its App Mode

**STATUS: COMPLETE — owner verified 2026-10-19. Do not re-collect these values.**

| Field | Verified value |
|---|---|
| App ID | `1673966207646736` |
| App Name | Restaurant Bot |
| App Mode | **Live** |
| App Type | Business |

> Why it matters, now that the answer is known: the app is **Live**, so
> authorization is not restricted to App Roles. Any Facebook account the app is
> not otherwise restricted by Page access can complete a consent. That also means
> `pages_show_list` / `pages_read_engagement` must be **Active** rather than
> merely requested — which is what Step 4 confirms.

---

## Step 2 — Login Type (the single most important unknown)

**STATUS: PARTIALLY COMPLETE — owner verified 2026-10-19.**

| Field | Verified value |
|---|---|
| Product | **Facebook Login for Business** — set up |
| PKCE supported | **UNKNOWN** — not yet inspected |
| Enforce HTTPS | **UNKNOWN** — not yet inspected |
| Configuration ID | **UNKNOWN** — not yet inspected |

**Remaining work: Facebook Login for Business → Configurations.** Read the
Configuration ID from that screen (it is an identifier, safe to share) and report
whether PKCE is offered.

> Why the Configuration ID matters now: the app is confirmed to be **Facebook
> Login for Business**. B1 sends **no `config_id`** — it relies on the app's
> default configuration. Login for Business configurations are addressed by
> `config_id`, and if this app has no usable default the authorization request
> will be rejected before any user sees a consent screen. This is the single
> highest-value unknown remaining.

---

## Step 3 — Valid OAuth Redirect URIs

**STATUS: NOT DONE — this is now unblocked and is the next owner action after the
Configuration ID.**

**Where:** Facebook Login for Business → **Configurations** → the configuration →
**Valid OAuth redirect URIs**.

**What to look for:**
- The list of registered redirect URIs, as plain text values.

**Report:** the exact list of registered redirect URIs (URLs are not secrets).

> Why it matters: Meta matches the redirect URI **exactly**. B1 will use:
>
> ```
> https://social.universalfoodco.com/api/v1/integrations/facebook/callback
> ```
>
> It is **not** registered today. The Traefik router for
> `social.universalfoodco.com` **now exists** and serves the app — corrected
> 2026-10-19, GitHub `main` commit `287e178`, which pinned the compose project
> name and registered the six Traefik labels. Verified live: `/dashboard` → 307,
> `/api/v1/_health` → 200.
>
> The remaining blocker is **not** the router. It is that B1 itself is not
> deployed, so the callback path currently resolves to the pre-B1 integrations
> router and answers `401`. Registering the URI before B1 ships would send real
> users to a dead endpoint.
>
> Also note: B1 compares the redirect URI with **exact string equality**. A
> trailing slash or a missing segment will be refused.

---

## Step 4 — Permissions and access level

**Where:** left sidebar → **App Review** → **Permissions and Features**
(in some layouts: **Use cases** → **Data Access**).

**What to look for,** for each of these specifically:

| Permission | What to report |
|---|---|
| `pages_show_list` | Requested? Access level (Standard / Advanced / Not requested) · App Review status |
| `pages_read_engagement` | Requested? Access level · App Review status |
| `business_management` | Requested? Access level · App Review status |
| `pages_manage_posts` | Requested? Access level · App Review status |
| `pages_manage_engagement` | Requested? Access level · App Review status |

**STATUS: the two B1 permissions are CONFIRMED. The rest remain unknown.**

| Permission | Verified state |
|---|---|
| `pages_show_list` | **Standard Access / Active** |
| `pages_read_engagement` | **Standard Access / Active** |
| `business_management` | unknown — not requested by B1 |
| `pages_manage_posts` | unknown — not requested by B1 |
| `pages_manage_engagement` | unknown — not requested by B1 |

> Why it matters: this is the good news in the whole document. B1's two scopes are
> **Active at Standard Access**, so there is **no App Review blocker** on the
> permission side. Combined with the app being **Live**, the remaining unknowns are
> the Configuration ID, the redirect URI, and the Page task — none of which is an
> App Review gate.

> Why it matters: B1 requests **only** `pages_show_list` and
> `pages_read_engagement`. The posting and moderation permissions are **not** in
> B1's scope and B1 does not request them. If they are already approved, that is
> useful headroom for later batches — but B1 must not depend on them.

---

## Step 5 — Page tasks (decides whether any Page can connect)

**Where:** the Facebook Page itself → **Page settings → Page access
(permissions)** → **People with Page access**, for a **test** Page.

**What to look for,** for the Facebook account that will perform the test
connect:

1. That account's **Page Task** on that Page — e.g. Full Control, or a custom
   task set.
2. Which specific tasks are ticked (Manage, Create content, Moderate, Advertise,
   Analyse).

**Report:** the Page Task label, and the individual tasks held.

> Why it matters: B1 now requires **only the `MANAGE` task** to connect. That is
> a deliberate least-privilege decision — B1 links a Page and lists it; it does
> not publish or moderate, so it must not demand those capabilities.
>
> This is the value that was previously unknown, and it is why the checklist
> exists. If Meta returns different task names for this App, every Page will be
> shown as **not connectable** with the missing names listed — visible, not
> silent. If that happens, the fix is one env var:
> `META_OAUTH_REQUIRED_TASKS`, not a code change.

---

## Step 6 — App Roles (only matters while in Development mode)

**Where:** left sidebar → **App Roles**.

**What to look for:** the list of accounts with roles — Admin, Developer,
Tester, Marketing Analyst.

**Report:** whether the Facebook account that will do the test connect has a role,
and which one.

---

## Step 7 — Graph API versions enabled

**Where:** **Settings → Basic**, and the API version shown in the Graph API
Explorer / any Graph URL.

**What to look for:** whether the App pins a minimum Graph API version.

**Report:** the minimum Graph API version if shown, or "not pinned".

> Why it matters: B1 pins **v26.0** (the current version). B1's existing
> reply/comment client (`src/facebook.js`) stays on **v21.0**, which is
> **end-of-life on 2027-01-21** — a separate, later change. Nothing in this
> inspection should change either.

---

## Step 8 — Data deletion callback (compliance, not blocking)

**Where:** **App Settings → Basic** → **Data Deletion Instructions**.

**What to look for:** whether a URL or instructions are configured.

**Report:** configured or not. **Do not paste the instructions text.**

---

## What to send back

**Already answered — do NOT re-collect these:**

```
App ID:                1673966207646736
App Name:              Restaurant Bot
App Mode:              Live
App Type:              Business
Login Type:            Facebook Login for Business (set up)
pages_show_list          Standard Access / Active
pages_read_engagement    Standard Access / Active
```

**Still outstanding:**

```
Configuration ID:      <id, or "none shown">
PKCE supported:        yes | no | not shown
Enforce HTTPS:         on | off | not shown
Valid redirect URIs:   <list, or "none">

business_management      <access level> / <review status>
pages_manage_posts       <access level> / <review status>
pages_manage_engagement  <access level> / <review status>

Test Page task:        <label>  tasks: <list>
Test account App Role: <role or "none">
Min Graph API version: <version or "not pinned">
Data deletion callback: configured | not configured
```

Anything you are unsure about, write `unknown` — an honest `unknown` is more
useful than a guess.

---

## After you report back

Nothing happens automatically. In order, and each needing separate approval:

1. ~~**Traefik router** for `social.universalfoodco.com`~~ — **DONE.**
   Live and serving, 2026-10-19. `/dashboard` → 307, `/api/v1/_health` → 200.
   Made durable in GitHub `main` commit `287e178`.
2. **Reconcile B1's assumptions** against your answers — add `config_id` support
   if Login for Business requires it, on the dev branch, re-tested with mocks.
   No Production involved.
3. **Fix the PKCE code-exchange defect** — found in review 2026-10-19, not yet
   implemented. B1 sends `code_challenge` but never sends `code_verifier`, so
   every real connect would fail at token exchange. Must land before any Spike.
4. **Deploy B1 + apply migration 023** — needs Production approval. Until this
   happens the callback path is not served by B1.
5. **Register the redirect URI** in Meta — only after step 4, or the first real
   user gets a `401` mid-consent instead of a working callback.
6. **Real Meta OAuth Spike** — one test Page, one test brand, mocked-then-real.
   First genuine verification of anything B1 has claimed so far.
7. Merge to `main` only after that Spike is accepted.

Until step 6 completes, **nothing B1 has built is verified against Meta.** Every
test to date used a deterministic mock: it proves our logic, not Meta's. The
PKCE defect in step 3 is exactly the kind of bug a mock cannot catch.