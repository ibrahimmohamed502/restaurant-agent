import * as React from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-4 border-b border-border pb-4', className)}>
      {breadcrumb ? <div className="text-xs text-muted-foreground">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Foundation for future data tables: consistent header + scrolling body. */
export function DataTable({
  head,
  children,
  empty,
  className
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  empty?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-start text-sm">
          <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">{head}</thead>
          <tbody className="divide-y divide-border">{children}</tbody>
        </table>
      </div>
      {empty}
    </div>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th scope="col" className={cn('px-4 py-2.5 text-start font-medium', className)}>{children}</th>;
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-4 py-2.5 align-middle text-foreground', className)}>{children}</td>;
}
