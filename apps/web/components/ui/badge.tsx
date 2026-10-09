import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-2 text-muted-foreground',
        info: 'border-info/30 bg-info/10 text-info',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        destructive: 'border-destructive/30 bg-destructive/10 text-destructive'
      }
    },
    defaultVariants: { variant: 'neutral' }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { badgeVariants };

/** Delivery status badge — shared semantic mapping for the Inbox. */
export const DELIVERY_STATUS: Record<'sent' | 'pending' | 'failed', { variant: BadgeProps['variant'] }> = {
  sent: { variant: 'success' },
  pending: { variant: 'warning' },
  failed: { variant: 'destructive' }
};
