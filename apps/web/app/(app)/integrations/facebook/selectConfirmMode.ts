import type { FacebookConnection } from '@/lib/api';

/**
 * Select the confirm mode for a Page based on existing connection state.
 *
 * Returns `{ mode: 'connect' | 'reconnect' }` when the confirm may proceed,
 * or `{ mode: 'refuse', reason }` when it must be refused client-side before
 * calling the API.
 */
export function selectConfirmMode(
  existing: FacebookConnection | undefined,
  targetBrand: string | null
): { mode: 'connect' | 'reconnect' } | { mode: 'refuse'; reason: string } {
  if (!existing) {
    return { mode: 'connect' };
  }
  if (existing.brand && String(existing.brand.id) === String(targetBrand)) {
    // Same brand: authorized reconnect.
    return { mode: 'reconnect' };
  }
  if (existing.brand) {
    // Page is connected to a different brand — not a legitimate reconnect.
    return { mode: 'refuse', reason: 'CROSS_BRAND_TRANSFER_FORBIDDEN' };
  }
  // Brandless channel (legacy): reconnect to assign first brand.
  return { mode: 'reconnect' };
}
