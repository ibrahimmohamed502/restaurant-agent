import { describe, expect, it } from 'vitest';
import { validateKnowledge, diffKnowledge } from '../../src/services/knowledge.js';

type KbError = { section: string; path: string; field: string | null; messageKey: string };

describe('Stage 5 knowledge validation', () => {
  const valid = {
    restaurantName: 'Life with Cacao',
    menuUrl: 'https://link.lifewithcacao.com/',
    menus: {
      'Drinks & Dessert Menu': {
        'Cacao Signature Dessert': [{ name: 'Cacao Bomb', price: '4.650' }]
      }
    },
    branches: [{ name: 'LWC 360 (360 Mall)', maps: 'https://maps.google.com/?q=360+Mall', timings: '8:00 AM – 11:30 PM' }]
  };

  it('accepts a valid knowledge document', () => {
    expect(validateKnowledge(valid).ok).toBe(true);
  });

  it('rejects missing restaurant name', () => {
    const r = validateKnowledge({ ...valid, restaurantName: '' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ section: 'overview', field: 'name', messageKey: 'required' });
  });

  it('rejects invalid menu URL', () => {
    const r = validateKnowledge({ ...valid, menuUrl: 'not-a-url' });
    expect(r.errors.some((e: KbError) => e.messageKey === 'invalid_url')).toBe(true);
  });

  it('rejects malformed prices and accepts KD precision', () => {
    const bad = validateKnowledge({ ...valid, menus: { A: { B: [{ name: 'X', price: '4.65.0' }] } } });
    expect(bad.errors.some((e: KbError) => e.section === 'menu' && e.messageKey === 'invalid_price')).toBe(true);
    expect(validateKnowledge({ ...valid, menus: { A: { B: [{ name: 'X', price: '4.650' }] } } }).ok).toBe(true);
  });

  it('rejects missing item names and empty prices', () => {
    const r = validateKnowledge({ ...valid, menus: { A: { B: [{ name: '', price: '' }] } } });
    expect(r.errors.filter((e: KbError) => e.section === 'menu').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects duplicate branch names and invalid branch URLs/phones', () => {
    const dup = validateKnowledge({ ...valid, branches: [{ name: 'X' }, { name: 'x' }] });
    expect(dup.errors.some((e: KbError) => e.messageKey === 'duplicate')).toBe(true);
    const bad = validateKnowledge({ ...valid, branches: [{ name: 'X', maps: 'nope', phone: '12' }] });
    expect(bad.errors.some((e: KbError) => e.messageKey === 'invalid_url')).toBe(true);
    expect(bad.errors.some((e: KbError) => e.messageKey === 'invalid_phone')).toBe(true);
  });

  it('rejects a non-object knowledge root', () => {
    expect(validateKnowledge(null).ok).toBe(false);
    expect(validateKnowledge([]).errors[0].messageKey).toBe('invalid_structure');
  });

  it('diff reports added/modified/removed for the preview step', () => {
    const prev = { restaurantName: 'A', menus: { C: { S: [{ name: 'X', price: '1.000' }] } }, branches: [{ name: 'B1' }] };
    const next = { restaurantName: 'B', menus: { C: { S: [{ name: 'X', price: '2.000' }, { name: 'Y', price: '3.000' }] } }, faqs: [{ question: 'q', answer: 'a' }] };
    const d = diffKnowledge(prev, next);
    expect(d.counts.modified).toBeGreaterThanOrEqual(1);
    expect(d.counts.added).toBeGreaterThanOrEqual(1);
    expect(d.counts.removed).toBeGreaterThanOrEqual(1);
    expect(d.bySection.menu.modified).toBeGreaterThanOrEqual(1);
  });
});
