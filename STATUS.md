# 📋 STATUS — حالة المشروع (آخر تحديث: 5 أكتوبر 2026 — قناتين LIVE ✅✅)

> اقرأ الملف ده في أول أي جلسة جديدة عشان تكمل من حيث توقفنا.
> المستخدم: إبراهيم — بيفضل الشرح بالعربي (مصري)، خطوة-بخطوة، ومستواه مبتدئ تقنياً.

## 🎯 المشروع
بوت رد آلي ذكي (AI Agent) على تعليقات صفحات فيسبوك — Node.js/Express + Google Gemini + Meta Graph API.
بيرد على **كل** تعليق، **بنفس لغته**، مع **منشن** وإيموجيز، وردود دقيقة من `knowledge.json` فقط (ممنوع يخترع معلومات).
الكود: الفولدر ده + GitHub repo (github.com/ibrahimmohamed502/restaurant-agent — عام).

## ✅ LIVE حالياً على: Life with Cacao 🍫 (المطعم الحقيقي!)
- **الصفحة:** Life with Cacao — Page ID `237391687793` — الكويت 🇰🇼
- **الحالة:** شغال ومُختبَر لايف على الصفحة الحقيقية (رد بمنيو حقيقي بنجاح ✅ — 4 أكتوبر)
- **المنيو:** `knowledge.json` = المنيو الحقيقي الكامل — 133 صنف (Breakfast / Lunch & Dinner / Drinks & Dessert) + 11 مصدر لحوم للشفافية + كل الأكل حلال. ⭐ ناقص: المواعيد/العنوان/التوصيل/التليفون (TBD — المستخدم هيبعتهم)
- **التوكين:** Page Token **بلا انتهاء** لصفحة كاكاو (مشتق من Long-Lived token لأكونت المطعم "Elite-it AI-Bot" — الأكونت Admin في التطبيق وفي الصفحة). محفوظ في `.env` و Portainer env.
- **الاستضافة:** Docker على VPS الشركة عبر Portainer — stack `restaurant-agent` (كونتينران: `restaurant-page-agent` + `restaurant-tunnel`) — يشتغل 24/7 بدون اللابتوب ✅
- **الوصول العام (مؤقت):** `https://power-apply-cite-succeed.trycloudflare.com` — ⚠️ **بيتغيّر مع أي redeploy! ممنوع "Pull and redeploy" إلا وإحنا مستعدين نحدّث اللينك في فيسبوك بعدها**
- **تطبيق Meta:** "Restaurant Bot" — App ID `1673966207646736` — **Live** (متقفلوش أبداً). الأدمنز: الأكونت التجريبي (ابراهيم) + أكونت المطعم (Elite-it AI-Bot, ID `61595034693541`)
- **Verify token:** `my_restaurant_bot_secret_2026` — ⚠️ فيسبوك بتطلب إعادة كتابته يدوياً عند أي تعديل لينك
- **LLM:** Gemini — `gemini-3.8-flash` + fallback `gemini-3.7-flash` (فيه retry ضد 503)
- **صفحة التجربة CV Elite Hub:** اتفصلت (unsubscribed) ✅

## ✅ النسخة النهائية المنشورة (4 أكتوبر — مساءً)
- **الأسلوب البشري منشور ✅:** مفيش بانر AI — ردود طبيعية بأسلوب موظف سوشيال ميديا + HONESTY RULE (ممنوع يكذب لو اتسأل "إنت بوت؟")
- **تنسيق الردود ✅:** تحية باسم العميل الأول + سطور منفصلة + أصناف بإيموجي بوليتس + أسعار ("4.750 د.ك" / "KD 4.750") + ممنوع هاشتاجات/لينكات
- **لينك المنيو في آخر كل رد ✅:** https://link.lifewithcacao.com/ بجملة دعوة متنوعة
- **9 فروع ✅:** مضافين في knowledge.json بالأرقام والمواعيد — البوت بيرد على "أقرب فرع/رقم الفرع/المواعيد" (بيسأل العميل عن منطقته)
- **التونل الحالي:** `https://declare-emperor-roulette-voters.trycloudflare.com` (اتحدّث في فيسبوك ✅)

## 🚧 Stage 4 (in progress) — Provider Abstraction + Multi-Page Routing

