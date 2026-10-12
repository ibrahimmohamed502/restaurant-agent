'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/** Thin progress bar that animates on route changes (frontend-only polish). */
export function TopLoader() {
  const pathname = usePathname();
  const [visible, setVisible] = React.useState(false);
  const first = React.useRef(true);

  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 550);
    return () => clearTimeout(id);
  }, [pathname]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5 overflow-hidden" aria-hidden>
      <div className="top-loader-bar h-full w-1/3 rounded-full bg-primary" />
    </div>
  );
}
