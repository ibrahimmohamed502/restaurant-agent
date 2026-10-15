import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { MenuEditor, selectSubcategories, type MenuStructure } from '@/components/kb/menu-editor';
import en from '@/messages/en.json';

/**
 * Regression coverage for the "Add Subcategory accepts a name but the
 * subcategory does not appear" defect.
 *
 * Root cause: the subcategory visibility filter dropped every subcategory with
 * zero items, so a freshly created subcategory was stored (and saved) but never
 * rendered — and because "Add item" only exists inside a rendered subcategory
 * header, the user could not add its first item.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

const noop = () => {};

/** Mirrors a category created in the UI: a default "عام" subcategory, empty. */
const freshCategory: MenuStructure = { 'New category': { 'عام': [] } };
/** Mirrors the reported production state: owner-created category + subcategory. */
const ownerState: MenuStructure = { mmmmmmm: { mnnnnnnnnnnnn: [] } };
/** Existing published-style knowledge: subcategories that already hold items. */
const populated: MenuStructure = {
  Drinks: { Hot: [{ name: 'Coffee', price: '1.500' }], Cold: [] }
};

describe('MenuEditor — empty subcategories stay visible', () => {
  it('renders an empty subcategory (the exact reported defect)', () => {
    const html = render(<MenuEditor menus={ownerState} readOnly={false} onChange={noop} />);
    expect(html).toContain('mmmmmmm');        // category
    expect(html).toContain('mnnnnnnnnnnnn');  // empty subcategory — was hidden before the fix
    expect(html).not.toContain('No matching items.');
  });

  it('renders the default subcategory created with a new category', () => {
    const html = render(<MenuEditor menus={freshCategory} readOnly={false} onChange={noop} />);
    expect(html).toContain('New category');
    expect(html).toContain('عام');
  });

  it('keeps "Add item" accessible inside an empty subcategory', () => {
    const html = render(<MenuEditor menus={ownerState} readOnly={false} onChange={noop} />);
    expect(html).toContain('Add item');        // only exists inside a rendered subcategory header
    expect(html).toContain('Add category');
    expect(html).toContain('Subcategory');     // add-subcategory control
  });

  it('still hides edit controls in read-only mode (empty subcategory stays visible)', () => {
    const html = render(<MenuEditor menus={ownerState} readOnly onChange={noop} />);
    expect(html).toContain('mnnnnnnnnnnnn');
    expect(html).not.toContain('Add item');
  });

  it('keeps subcategories that already contain items visible', () => {
    const html = render(<MenuEditor menus={populated} readOnly onChange={noop} />);
    expect(html).toContain('Drinks');
    expect(html).toContain('Hot');
    expect(html).toContain('Coffee');
    expect(html).toContain('1.500');
  });

  it('shows empty and populated subcategories side by side', () => {
    const html = render(<MenuEditor menus={populated} readOnly={false} onChange={noop} />);
    expect(html).toContain('Hot');    // populated
    expect(html).toContain('Coffee');
    expect(html).toContain('Cold');   // empty, added afterwards
  });
});

describe('selectSubcategories — data structure and search behaviour', () => {
  it('returns the Category → Subcategory → Item structure unchanged', () => {
    const rows = selectSubcategories(populated, 'Drinks', '');
    expect(rows.map(([sub]) => sub)).toEqual(['Hot', 'Cold']);
    expect(rows[0][1]).toHaveLength(1);
    expect(rows[0][1][0].name).toBe('Coffee');
    expect(rows[1][1]).toEqual([]);
    // input is never mutated
    expect(Object.keys(populated.Drinks)).toEqual(['Hot', 'Cold']);
  });

  it('keeps empty subcategories visible when there is no query', () => {
    expect(selectSubcategories(freshCategory, 'New category', '').map(([s]) => s)).toEqual(['عام']);
    expect(selectSubcategories(freshCategory, 'New category', '   ').map(([s]) => s)).toEqual(['عام']);
  });

  it('preserves search filtering (only matching subcategories, noise suppressed)', () => {
    expect(selectSubcategories(populated, 'Drinks', 'coffee').map(([s]) => s)).toEqual(['Hot']);
    expect(selectSubcategories(populated, 'Drinks', 'zzz')).toEqual([]);
    expect(selectSubcategories(populated, 'Drinks', '').map(([s]) => s)).toEqual(['Hot', 'Cold']);
  });

  it('returns nothing for an unknown or missing category', () => {
    expect(selectSubcategories(populated, null, '')).toEqual([]);
    expect(selectSubcategories(populated, 'Missing', '')).toEqual([]);
  });
});

describe('MenuEditor — saved content survives a reload', () => {
  it('still shows an empty subcategory after re-rendering the saved payload', () => {
    // what Save Draft round-trips through the API and GET /knowledge
    const saved = JSON.parse(JSON.stringify(ownerState)) as MenuStructure;
    const html = render(<MenuEditor menus={saved} readOnly={false} onChange={noop} />);
    expect(html).toContain('mmmmmmm');
    expect(html).toContain('mnnnnnnnnnnnn');
    expect(html).toContain('Add item');
  });

  it('shows the first item added after the fix, after a reload', () => {
    const withItem: MenuStructure = { mmmmmmm: { mnnnnnnnnnnnn: [{ name: 'Espresso', price: '2.500' }] } };
    const html = render(<MenuEditor menus={JSON.parse(JSON.stringify(withItem)) as MenuStructure} readOnly={false} onChange={noop} />);
    expect(html).toContain('mnnnnnnnnnnnn');
    expect(html).toContain('Espresso');
    expect(html).toContain('2.500');
  });
});

describe('MenuEditor — write path keeps the nesting contract (source contract)', () => {
  const src = readFileSync(new URL('../components/kb/menu-editor.tsx', import.meta.url), 'utf8');

  it('creates subcategories inside the active category', () => {
    expect(src).toContain('[category]: { ...menus[category], [name.trim()]: [] }');
  });

  it('writes items back into the selected category/subcategory', () => {
    expect(src).toContain('[editing.category]: { ...menus[editing.category], [editing.sub]: items }');
  });

  it('keeps the fixed visibility rule (empty subcategories survive rendering)', () => {
    expect(src).toContain('items.length > 0 || !q');
  });
});