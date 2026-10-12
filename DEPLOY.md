# تعليمات التشغيل — Restaurant Page AI Agent 🍽️🤖
### (للفريق التقني / مسؤول السيرفر)

بوت رد آلي على تعليقات صفحة فيسبوك (Node.js + Express + Gemini AI).
المشروع **Docker-ready** بالكامل — التشغيل أمر واحد.

---

## المتطلبات
- Docker + Docker Compose على السيرفر (موجودين ✅)
- دومين أو subdomain موجّه على الـ reverse proxy بتاعكو بـ HTTPS
  (مثال: `bot.restaurant.com`) — فيسبوك تشترط HTTPS للـ webhooks

## التشغيل (أي طريقة تريّحك)

**أ) من الفولدر مباشرة (الأسرع):**
```bash
# انسخ الفولدر على السيرفر (scp/sftp/git — حسب راحتك)
cd restaurant-page-agent
docker compose up -d --build
docker compose logs -f   # للمتابعة — لازم تشوف سطر "listening on port 3000"
```

**ب) من Portainer:**
Stacks → Add stack → ارفع/الصق `docker-compose.yml` + ملف `.env`
في قسم Environment variables → Deploy.
(أو Git repository stack لو حبيت تربطه بريبو للتحديثات التلقائية)

**ج) إعادة التحديث بعد أي تعديل في الكود أو knowledge.json:**
```bash
docker compose up -d --build        # أو زرار "Pull and redeploy" في Portainer
```

## الـ Reverse Proxy
وجّه الدومين على `localhost:3000`. لو مفيش proxy جاهز، Caddy بسطر واحد:
```
bot.restaurant.com {
    reverse_proxy localhost:3000
}
```

## بعد التشغيل — خطوتين في Meta (عند صاحب المشروع)
1. App Dashboard → Webhooks → Page → Callback URL:
   `https://<الدومين>/webhook` — Verify Token: موجود في `.env` (`WEBHOOK_VERIFY_TOKEN`)
2. Settings → Basic → Privacy policy URL: `https://<الدومين>/privacy`
   (صفحة سياسة الخصوصية جاهزة ومستضافة جوه السيرفر نفسه)

## فحص سريع بعد التشغيل
```bash
curl https://<الدومين>/health        # → {"status":"ok"}
curl "https://<الدومين>/webhook?hub.mode=subscribe&hub.verify_token=<WEBHOOK_VERIFY_TOKEN>&hub.challenge=123"
# لازم يرجع: 123
```

## ملاحظات
- `.env` فيه كل الأسرار (توكنات فيسبوك + مفتاح Gemini) — متبعتش الملف على قناة عامة
- اللوجز: كل تعليق بيسجل (النية، اللغة، inScope) — مفيدة جداً للمتابعة
- المنيو/الأسعار/العروض: `knowledge.json` — عدّل و redeploy، مفيش كود
- الكونتينر `restart: unless-stopped` — بيرجع يشتغل لوحده بعد أي ريبوت
