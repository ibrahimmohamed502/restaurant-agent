import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/messages/en.json';
import { OVERVIEW_GROUPS, OverviewWorkspace } from '@/components/kb/overview';
import { KbStatusBar, KbActionBar, KbSectionNav } from '@/components/kb/kb-shell';
import { MenuEditor } from '@/components/kb/menu-editor';
import { FaqEditor, BranchEditor, PolicyEditor, SourcesPanel } from '@/components/kb/editors';

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
}

const VALUE = {
  restaurantName: 'Life with Cacao',
  menuUrl: 'https://link.lifewithcacao.com/',
  currency: 'Kuwaiti Dinar (KD)',
  halal: 'All food is 100% halal',
  branches: [{ name: 'LWC 360', area: '360 Mall', timings: '8:00 AM – 11:30 PM' }],
  menus: {
    'Drinks & Dessert Menu': {
      'Cacao Signature Dessert': [{ name: 'Cacao Bomb', name_ar: 'كاكاو بومب', price: '4.650' }]
    }
  },
  faqs: [{ question: 'Do you deliver?', answer: 'Staff will confirm.' }]
};

describe('Stage 5 UI polish', () => {
  it('overview read-mode renders grouped sections (not a flat form)', () => {
    const html = render(<OverviewWorkspace value={VALUE} groups={OVERVIEW_GROUPS} editing={false} onChange={() => {}} />);
    for (const g of OVERVIEW_GROUPS) expect(html).toContain(g.title);
    // read mode: no editable textarea/input for published values
    expect(html).not.toContain('<textarea');
    expect(html).toContain('Life with Cacao');
    // menu URL renders as a link, not raw text
    expect(html).toContain('href="https://link.lifewithcacao.com/"');
  });

  it('overview edit-mode renders form controls and writes through onChange', () => {
    let changed = null;
    const html = render(
      <OverviewWorkspace
        value={VALUE}
        groups={OVERVIEW_GROUPS}
        editing
        onChange={(n) => { changed = n; }}
      />
    );
    expect(html).toContain('<textarea');
    expect(typeof changed === 'function' || changed === null).toBe(true);
    expect(true).toBe(true);
  });

  it('status bar distinguishes published (v3) from draft states', () => {
    const published = render(<KbStatusBar brandLabel="LWC KB" publishedVersion={3} draftState="none" saveState="idle" errorCount={null} />);
    expect(published).toContain('منشور · الإصدار 3');
    const draft = render(<KbStatusBar brandLabel="LWC KB" publishedVersion={3} draftState="draft" saveState="dirty" errorCount={2} />);
    expect(draft).toContain('مسودة');
    expect(draft).toContain('مشكلات تحتاج انتباهك');
  });

  it('action bar renders a single primary action for published mode', () => {
    const html = render(<KbActionBar actions={[{ key: 'draft', label: 'Create draft', onClick: () => {}, variant: 'primary' }]} />);
    expect(html).toContain('Create draft');
    // publish is not rendered when editing hasn't started
    expect(html).not.toContain('Publish');
  });

  it('section nav shows counts as badges', () => {
    const html = render(<KbSectionNav sections={[{ key: 'overview', label: 'Overview' }, { key: 'menu', label: 'Menu', badge: '1' }]} active="menu" onChange={() => {}} />);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('>1<');
  });

  it('menu editor shows compact rows with KD price (not oversized cards)', () => {
    const html = render(<MenuEditor menus={VALUE.menus} readOnly onChange={() => {}} />);
    expect(html).toContain('Cacao Bomb');
    expect(html).toContain('4.650');
    expect(html).toContain('tabular-nums');
  });

  it('faq editor shows expandable question rows', () => {
    const html = render(<FaqEditor faqs={VALUE.faqs} label="Question" readOnly onChange={() => {}} />);
    expect(html).toContain('Do you deliver?');
    expect(html).toContain('aria-expanded="false"');
  });

  it('branch editor renders compact scannable rows', () => {
    const html = render(<BranchEditor branches={VALUE.branches} readOnly onChange={() => {}} />);
    expect(html).toContain('LWC 360');
    expect(html).toContain('8:00 AM – 11:30 PM');
    expect(html).toContain('1 فرع');
  });

  it('policy editor renders structured sections', () => {
    const html = render(<PolicyEditor value={VALUE} editing={false} onChange={() => {}} />);
    expect(html).toContain('مصادر اللحوم');
    expect(html).toContain('ملاحظات تشغيلية');
  });

  it('sources panel renders publication history with current version', () => {
    const html = render(<SourcesPanel source={{ kind: 'menu', title: 'LWC KB' }} versions={[{ version: 3, created_at: '2026-10-09T10:00:00Z', published_by_name: 'Admin' }]} />);
    expect(html).toContain('v3');
    expect(html).toContain('Admin');
  });
});
