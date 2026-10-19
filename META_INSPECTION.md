# B1 — Meta Dashboard read-only inspection

**Purpose:** establish what the Facebook App is actually configured to do, so
B1's assumptions can be confirmed or corrected **before** any real OAuth attempt.
**No changes are made by this inspection.** Nothing here requires the App Secret.

**Status:** B1 is Development + CI Verified. **Not accepted, not deployed, not
merged.** This document is a read request; it changes nothing.

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

**Where:** <https://developers.facebook.com/apps> → your app → **Dashboard** (the
landing page for the app).

**What to look for:**
1. The **App ID**, shown in the app header. Confirm it matches `FB_APP_ID` on the
   VPS (it is an identifier, safe to share).
2. The **App Mode** indicator, shown near the top of the dashboard — a toggle or
   banner reading **Live** or **Development**.

**Report:** App ID · App Mode (Live / Development)

> Why it matters: in **Development** mode, only people with an App Role
> (Admin / Developer / Tester) can complete the authorization. A real customer
> will not be able to connect until the app is Live or added as a tester.

---

## Step 2 — Login Type (the single most important unknown)

**Where:** left sidebar → **Facebook Login** (or **Use cases** → **Login and
account discovery**, in newer layouts). Then the **Settings** tab on that page.

**What to look for:**
1. Whether the configured product is **Facebook Login** or **Facebook Login for
   Business**. In Facebook Login for Business the product is usually listed under
   **Business** or **Use cases**, not under Facebook Login.
2. The **Client OAuth Settings** section, and within it:
   - whether **PKCE** is listed as supported / enabled;
   - whether **Enforce HTTPS** is on.

**Report:** Login Type (Facebook Login / Facebook Login for Business) · PKCE
supported (yes / no / not shown) · Enforce HTTPS (on / off / not shown)

> Why it matters: the two login types can behave differently for redirect URIs,
> scopes and token handling. B1 sends PKCE **on** by default
> (`META_OAUTH_PKCE=true`). If PKCE is not supported for this configuration,
> that single env var must be set to `false` before the Spike — otherwise every
> connect fails.

---

## Step 3 — Valid OAuth Redirect URIs

**Where:** same page → **Facebook Login → Settings** → **Client OAuth Settings** →
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
> It is **not** registered today — there is no Traefik router for
> `social.universalfoodco.com` yet. So expect an empty or unrelated list. That
> is expected at this stage; it must be added only after the router exists, and
> only with separate Production approval.
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

**Report, per permission:** `name` — access level — review status.

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

Reply with this block filled in. Anything you are unsure about, write
`unknown` — an honest `unknown` is more useful than a guess.

```
App ID:                <id or "different, see note">
App Mode:              Development | Live
Login Type:            Facebook Login | Facebook Login for Business | unknown
PKCE supported:        yes | no | not shown
Enforce HTTPS:         on | off | not shown
Valid redirect URIs:   <list, or "none">

pages_show_list          <access level> / <review status>
pages_read_engagement    <access level> / <review status>
business_management      <access level> / <review status>
pages_manage_posts       <access level> / <review status>
pages_manage_engagement  <access level> / <review status>

Test Page task:        <label>  tasks: <list>
Test account App Role: <role or "none">
Min Graph API version: <version or "not pinned">
Data deletion callback: configured | not configured
```

---

## After you report back

Nothing happens automatically. In order, and each needing separate approval:

1. **Reconcile B1's assumptions** against your answers. If Login Type or App Mode
   invalidates an assumption, it gets corrected on the dev branch and re-tested
   with mocks — no Production involved.
2. **Traefik router** for `social.universalfoodco.com` — needs Production
   approval. The URL is already publicly resolving and answering 404.
3. **Register the redirect URI** in Meta — only after the router exists, or the
   first real user gets a 404 mid-consent.
4. **Real Meta OAuth Spike** — one test Page, one test brand, mocked-then-real.
   First genuine verification of anything B1 has claimed so far.
5. Deploy and merge only after that Spike is accepted.

Until step 4 completes, **nothing B1 has built is verified against Meta.** Every
test to date used a deterministic mock: it proves our logic, not Meta's.