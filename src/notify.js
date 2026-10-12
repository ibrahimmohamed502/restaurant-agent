/**
 * Staff alerts — fired on escalations (complaints, collaborations, complex
 * reservations) and whenever a customer shares contact details.
 *
 * Two independent channels, both optional:
 *  1. STAFF_ALERT_WEBHOOK_URL — any webhook (Slack, Discord, Zapier, Make…)
 *  2. Email via Resend (https://resend.com — free tier 100 emails/day):
 *       RESEND_API_KEY + STAFF_EMAIL_TO (comma-separated for multiple recipients)
 */

export async function notifyStaff(info) {
  console.warn('🚨 ESCALATION — staff follow-up needed:', JSON.stringify(info, null, 2));
  await Promise.allSettled([sendWebhookAlert(info), sendEmailAlert(info)]);
}

/* ------------------------------ Channel 1: Webhook ------------------------------ */
async function sendWebhookAlert(info) {
  const url = process.env.STAFF_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'staff_escalation', ...info })
    });
    console.log('📨 Staff webhook alert sent');
  } catch (e) {
    console.error('Staff webhook failed:', e.message);
  }
}

/* ------------------------------ Channel 2: Email (Resend) ------------------------------ */
async function sendEmailAlert(info) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.STAFF_EMAIL_TO;
  if (!apiKey || !to) return;

  const from = process.env.STAFF_EMAIL_FROM || 'LWC Bot <onboarding@resend.dev>';
  const subject = `🚨 Life with Cacao — ${info.reason || 'عميل محتاج متابعة'}`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        from,
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        subject,
        html: buildEmailHtml(info)
      })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`📧 Staff email failed ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    console.log(`📧 Staff email sent → ${to}`);
  } catch (e) {
    console.error('📧 Staff email error:', e.message);
  }
}

function buildEmailHtml(info) {
  const safe = (s) => String(s ?? '').replace(/</g, '&lt;');
  const row = (k, v) =>
    v
      ? `<tr><td style="padding:6px 12px;color:#777;vertical-align:top">${k}</td><td style="padding:6px 12px;font-weight:600">${safe(v)}</td></tr>`
      : '';

  return `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:580px;margin:auto;border:1px solid #eee;border-radius:12px;overflow:hidden">
    <div style="background:#4a2c17;color:#fff;padding:16px 20px;font-size:18px;font-weight:bold">
      🍫 Life with Cacao — تنبيه من الـ AI Agent
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${row('القناة', info.channel)}
      ${row('العميل', info.customerName || info.from?.name || info.from?.id)}
      ${row('معرّف المستخدم', info.from?.id)}
      ${row('السبب', info.reason)}
      ${row('النية المكتشفة', info.draft?.intent)}
      ${row('اللغة', info.draft?.lang)}
      ${row('الوقت', new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait' }) + ' (Kuwait)')}
    </table>
    <div style="padding:14px 20px;background:#faf7f2;font-size:14px;white-space:pre-wrap;line-height:1.8">
      <b>رسالة العميل:</b><br>${safe(info.message) || '(بدون نص — صورة/ملصق)'}
    </div>
    <div style="padding:14px 20px;background:#fff8e6;font-size:14px">
      <b>رد البوت:</b><br>${safe(info.draft?.reply)}
    </div>
    <div style="padding:14px 20px;font-size:13px;color:#666">
      ⚡ يرجى التواصل مع العميل في أقرب وقت. — Restaurant Page AI Agent
    </div>
  </div>`;
}
