import 'dotenv/config';
import express from 'express';
import { webhookRouter } from './src/webhook.js';
import { dashboardRouter } from './src/dashboard.js';
import { migrate } from './src/db/migrate.js';
import { seedIfEmpty } from './src/db/seed.js';

const app = express();

// Parse JSON and keep the RAW body — required for X-Hub-Signature-256 verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use(webhookRouter);
app.use(dashboardRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// Privacy policy — required by Meta to switch the app to Live mode
app.get('/privacy', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Privacy Policy — Restaurant Bot</title></head>
<body style="font-family: sans-serif; max-width: 720px; margin: 40px auto; line-height: 1.7;">
  <h1>Privacy Policy — Restaurant Bot</h1>
  <p><em>Last updated: October 2026</em></p>
  <h2>What this app does</h2>
  <p>Restaurant Bot is an automated assistant for a Facebook Page managed by the page owner.
     It reads comments posted publicly on the page and posts helpful automated replies on behalf of the page.</p>
  <h2>Data we process</h2>
  <ul>
    <li>The text of public comments posted on the page.</li>
    <li>The commenter's name and app-scoped user ID, used only to mention/tag the commenter in the reply.</li>
  </ul>
  <h2>How we use it</h2>
  <p>Comment text is sent to an AI language model (Google Gemini) solely to generate a relevant reply.
     We do not sell, share, or store personal data beyond transient processing required to post the reply.</p>
  <h2>Data retention & deletion</h2>
  <p>Comment IDs are kept in memory for up to 24 hours only to avoid duplicate replies, then deleted.
     To request deletion of any data, contact the page administrator or email:
     ibrahimmohamedahmed502@gmail.com</p>
  <h2>Contact</h2>
  <p>For any privacy question, message the Facebook Page directly or email the address above.</p>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🍽️  Restaurant Page AI Agent listening on port ${PORT}`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);

  // Stage 1: database layer — runs migrations + first-time seed (never double-seeds).
  // Skipped silently when DATABASE_URL is not set (legacy JSON mode).
  try {
    const migrated = await migrate();
    if (migrated) await seedIfEmpty();
  } catch (err) {
    console.error('❌ DB init failed (app continues in legacy mode):', err.message);
  }
});
