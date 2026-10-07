/**
 * Tiny JSON-file persistence for the dashboard (zero native deps — Docker-safe).
 * Stores recent activity events + escalations. Capped lists; writes are atomic-ish
 * (write to temp file then rename). Scale target: hundreds of events/day.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = path.join(DATA_DIR, 'dashboard.json');
const TMP_FILE = DB_FILE + '.tmp';

const MAX_EVENTS = 500;
const MAX_ESCALATIONS = 200;

let db = { events: [], escalations: [] };

function load() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(DB_FILE)) {
      const parsed = JSON.parse(readFileSync(DB_FILE, 'utf8'));
      if (Array.isArray(parsed.events)) db.events = parsed.events;
      if (Array.isArray(parsed.escalations)) db.escalations = parsed.escalations;
    }
  } catch (e) {
    console.error('⚠️ db load failed, starting fresh:', e.message);
  }
}

function save() {
  try {
    writeFileSync(TMP_FILE, JSON.stringify(db));
    renameSync(TMP_FILE, DB_FILE);
  } catch (e) {
    console.error('⚠️ db save failed:', e.message);
  }
}

load();

/** Record a handled customer interaction (comment or DM). */
export function logEvent(e) {
  db.events.unshift({
    ts: Date.now(),
    channel: e.channel, // 'comment' | 'messenger'
    customerName: e.customerName || e.customerId || 'غير معروف',
    customerId: e.customerId || '',
    message: (e.message || '').slice(0, 400),
    reply: (e.reply || '').slice(0, 600),
    intent: e.intent || 'unknown',
    inScope: e.inScope !== false,
    lang: e.lang || '?',
    escalate: e.escalate === true
  });
  if (db.events.length > MAX_EVENTS) db.events.length = MAX_EVENTS;
  save();
}

/** Record an escalation (complaint / collab / reservation / contact-data). Returns id. */
export function addEscalation(e) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  db.escalations.unshift({
    id,
    ts: Date.now(),
    channel: e.channel,
    customerName: e.customerName || e.customerId || 'غير معروف',
    customerId: e.customerId || '',
    message: (e.message || '').slice(0, 400),
    reply: (e.reply || '').slice(0, 600),
    reason: e.reason || 'تصعيد',
    status: 'new' // 'new' | 'done'
  });
  if (db.escalations.length > MAX_ESCALATIONS) db.escalations.length = MAX_ESCALATIONS;
  save();
  return id;
}

export function listEvents(limit = 50) {
  return db.events.slice(0, limit);
}

export function listEscalations() {
  return db.escalations;
}

export function resolveEscalation(id) {
  const esc = db.escalations.find((x) => x.id === id);
  if (!esc) return false;
  esc.status = 'done';
  save();
  return true;
}

export function getStats() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const start = dayStart.getTime();
  const todayEvents = db.events.filter((e) => e.ts >= start);

  const byIntent = {};
  const byLang = {};
  for (const e of todayEvents) {
    byIntent[e.intent] = (byIntent[e.intent] || 0) + 1;
    byLang[e.lang] = (byLang[e.lang] || 0) + 1;
  }

  return {
    today: {
      total: todayEvents.length,
      comments: todayEvents.filter((e) => e.channel === 'comment').length,
      dms: todayEvents.filter((e) => e.channel === 'messenger').length,
      escalations: todayEvents.filter((e) => e.escalate).length
    },
    allTime: { events: db.events.length, escalations: db.escalations.length },
    newEscalations: db.escalations.filter((x) => x.status === 'new').length,
    byIntent: Object.entries(byIntent).sort((a, b) => b[1] - a[1]).slice(0, 6),
    byLang
  };
}
