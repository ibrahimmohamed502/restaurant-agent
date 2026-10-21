import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * PWA / iPhone contract.
 * The dashboard is used from iPhones (standalone home-screen app), so the
 * install surface is a product requirement — not a nice-to-have.
 */

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const exists = (p: string) => existsSync(new URL(p, root));

/** Reads width/height straight from the PNG IHDR chunk. */
function pngSize(p: string): { width: number; height: number } {
  const buf = readFileSync(new URL(p, root));
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));

  it('installs as a standalone app (not a browser tab)', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toContain('standalone');
    expect(manifest.start_url).toBe('/dashboard');
    expect(manifest.scope).toBe('/');
    expect(manifest.id).toBe('/dashboard');
  });

  it('ships PNG icons for iOS + Android, including a maskable one', () => {
    const png = manifest.icons.filter((i: { type: string }) => i.type === 'image/png');
    expect(png.length).toBeGreaterThanOrEqual(3);
    expect(png.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
    expect(png.some((i: { sizes: string }) => i.sizes === '192x192')).toBe(true);
    expect(png.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
  });

  it('exposes the app shortcuts (dashboard + inbox)', () => {
    expect(manifest.shortcuts.map((s: { url: string }) => s.url)).toEqual(['/dashboard', '/inbox']);
  });

  it('every referenced icon actually exists on disk with the declared size', () => {
    for (const icon of manifest.icons) {
      if (icon.type !== 'image/png') continue;
      expect(exists(`public${icon.src}`)).toBe(true);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(`public${icon.src}`)).toEqual({ width: w, height: h });
    }
  });

  it('has the iOS apple-touch-icon (180×180, opaque)', () => {
    expect(pngSize('public/icons/icon-180.png')).toEqual({ width: 180, height: 180 });
  });
});

describe('service worker', () => {
  const sw = read('public/sw.js');

  it('is served from the app root and only handles GET requests', () => {
    expect(exists('public/sw.js')).toBe(true);
    expect(sw).toContain("request.method !== 'GET'");
  });

  it('never caches the API or the Meta webhook (live data must stay fresh)', () => {
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toContain("url.pathname.startsWith('/webhook')");
  });

  it('falls back to an offline page when the network is gone', () => {
    expect(sw).toContain("const OFFLINE_URL = '/offline.html'");
    expect(exists('public/offline.html')).toBe(true);
    expect(read('public/offline.html')).toContain('location.reload()');
  });

  it('purges stale caches on activate (versioned cache names)', () => {
    expect(sw).toMatch(/const VERSION = '[^']+'/);
    expect(sw).toContain('caches.delete(k)');
  });
});

describe('root layout — iOS install metadata', () => {
  const layout = read('app/layout.tsx');

  it('declares an iOS-capable standalone web app', () => {
    expect(layout).toContain('appleWebApp');
    expect(layout).toContain('capable: true');
  });

  it('ships the apple-touch-icon and the web manifest', () => {
    expect(layout).toContain('/icons/icon-180.png');
    expect(layout).toContain('/manifest.webmanifest');
  });

  it('uses viewport-fit=cover so the notch does not clip the shell', () => {
    expect(layout).toContain('viewportFit');
    expect(layout).toContain("'cover'");
  });

  it('mounts the service worker registrar and the install hint', () => {
    expect(layout).toContain('<ServiceWorkerRegistrar />');
    expect(layout).toContain('<InstallPrompt />');
  });
});

describe('auth middleware must not swallow the PWA assets', () => {
  const src = read('middleware.ts');

  it('excludes the service worker, the icons and the offline page from the session redirect', () => {
    expect(src).toContain('sw.js');
    expect(src).toContain('offline.html');
    expect(src).toContain('icons');
  });

  it('still protects the app routes', () => {
    expect(src).toContain("url.pathname = '/login'");
    expect(src).toContain('req.cookies.has');
  });
});

describe('service worker registrar', () => {
  const src = read('components/pwa/service-worker-registrar.tsx');

  it('registers the worker at the app root scope', () => {
    expect(src).toContain("navigator.serviceWorker");
    expect(src).toContain("register('/sw.js', { scope: '/' })");
  });

  it('is production-only and never throws', () => {
    expect(src).toContain("process.env.NODE_ENV !== 'production'");
    expect(src).toContain('.catch(() => undefined)');
  });

  it('tells the user when a new version is ready', () => {
    expect(src).toContain('updatefound');
    expect(src).toContain("t('updateTitle')");
  });
});

describe('install hint', () => {
  const src = read('components/pwa/install-prompt.tsx');

  it('stays hidden once the app is installed (standalone)', () => {
    expect(src).toContain("(display-mode: standalone)");
    expect(src).toContain('nav.standalone === true');
  });

  it('gives iOS Safari the manual Add-to-Home-Screen steps', () => {
    expect(src).toContain('isIos');
    expect(src).toContain('beforeinstallprompt');
  });

  it('remembers the dismissal', () => {
    expect(src).toContain('localStorage.setItem(DISMISS_KEY');
  });
});

describe('mobile ergonomics', () => {
  it('keeps form fields at 16px on phones so iOS does not zoom on focus', () => {
    expect(read('components/ui/input.tsx')).toContain('text-base');
  });

  it('keeps the home indicator from covering content', () => {
    expect(read('app/globals.css')).toContain('safe-area-inset-bottom');
    expect(read('components/shell/topbar.tsx')).toContain('safe-inline');
  });
});