### ✅ Stage 4.1 — Channel Resolver (DONE, awaiting review)
- **`src/services/channelResolver.js`** — `resolveMetaChannel(pageId)`: incoming `entry.id` → channel (`provider='meta'`, `external_id=pageId`) → tenant/brand من صف القناة → credential مشفر (`provider_credentials` scoped بـ `channel_id + tenant_id`)
- **Strict fail-safe:** `UNKNOWN_META_PAGE` (مجهول — صفر auto-routing لـ UFC) / `CHANNEL_INACTIVE` (معطل) / `CREDENTIAL_MISSING`
- التوكين المفكك **مش بيتعرض** في logs/errors/debug — بيرجع بس لما `includeCredential:true` (استخدام داخلي للإرسال)
- بيستخدم تشفير Stage 1 (AES-256-GCM) — مفيش نظام تشفير تاني
- **مش wired في الـ webhook بعد** — البوت الحالي (CV) شغال زي ما هو بدون أي تغيير
- **`scripts/test-channelResolver.mjs`** — 11/11 unit tests ناجحة (mocked db، بتشتغل محلياً بدون deploy): known/unknown page، tenant/brand صح، credential صح، inactive، missing credential، cross-tenant isolation، no-secret-in-errors، not-wired
- ملاحظة لـ 4.2: قناة routing canonical هي `provider='meta'` (مش meta_comment/meta_dm اللي بيجمعوا المحادثات في الـ Inbox) — القناة بتاعت CV `provider='meta'` لازم تتزرع قبل التوصيل الفعلي
- **لم يتم نشره للإنتاج بعد** (مش wired) — Stage 4 لسه جارية، مش مكتملة

## ✅ قناة الماسنجر LIVE (5 أكتوبر)
- **رسايل الدي إم شغالة ومُختبرة** من حساب أدمن التطبيق ✅ (typing indicator + ردود كويتية + لينك المنيو بس في مواضيع الأكل)
- **الكود:** `webhook.js` فيه channel 2 (entry.messaging — بيتخطى echoes/receipts) + `facebook.js` فيه sendMessengerReply/sendTypingIndicator/getUserFirstName + `agent.js` فيه channel param (comment vs dm)
- **التوكين:** نفس النص القديم — صلاحياته اتوسعت بـ `pages_messaging` (debug_token أكدها) — **مش احتجنا نغيّر env**
- **الاشتراكات:** الصفحة مشتركة في feed+messages (page level) + التطبيق محدّث لـ feed+messages على اللينك الجديد `https://arranged-recording-norm-visit.trycloudflare.com` (app level عبر API POST /{app-id}/subscriptions)
- **LLM الجديد:** `gemini-3.5-flash-lite` (500/يوم) + fallback `gemini-3.1-flash-lite` (500) + `gemini-3.8-flash` (20) ≈ **1020 رد مجاني/يوم** — بدل 20!
- **اللهجة الكويتية** في كل الردود العربية + الرد الاحتياطي كويتي

## 🗓️ المهام الجاية — بالترتيب
1. **App Review لـ pages_messaging (الأهم للماسنجر):** حالياً الـ DM بيرد بس على حسابات أدوار التطبيق (Admin/Dev). عشان **العملاء الحقيقيين** يوصلهم رد الماسنجر لازم Meta توافق: App Dashboard → Messenger → Request permission (pages_messaging). المطلوب: فيديو قصير للبوت شغال + وصف الاستخدام + **لينك privacy ثابت** (مربوط بالدومين — نقطة 2). التعليقات العامة مش محتاجة مراجعة (شغالة للكل ✅).
2. **دومين الشركة من الباشمهندس:** لما يجي → Callback URL + Privacy URL → مسح cloudflared → redeploy أخيرة. ⚠️ مهم للـ App Review كمان (لينك ثابت).
3. **معلومة ناقصة:** التوصيل (delivery) لسه TBD في knowledge.json
4. **مطعم تاني: Foodex** — multi-page refactor (نفس الخطة المسجلة فوق)
5. **قنوات إضافية لاحقاً:** إنستجرام (IG professional مربوط بالصفحة) ← واتساب Cloud API (WABA + business verification + رقم فاضي)
6. **تنضيف اختياري:** شيل الأكونت التجريبي من App roles.

## 🎬 مشروع جانبي مؤجل (سيشن منفصلة لاحقاً)
- موضوع توليد فيديوهات بقصص مصرية — مؤجل بطلب المستخدم
- السيناريو الجاهز محفوظ في: `Documents\Default Project\series-script-om-salem.md` (مسلسل "كافيه عمو سالم" — حلقة 1، 8 مشاهد بكروت شخصيات وبرومبتات وحوارات)
- الخلاصة البحثية: أدوات one-click كلها مدفوعة بتذوق محدود — الطريق المجاني الحقيقي = CapCut (مجاني + TTS عربي) + Bing Video Creator (مجاني مبني على Sora) + Edge TTS ar-EG للصوت المصري + Kling/Hailuo لليب سينك. الشخصيات البشرية الواقعية: HeyGen أو Kling Lip Sync.

## 🔧 ملاحظات تقنية سريعة
- الأسرار في `.env` (محلي فقط) و Portainer env — ممنوع GitHub (موجود في `.gitignore`)
- لوج البوت: Portainer → Containers → `restaurant-page-agent` → Logs (📩 💬 ✅)
- دروس اتعلمناها: توكينات قصيرة العمر بتموت (دايماً Long-Lived flow) • الاشتراك في الداشبورد لازم يكون تحت "Page" مش "User" • subscribed_apps محتاجة صلاحية `pages_manage_metadata` • أي redeploy = لينك تونل جديد
- كشف اللغة: عربي/إنجليزي/فرنسي... (franc-min + fast path للعربي) — الرد بنفس لغة التعليق
