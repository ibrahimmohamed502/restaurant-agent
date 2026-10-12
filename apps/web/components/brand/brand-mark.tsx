import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * LWC brand mark — a cacao cup with rising steam.
 * Pure local SVG (no external assets); inherits currentColor where possible.
 */
export function BrandMark({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn('shrink-0', className)}
      role="img"
      aria-label="LWC"
    >
      {/* steam wisps */}
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="steam">
        <path d="M12.4 6.6c0-1.2 1.2-1.6 1.2-2.8" opacity="0.9" />
      </g>
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="steam steam-2">
        <path d="M16 5.6c0-1.2 1.2-1.6 1.2-2.8" opacity="0.7" />
      </g>
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="steam steam-3">
        <path d="M19.6 6.6c0-1.2 1.2-1.6 1.2-2.8" opacity="0.5" />
      </g>
      {/* cup */}
      <path
        d="M8.5 13.5h13.5v4.8a6.75 6.75 0 0 1-6.75 6.75h0A6.75 6.75 0 0 1 8.5 18.3v-4.8Z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      {/* handle */}
      <path d="M22 15h1.8a3.4 3.4 0 0 1 0 6.8H22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {/* saucer */}
      <path d="M6.5 26.5h17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {/* cacao bean accent */}
      <ellipse cx="15.25" cy="18.2" rx="2.1" ry="3.1" fill="currentColor" transform="rotate(-18 15.25 18.2)" />
    </svg>
  );
}
