# 🏗️ Restaurant Page AI Agent — System Architecture & Operations Guide
> For engineers taking over or working on the system.
> النسخة دي مكتوبة للفريق التقني — any questions: check `STATUS.md` for live state and history.

---

## 1. What the system does

An always-on AI agent that replies to customers on the **Life with Cacao** Facebook Page:

- **Public comments** on page posts → AI reply (menu info, branches, prices, offers) in the **commenter's own language**, Kuwaiti dialect for Arabic, with user mention and the menu link.
- **Messenger DMs** to the page → same AI engine in a conversational mode (typing indicator, first-name greeting, menu link only when relevant).
- **Escalations** (complaints, collaborations, complex reservations, contact-data sharing) → the bot replies politely **and** emails the team (Resend API) with full details.

**Current deployment:** Docker container on company VPS (via Portainer), reachable through a temporary Cloudflare quick-tunnel (permanent subdomain `bot.lifewithcacao.com` planned).

---

## 2. Architecture

```
Facebook comment ─┐
                  ├→ Meta Webhooks ──HTTPS──→ Cloudflare Tunnel ──→ Docker: restaurant-page-agent
Messenger DM ────┘    (single callback URL)        (temp domain)         │
                                                                         ▼
                                              ┌─────────────────────────────────────┐
                                              │ Express server (Node 18+, ESM)      │
                                              │  • GET /webhook  (Meta verification)│
                                              │  • POST /webhook (events)           │
                                              │  • GET /health                     │
                                              │  • GET /privacy                    │
                                              └──────────────┬──────────────────────┘
                                                             ▼
                                   ┌─────────────────────────────────────────┐
                                   │ agent.js — AI Engine                    │
                                   │  1. Language detect (franc-min + rules) │
                                   │  2. Intent + scope (in/out of scope)    │
                                   │  3. Draft reply from knowledge.json     │
                                   │  4. Output strict JSON                  │
                                   └──────────────┬──────────────────────────┘
                          LLM (Gemini, OpenAI-compat) │         │ escalation? / contact data?
                             chain: 3.5-flash-lite →  ▼         ▼
                             3.1-flash-lite → 3.8-flash   Graph API reply   notify.js → Resend email
                             (retry ×3 + backoff)         (comment / DM)    + optional webhook
```

**Channels are adapters around one shared engine** — adding WhatsApp/Instagram = new parse+send adapter, engine untouched.

---

## 3. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 18+ (ESM) | simple, fetch-native |
| HTTP | Express 4 | webhook endpoints |
| LLM | Google Gemini via OpenAI-compatible endpoint | free tier, strong Arabic; swappable via `LLM_BASE_URL` |
| Language detect | `franc-min` + custom rules | Arabic fast-path, fragment protection |
| Deploy | Docker + docker-compose, Portainer | `restart: unless-stopped` |
| Tunnel (temp) | cloudflared quick tunnel as sidecar container | until permanent domain lands |
| Email alerts | Resend API | free tier, no SMTP |

No database — state is in-memory (dedupe + per-user rate cap). Swap `src/store.js` for Redis if you ever run multiple replicas.

---

## 4. Repo layout

```
restaurant-page-agent/
├── server.js            # Express entry, rawBody capture for signature check
├── package.json         # express, dotenv, franc-min only
├── knowledge.json       # ★ ALL business data: menus (133 items), 9 branches, meat sources, links
├── docker-compose.yml   # 2 services: restaurant-agent + cloudflared (temp)
├── Dockerfile
├── .env                 # ★ secrets — NEVER commit (gitignored)
├── .env.example         # documented template
├── ARCHITECTURE.md      # this file
├── STATUS.md            # live state, history, pending tasks — READ FIRST
├── DEPLOY.md            # ops quick-start
└── src/
    ├── webhook.js       # intake: verification, feed comments, messaging events, escalation triggers
    ├── agent.js         # AI engine: prompt, LLM chain w/ retry+fallback models, JSON parse
    ├── facebook.js      # Graph API client: comment reply, DM send, typing indicator, name lookup
    ├── lang.js          # language detection (hardened against short-text misdetection)
    ├── knowledge.js     # loads knowledge.json
    ├── notify.js        # staff alerts: email (Resend) + optional webhook
    ├── store.js         # in-memory dedupe + per-user hourly cap
    └── templates.js     # localized fallback replies (used when LLM is unreachable)
```

---

## 5. Request flows

### 5.1 Comment flow
1. Meta POSTs `{object:"page", entry[].changes[]}` with `field:"feed"`, `item:"comment"`, `verb:"add"` → `POST /webhook`
2. Signature verified (`X-Hub-Signature-256`, HMAC of raw body with `FB_APP_SECRET`)
3. Skip: page-authored comments (loop protection), already-replied (dedupe by `comment_id`), per-user cap (30/h default)
4. `analyzeAndDraft({text, authorName, channel:"comment"})` → `{intent, inScope, escalate, reply, lang}`
5. Reply posted: `POST /{comment_id}/comments` with `@[user_id]` mention prepended
6. If `escalate` OR contact-data regex hit → `notifyStaff()` (email + webhook)

### 5.2 Messenger DM flow
1. Meta POSTs `{entry[].messaging[]}` (message events; echoes/delivery/read receipts skipped)
2. Typing indicator sent → first name fetched (`GET /{psid}?fields=first_name`) → `analyzeAndDraft(channel:"dm")`
3. Reply sent: `POST /me/messages` (messaging_type RESPONSE — inside 24h window)
4. Same escalation handling as comments

