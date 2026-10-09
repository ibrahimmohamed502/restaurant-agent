import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Badge, DELIVERY_STATUS } from '@/components/ui/badge';
import { PageHeader, DataTable, Th, Td } from '@/components/page-header';

describe('design-system primitives', () => {
  it('PageHeader renders title/description/actions and breadcrumb', () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Inbox" description="desc" breadcrumb={<span>Home</span>} actions={<button type="button">act</button>} />
    );
    expect(html).toContain('<h1');
    expect(html).toContain('Inbox');
    expect(html).toContain('desc');
    expect(html).toContain('Home');
    expect(html).toContain('act');
  });

  it('EmptyState and ErrorState are semantic (icons + text)', () => {
    const e = renderToStaticMarkup(<EmptyState title="No data" description="none" />);
    const r = renderToStaticMarkup(<ErrorState title="Failed" description="oops" />);
    expect(e).toContain('No data');
    expect(r).toContain('Failed');
    expect(r).toContain('border-destructive');
    expect(e).toContain('border-dashed');
  });

  it('delivery status badge variants are mapped', () => {
    expect(DELIVERY_STATUS.sent.variant).toBe('success');
    expect(DELIVERY_STATUS.pending.variant).toBe('warning');
    expect(DELIVERY_STATUS.failed.variant).toBe('destructive');
    const html = renderToStaticMarkup(<Badge variant="success">sent</Badge>);
    expect(html).toContain('sent');
  });

  it('data table foundation renders header + rows with empty state slot', () => {
    const html = renderToStaticMarkup(
      <DataTable head={<tr><Th>Name</Th></tr>} empty={<div>empty</div>}>
        <tr>
          <Td>Row</Td>
        </tr>
      </DataTable>
    );
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('Row');
    expect(html).toContain('empty');
  });
});
