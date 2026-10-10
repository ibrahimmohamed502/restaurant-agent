import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { MenuEditor } from '@/components/kb/menu-editor';
import { BranchEditor } from '@/components/kb/editors';
import en from '@/messages/en.json';

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

const noop = () => {};
const menus = { Drinks: { Hot: [{ name: 'Coffee', price: '1.500' }] } };
const branches = [{ name: 'LWC 360', area: '360 Mall', timings: '8:00 AM – 11:30 PM' }];

describe('MenuEditor (draft editing surface)', () => {
  it('renders categories, subcategories and items with localized labels', () => {
    const html = render(<MenuEditor menus={menus} readOnly onChange={noop} />);
    expect(html).toContain('Drinks');
    expect(html).toContain('Hot');
    expect(html).toContain('Coffee');
    expect(html).toContain('1.500'); // KD precision preserved in display
    expect(html).toContain('KD');
  });

  it('hides all edit controls in read-only mode', () => {
    const html = render(<MenuEditor menus={menus} readOnly onChange={noop} />);
    expect(html).not.toContain('Add category');
    expect(html).not.toContain('Add item');
  });

  it('exposes editing controls when editable', () => {
    const html = render(<MenuEditor menus={menus} readOnly={false} onChange={noop} />);
    expect(html).toContain('Add category');
    expect(html).toContain('Add item');
  });

  it('provides add/edit/delete for categories, subcategories and items (source contract)', () => {
    const src = readFileSync(new URL('../components/kb/menu-editor.tsx', import.meta.url), 'utf8');
    expect(src).toContain('addCategory');
    expect(src).toContain('removeCategory');
    expect(src).toContain('addSubcategory');
    expect(src).toContain('removeSubcategory');
    expect(src).toContain('addItem');
    expect(src).toContain('saveItem');
    expect(src).toContain('deleteItem');
    // deletions require confirmation
    expect(src).toContain('window.confirm');
    // KD price precision (3 decimals with thousand separators)
    expect(src).toContain('\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,3})?');
  });
});

describe('BranchEditor (draft editing surface)', () => {
  it('renders branch rows with localized labels', () => {
    const html = render(<BranchEditor branches={branches} readOnly onChange={noop} />);
    expect(html).toContain('LWC 360');
    expect(html).toContain('360 Mall');
  });

  it('hides edit controls in read-only mode', () => {
    const html = render(<BranchEditor branches={branches} readOnly onChange={noop} />);
    expect(html).not.toContain('Add branch');
  });

  it('validates name/url/phone and requires delete confirmation (source contract)', () => {
    const src = readFileSync(new URL('../components/kb/editors.tsx', import.meta.url), 'utf8');
    expect(src).toContain('window.confirm');
    expect(src).toContain("tk('branches.error.maps')");
    expect(src).toContain("tk('branches.error.phone')");
    expect(src).toContain("tk('branches.error.duplicate')");
  });
});

describe('Knowledge draft workflow safety', () => {
  const src = readFileSync(new URL('../app/(app)/knowledge/page.tsx', import.meta.url), 'utf8');

  it('edits flow through a draft: create draft → save → validate → preview → publish', () => {
    expect(src).toContain('knowledgeApi.createDraft');
    expect(src).toContain('knowledgeApi.saveDraft');
    expect(src).toContain('knowledgeApi.validate');
    expect(src).toContain('knowledgeApi.preview');
    expect(src).toContain('knowledgeApi.publish');
    expect(src).toContain('knowledgeApi.discard');
  });

  it('editors are read-only until a draft exists (published data is never edited directly)', () => {
    expect(src).toContain('readOnly={!editing || !canEdit}');
  });

  it('publish/discard go through confirmation dialogs', () => {
    expect(src).toContain("open={dialog === 'publish'}");
    expect(src).toContain("open={dialog === 'discard'}");
    expect(src).toContain("open={dialog === 'unsaved'}");
  });

  it('includes a directional Back control (RTL-aware)', () => {
    expect(src).toContain('ArrowLeft');
    expect(src).toContain('rtl:rotate-180');
    expect(src).toContain("window.history.length > 1");
  });
});
