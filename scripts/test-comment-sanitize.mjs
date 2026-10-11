/**
 * Focused regression — Meta rejects public comment replies containing URLs
 * (Graph error code 1). The comment path must strip link lines; Messenger keeps them.
 * Run: node scripts/test-comment-sanitize.mjs
 */
process.env.DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.WEBHOOK_QUEUE_MODE = 'inline';

const { sanitizeCommentMessage } = await import('../src/webhook.js');

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

console.log('\n🧪 comment reply URL sanitization\n');

const MENU_LINK_LINE = '📋 تصفح المنيو كامل من هنا: https://link.lifewithcacao.com/';
const sample = [
  'وعليكم السلام ورحمة الله وبركاته يا إبراهيم، منورنا!',
  '',
  'أنصحك تجرب من الأطباق المميزة عندنا:',
  '',
  '⭐ ساندويتش كاكاو كلوب — 4.750 د.ك',
  '⭐ بيني بينك باستا — 5.500 د.ك',
  '',
  MENU_LINK_LINE
].join('\n');

const out = sanitizeCommentMessage(sample);
check('strips the URL line entirely (no dangling label)', !out.includes('link.lifewithcacao.com') && !out.includes('📋'));
check('keeps business content: greeting, dishes and prices', out.includes('وعليكم السلام') && out.includes('4.750') && out.includes('بيني بينك باستا'));
check('keeps the text deliverable (non-empty)', out.length > 20);
check('collapses excess blank lines', !/\n{3,}/.test(out));

const noUrls = sanitizeCommentMessage('سعر الكاكاو بوم 4.650 د.ك فقط.');
check('leaves URL-free replies untouched', noUrls === 'سعر الكاكاو بوم 4.650 د.ك فقط.');

const onlyUrl = sanitizeCommentMessage('القائمة: https://x.com/menu');
check('never returns an empty message (safe fallback)', onlyUrl.length > 0 && !onlyUrl.includes('https://'));

const httpLink = sanitizeCommentMessage('تفضل http://example.com/x');
check('strips http:// links too', !httpLink.includes('http://example.com'));

// phone numbers / prices are preserved (business data, not links)
const contact = sanitizeCommentMessage('الهاتف: +965 1234 5678 — سعر 4.650');
check('preserves phone numbers and prices', contact.includes('+965 1234 5678') && contact.includes('4.650'));

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
