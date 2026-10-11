/**
 * Stage 6 Batch 1 — chunking unit tests (no DB, no network).
 * Run: node scripts/test-knowledge-chunking.mjs
 */
const { chunkKnowledge } = await import('../src/services/knowledgeChunking.js');
const { EMBEDDING_CONFIG } = await import('../src/services/embeddings.js');

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); } };

console.log('\nStage 6 Batch 1 — chunking + embedding config\n');

const knowledge = {
  restaurantName: 'Life with Cacao',
  about: 'Café & dessert restaurant in Kuwait',
  menuUrl: 'https://link.lifewithcacao.com/',
  currency: 'Kuwaiti Dinar (KD)',
  menus: {
    'Drinks & Dessert Menu': {
      'Cacao Signature Dessert': [
        { name: 'Cacao Bomb', name_ar: 'كاكاو بوم', price: '4.650', desc: 'signature molten cake' }
      ]
    }
  },
  branches: [
    { name: 'LWC 360 (360 Mall)', area: '360 Mall', timings: '8:00 AM – 11:30 PM', phone: '+965 1234 5678', maps: 'https://maps.google.com/?q=360' }
  ],
  faqs: [{ question: 'Do you deliver?', answer: 'Staff will confirm.' }],
  meatSources: 'Certified halal suppliers',
  halal: 'All food is 100% halal',
  reservations: 'Walk-ins welcome.'
};

const chunks = chunkKnowledge(knowledge);
const keys = chunks.map((c) => c.key);

check('chunks are produced', chunks.length >= 6);
check('menu item chunk carries name/ar/desc/price/menuUrl verbatim', keys.includes('menu/Drinks & Dessert Menu/Cacao Signature Dessert/Cacao Bomb')
  && chunks.find((c) => c.section === 'menu').content.includes('4.650 KD')
  && chunks.find((c) => c.section === 'menu').content.includes('كاكاو بوم')
  && chunks.find((c) => c.section === 'menu').content.includes('https://link.lifewithcacao.com/'));
check('branch chunk carries hours/phone/map', chunks.some((c) => c.section === 'branches' && c.content.includes('+965 1234 5678') && c.content.includes('8:00 AM')));
check('faq + policy chunks exist', chunks.some((c) => c.section === 'faq' && c.content.includes('deliver')) && chunks.some((c) => c.section === 'policies' && c.content.includes('halal')));
check('chunk keys are unique + deterministic', new Set(keys).size === keys.length && JSON.stringify(chunkKnowledge(knowledge).map((c) => c.key)) === JSON.stringify(keys));
check('empty knowledge produces zero chunks', chunkKnowledge({}).length === 0);
check('embedding config = gemini-embedding-001 / 768 dims', EMBEDDING_CONFIG.model === 'gemini-embedding-001' && EMBEDDING_CONFIG.dims === 768);

console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
