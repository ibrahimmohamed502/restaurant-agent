# 🍽️ Restaurant Page AI Agent

Auto-replies to **every** Facebook Page comment — in the commenter's own language — following the workflow diagram:

```
FB comment → Webhook → AI Engine (intent + language) → knowledge lookup
  → in-scope?  ──yes──→ precise reply (menu/hours/location/offers)
        │
        └──no──→ polite "out of scope" welcome + clarification reply
  → publish via Graph API (@[user_id] mention + 🤖 AI disclosure + emojis)
  → escalate complex reservations to staff (optional)
```

## Mandatory behaviors (enforced in code, not just prompts)

| Rule | Where |
|---|---|
| Reply to EVERY comment (incl. out-of-scope) | `src/agent.js` scope decision + fallback replies |
| Reply language = comment language | `src/lang.js` (Arabic fast-path + franc) |
| AI identity disclosure in every reply | `src/templates.js` + `hasIdentityDisclosure()` check in `src/agent.js` |
| `@[user_id]` mention + emojis | prepended in `src/webhook.js`, emojis via prompt |

## Setup

### 1. Install & configure
```bash
npm install
copy .env.example .env   # then fill in the values
```

### 2. Meta app (once)
1. [developers.facebook.com](https://developers.facebook.com) → create **Business** app → add **Webhooks** product.
2. Graph API Explorer → generate a token with `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`.
3. Exchange for a long-lived token, then call `/me/accounts` to get the **long-lived Page Access Token** → put it in `.env`.

### 3. Expose the server (dev)
```bash
npm start
npx ngrok http 3000        # or: cloudflared tunnel --url http://localhost:3000
```

### 4. Point Meta at it
- App Dashboard → **Webhooks** → **Page** → Subscribe:
  - Callback URL: `https://<your-ngrok-domain>/webhook`
  - Verify Token: same value as `WEBHOOK_VERIFY_TOKEN` in `.env`
  - Subscribe to field: **`feed`**
- Subscribe your Page to the app:
```bash
curl -X POST "https://graph.facebook.com/v21.0/PAGE_ID/subscribed_apps?subscribed_fields=feed&access_token=PAGE_ACCESS_TOKEN"
```

### 5. Test
- Sanity-check verification locally:
```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=123"
# → should print: 123
```
- Post a real comment from a **different Facebook account** on one of your Page's posts (e.g. "ما هي مواعيد العمل؟" or "what time do you close?") and watch the logs.

## Customize the restaurant
Edit **`knowledge.json`** — menu, hours, location, offers, policies. No code changes needed; the agent is instructed to answer **only** from this data.

## Safety rails built in
- Never replies to the Page's own comments (no loops) and never twice to the same comment.
- `X-Hub-Signature-256` verification when `FB_APP_SECRET` is set.
- Anti-abuse hourly cap (`MAX_REPLIES_PER_USER_PER_HOUR`) — genuine commenters always get a reply.
- Complex reservations/complaints → reply + `STAFF_ALERT_WEBHOOK_URL` notification.
- LLM outage → localized fallback reply is still posted (the guarantee holds).

## Production notes
- Run behind HTTPS with a process manager (`pm2 start server.js`).
- Set `FB_APP_SECRET` — don't skip signature verification in production.
- While your Meta app is in **Development mode**, it works for Pages you administer — no App Review needed.

## 🐳 Docker (24/7 deployment)

```bash
docker compose up -d --build     # build + start, auto-restarts on crash/reboot
docker compose logs -f           # watch the agent work
docker compose down              # stop
```

Notes:
- `.env` is passed at runtime via `env_file` — it is **never baked into the image** (it's in `.dockerignore`).
- The container listens on port 3000. Put it behind HTTPS (e.g. **Caddy**: one line — `your-domain.com { reverse_proxy localhost:3000 }`), then update the Meta webhook Callback URL and the Privacy Policy URL (`/privacy`) to your permanent domain.
- Works on any Docker host: a VPS (Hetzner/DigitalOcean), a home server / NAS / Raspberry Pi that stays on, or cloud platforms that accept a Dockerfile (Railway, Render).
