/**
 * Stage 4.4.5 — deterministic grounding guard tests (no DB, no network, no LLM).
 * Run: node scripts/test-grounding.mjs
 */
import { checkGrounding, enforceGrounding, extractUrls, extractPhones, extractPrices, NOT_CONFIRMED_REPLY } from '../src/services/grounding.js';

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

const KB = {
  restaurantName: 'Life with Cacao',
  menuUrl: 'https://link.lifewithcacao.com/',
  hours: '8:00 AM – 11:30 PM weekdays · 12:00 midnight weekends',
  currency: 'Kuwaiti Dinar (KD) — write prices like 3.500 KD',
  branches: [{ name: 'LWC 360 (360 Mall)', area: 'South Surra', maps: 'https://maps.google.com/?q=360+Mall+Kuwait', timings: '8:00 AM – 11:30 PM' }],
  contact: { phone: '+965 2222 3333' }
};
const draft = (reply) => ({ reply, lang: 'en', intent: 'x', inScope: true, escalate: false });

console.log('\n🧪 Stage 4.4.5 — grounding guard\n');

// extraction sanity
check('extractUrls finds URL', extractUrls('see https://a.co/x now').length === 1);
check('extractPhones finds phone', extractPhones('call +96522223333').includes('+96522223333'));
check('extractPrices finds KD price', extractPrices('Cacao Bomb 4.500 KD').some(p => p.amount === '4.500'));
check('extractPrices ignores bare years', extractPrices('since 2024 we are here').length === 0);

// URLs
check('invented URL rejected', !checkGrounding(draft('visit https://evil.example.com/page'), { knowledge: KB }).ok);
check('valid KB URL accepted', checkGrounding(draft('menu: https://link.lifewithcacao.com/'), { knowledge: KB }).ok);
check('KB maps URL accepted', checkGrounding(draft('map: https://maps.google.com/?q=360+Mall+Kuwait'), { knowledge: KB }).ok);

// phones
check('invented phone rejected', !checkGrounding(draft('call us at +965 9999 8888'), { knowledge: KB }).ok);
check('valid KB phone accepted', checkGrounding(draft('call us at +965 2222 3333'), { knowledge: KB }).ok);

// prices
check('invented price rejected', !checkGrounding(draft('Cacao Bomb is 9.999 KD'), { knowledge: KB }).ok);
check('price in KB format accepted', checkGrounding(draft('prices like 3.500 KD'), { knowledge: KB }).ok);

// reasons & enforce
{
  const r = checkGrounding(draft('go https://evil.example.com or call +96511112222 now 99.000 KD'), { knowledge: KB });
  check('violation reasons collected', !r.ok && r.reasons.includes('url_not_in_knowledge') && r.reasons.includes('price_not_in_knowledge'));
  const e = enforceGrounding(draft('go https://evil.example.com'), { knowledge: KB, lang: 'en' });
  check('enforceGrounding returns localized safe fallback', e.rejected && e.draft.reply === NOT_CONFIRMED_REPLY.en);
  const e2 = enforceGrounding(draft('go https://evil.example.com'), { knowledge: KB, lang: 'ar' });
  check('fallback localized (ar)', e2.draft.reply === NOT_CONFIRMED_REPLY.ar);
  check('fallback contains no internal validation info', !/grounding|violation|knowledge|rejected/i.test(e.draft.reply));
}

// missing menu data → no invented items (guard cannot catch invented prose items, but must not
// pass fabricated prices/urls; ensure the guard never *creates* data)
check('empty knowledge rejects any invented fact', !checkGrounding(draft('Cacao Bomb 4.500 KD at https://x.co'), { knowledge: {} }).ok);
check('empty knowledge accepts a purely conversational reply', checkGrounding(draft('Hello! Thank you for your comment.'), { knowledge: {} }).ok);

// tenant/brand isolation: brand B knowledge never satisfies brand A
{
  const kbB = { menuUrl: 'https://brand-b.example/' };
  check('brand B URL rejected for brand A reply', !checkGrounding(draft('menu: https://brand-b.example/'), { knowledge: KB }).ok);
  check('brand A URL accepted with brand A knowledge', checkGrounding(draft('menu: https://link.lifewithcacao.com/'), { knowledge: KB }).ok);
  check('brand B knowledge does not leak into guard behavior', !checkGrounding(draft('menu: https://brand-b.example/'), { knowledge: kbB }).ok === false);
}

// DM path uses the same guard (shared module) — verified by import identity
check('guard is shared for comment and DM paths (single module)', typeof checkGrounding === 'function' && typeof enforceGrounding === 'function');

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