**Note on DMs:** until Meta App Review approves `pages_messaging` (advanced access), the bot only replies to DMs from app-role accounts (admins/developers). Comments are unrestricted.

### 5.3 LLM chain & failure handling
- Model chain: `LLM_MODEL` → each of `LLM_FALLBACK_MODELS` (comma-separated)
- Per model: 3 attempts with linear backoff on 429/5xx; hard errors skip to next model
- If everything fails → localized **fallback reply** from `templates.js` (guarantee: no comment is ever ignored)

---

## 6. Configuration

### 6.1 Environment variables (`.env` / Portainer stack env)

| Var | Purpose |
|---|---|
| `PORT` | default 3000 |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verification handshake |
| `FB_APP_ID` / `FB_APP_SECRET` | Meta app credentials (signature verification) |
| `FB_GRAPH_VERSION` | e.g. v21.0 |
| `FB_PAGE_ID` | page the bot replies as |
| `FB_PAGE_ACCESS_TOKEN` | page token (long-lived / system-user) |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (Gemini default) |
| `LLM_API_KEY` | LLM key |
| `LLM_MODEL` / `LLM_FALLBACK_MODELS` | primary + comma-separated fallbacks |
| `MAX_REPLIES_PER_USER_PER_HOUR` | anti-abuse cap (30) |
| `STAFF_ALERT_WEBHOOK_URL` | optional webhook for escalations |
| `RESEND_API_KEY` / `STAFF_EMAIL_TO` / `STAFF_EMAIL_FROM` | escalation emails |

### 6.2 `knowledge.json` — the business brain (edit this, never code)

- `restaurantName`, `menuUrl`, `halal`, `location`, `hours`, `delivery`
- `branches[]` — name, area, phone, timings, Google Maps link
- `menus{}` — Breakfast / Lunch & Dinner / Drinks & Dessert → categories → items `{name, price, desc}`
- `meatSources{}` — sourcing transparency
- `agentNotes[]` — behavioral rules injected into the prompt (branch logic, link rules, contact-data rule)

**Menu/price/offer update = edit this file → commit → redeploy. No code changes.**

---

## 7. Deployment & updates (Portainer)

```bash
# standard update flow (content or code):
git push → Portainer → Stacks → restaurant-agent → "Pull and redeploy"
```

⚠️ **TEMPORARY CAVEAT:** the `cloudflared` sidecar gets a **new random URL on every redeploy** while on quick tunnels. After any redeploy you must update the Meta webhook callback URL (App Dashboard → Webhooks → Page, re-enter verify token — or via `POST /{app-id}/subscriptions` with the app token). **This disappears once the permanent subdomain + reverse proxy is in place** (then the `cloudflared` service gets deleted from the compose file).

---

## 8. Operations playbook (every incident we've hit & the fix)

| Symptom | Cause | Fix |
|---|---|---|
| Bot silent, logs show OAuth 190 | Page token dead (password change / security invalidation) | Regenerate token (Graph API Explorer or System User) → update env |
| Replies come as static generic text | LLM unreachable (429/503) | Expected fallback behavior; check `ai.dev/rate-limit`; raise quota/fallback models |
| Bot replies in wrong language | Short-text misdetection (names/phones) | Fixed in `lang.js` (fragment → Arabic default); re-check if new pattern appears |
| No events after redeploy | Tunnel URL changed | Update Meta callback URL (see §7) |
| Duplicate replies | Webhook redelivery | Dedupe by comment_id/mid (already in store.js) |
| Bot replying to itself | from.id == page | Already guarded in webhook.js |

**Monitoring:** `Portainer → Containers → restaurant-page-agent → Logs` — `📩` event, `💬` message, `✅` reply, `🚨` escalation, `⚠️` LLM issue.

---

## 9. Security

- Webhook signature verification (HMAC-SHA256) — unsigned requests rejected
- Secrets only in env (never in repo; `.env` gitignored)
- Bot never replies to itself; never twice to the same comment; hourly per-user cap
- AI constrained to knowledge base facts ("never invent prices/items"); honesty rule — never lies about being automated if asked directly
- Staff alerts fire-and-forget — can never block or break the reply path

---

## 10. Extending

| Task | Effort | Where |
|---|---|---|
| Update menu/prices/offers | 2 min | `knowledge.json` → redeploy |
| Change tone/behavior | 10 min | system prompt in `agent.js` |
| Add second restaurant (Foodex) | ~1 day | multi-page: route by `entry.id`, per-page knowledge + token map |
| Add Instagram DMs/comments | ~1 day | new adapter in webhook.js + Meta app product + `instagram_manage_messages` |
| Add WhatsApp Cloud API | ~2 days + Meta business verification | adapter + WABA + phone number |
| Pass App Review (DMs for everyone) | ~days (Meta) | screencast of the bot working + privacy URL |

---

## 11. Credentials & rotation

- **Page token:** dies on password change of the granting admin. Rotation: Graph API Explorer (page admin) → `fb_exchange_token` → `GET /{page-id}?fields=access_token` → update env. **Permanent fix:** System User token in Business Suite (see STATUS.md §roadmap) — immune to password changes and personal checkpoints.
- **LLM key:** rotate in AI Studio → update `LLM_API_KEY`.
- **Resend key:** resend.com → API Keys.
- **App secret:** Meta App Dashboard → Settings → Basic.

---

## 12. Roadmap (live status in STATUS.md)

1. Restore service after account-security incident (in progress — System User track)
2. Permanent subdomain + remove tunnel sidecar
3. App Review for `pages_messaging` (DMs for all customers)
4. Foodex multi-page support
5. WhatsApp + Instagram channels
