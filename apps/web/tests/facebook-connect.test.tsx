import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';

const replace = vi.fn();
const back = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/integrations/facebook',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ back, push: replace, replace })
}));

import FacebookConnectPage from '@/app/(app)/integrations/facebook/page';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

function render(node: React.ReactNode, messages: Record<string, unknown> = en) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages as never}>
      {node}
    </NextIntlClientProvider>
  );
}

const src = readFileSync(new URL('../app/(app)/integrations/facebook/page.tsx', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );

const enFb = (en as unknown as { facebook: Record<string, unknown> }).facebook;
const arFb = (ar as unknown as { facebook: Record<string, unknown> }).facebook;

/* --------------------------------------------------------------------- i18n */

describe('facebook connect i18n (EN/AR)', () => {
  it('has exact EN/AR key parity', () => {
    expect(flatten(enFb).sort().join(',')).toBe(flatten(arFb).sort().join(','));
  });

  it('translates the user-facing strings rather than copying English', () => {
    expect(enFb.title).toBe('Facebook Pages');
    expect(arFb.title).toBe('صفحات فيسبوك');
    expect(arFb.title).not.toBe(enFb.title);

    const enErrors = enFb.errors as Record<string, string>;
    const arErrors = arFb.errors as Record<string, string>;
    expect(arErrors.META_ACCESS_DENIED).not.toBe(enErrors.META_ACCESS_DENIED);
    expect(arErrors.PAGE_OWNED_BY_ANOTHER_TENANT).not.toBe(enErrors.PAGE_OWNED_BY_ANOTHER_TENANT);
    expect(arErrors.PAGE_OWNED_BY_ANOTHER_TENANT).toContain('شركة أخرى');
  });

  it('covers every key the page renders', () => {
    const keys = flatten(enFb);
    for (const required of [
      'title', 'description', 'noBrand', 'errorTitle', 'tokenNotice',
      'connect.title', 'connect.description', 'connect.brandLabel',
      'connect.start', 'connect.starting', 'connect.addAnother',
      'connect.noBrandsTitle', 'connect.noBrandsDescription',
      'states.waiting.title', 'states.waiting.description', 'states.waiting.cancel',
      'states.picking.title', 'states.picking.description', 'states.picking.confirm',
      'states.picking.confirming', 'states.picking.connectable', 'states.picking.notConnectable',
      'states.picking.missingTasks',
      'states.connected.title', 'states.connected.description',
      'status.connected', 'status.needsReconnect', 'status.legacyOnly',
      'connections.title', 'connections.count', 'connections.disconnect', 'connections.reconnectHint',
      'connections.scopesConfirmed', 'connections.scopesUnconfirmed'
    ]) {
      expect(keys).toContain(required);
    }
  });

  it('explains every server error code the page can surface', () => {
    const keys = flatten(enFb);
    // Each of these is returned by the B1 routes and has a rendered explanation.
    for (const code of [
      'META_ACCESS_DENIED', 'META_NO_MANAGED_PAGES', 'PAGE_NOT_CONNECTABLE',
      'PAGE_OWNED_BY_ANOTHER_TENANT', 'PAGE_NOT_IN_ACCOUNT', 'BRAND_NOT_ACCESSIBLE',
      'AUTHORIZATION_EXPIRED', 'OAUTH_STATE_EXPIRED', 'OAUTH_STATE_ALREADY_USED',
      'OAUTH_STATE_NOT_FOUND', 'OAUTH_STATE_MISMATCH', 'META_UPSTREAM_UNAVAILABLE',
      'META_CODE_EXCHANGE_FAILED', 'CONNECTION_UPSTREAM_ERROR', 'NETWORK_ERROR'
    ]) {
      expect(keys).toContain(`errors.${code}`);
    }
  });

  it('gives the Arabic strings real Arabic script, not mojibake', () => {
    // A previous regression shipped Arabic copy that was byte-mangled. Assert on
    // the script range rather than on an exact byte sequence.
    const arabic = /[؀-ۿ]/;
    for (const value of [arFb.title, arFb.description, arFb.errorTitle, arFb.tokenNotice]) {
      expect(arabic.test(String(value))).toBe(true);
    }
  });
});

/* ----------------------------------------------------------------- rendering */

describe('facebook connect page rendering', () => {
  it('renders the localized shell before data arrives', () => {
    const html = render(<FacebookConnectPage />);
    expect(html).toContain('Facebook Pages');
    expect(html).toContain('Connect a Facebook Page to a brand');
  });

  it('renders with Arabic messages too (no missing-key crash)', () => {
    const html = render(<FacebookConnectPage />, ar as unknown as Record<string, unknown>);
    expect(html).toContain('صفحات فيسبوك');
  });

  it('exposes an accessible loading state for the async listing', () => {
    const html = render(<FacebookConnectPage />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('declares all seven connection states in the source', () => {
    // idle, starting, waitingOnMeta, picking, confirming, connected, needsReconnect
    for (const phase of [
      "'idle'", "'starting'", "'waitingOnMeta'", "'picking'",
      "'confirming'", "'connected'", "'needsReconnect'"
    ]) {
      expect(src).toContain(phase);
    }
    expect(src).toContain("| 'loading'");
  });
});

/* --------------------------------------------------------------- direction */

describe('facebook connect page direction & responsiveness', () => {
  it('uses logical (direction-aware) utilities, not physical left/right', () => {
    expect(src).not.toMatch(/\b(ml|mr|pl|pr)-/);
    expect(src).not.toMatch(/text-(left|right)\b/);
    expect(src).not.toMatch(/className="[^"]*\b(left|right)-\d/);
  });

  it('relies on the document direction from the locale instead of hardcoding dir', () => {
    expect(src).not.toContain('dir="rtl"');
    expect(src).not.toContain('dir="ltr"');
  });

  it('uses start/end spacing so RTL reads naturally', () => {
    expect(src).toContain('me-2');
    expect(src).toContain('flex-wrap');
  });

  it('is responsive (wrapping rows and a full-width control)', () => {
    expect(src).toContain('flex-wrap');
    expect(src).toContain('w-full');
  });
});

/* ---------------------------------------------------------------- security */

describe('facebook connect page security', () => {
  it('never holds, stores or renders an access token', () => {
    expect(src).not.toMatch(/access[_-]?token\s*[:=]\s*['"]/i);
    expect(src).not.toMatch(/EAA-/);
    expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it('navigates only to the authorize URL the server produced', () => {
    expect(src).toContain('facebookApi.start');
    expect(src).toContain('window.location.href = authorizeUrl');
    // No hand-built Facebook URL and no callback URL assembled in the browser.
    expect(src).not.toMatch(/facebook\.com/);
    expect(src).not.toMatch(/dialog\/oauth/);
  });

  it('lets the server decide whether a Page may be connected', () => {
    expect(src).toContain('p.connectable');
    expect(src).toContain('disabled={!p.connectable || busy}');
    // The client must not re-derive permissions from Meta's task list. These are
    // anchored so an unrelated code such as META_NO_MANAGED_PAGES cannot match.
    expect(src).not.toMatch(/'\bMANAGE\b'/);
    expect(src).not.toMatch(/CREATE_CONTENT/);
    expect(src).not.toMatch(/MODERATE/);
    expect(src).not.toMatch(/\.tasks\.(includes|some|every)\(/);
  });

  it('treats the callback state id as a value, never as proof of identity', () => {
    // The brand actually connected comes from the grant the server re-reads for
    // this session, never from a brand id in the URL.
    expect(src).toContain('const targetBrand = grantBrandId || brandId');
    expect(src).toContain('facebookApi.pages(returnedState)');
    expect(src).not.toMatch(/searchParams\.get\('brandId'\)|params\.get\('brandId'\)/);
  });

  it('drops the spent grant from the URL so a refresh cannot replay it', () => {
    expect(src).toContain("router.replace('/integrations/facebook')");
  });

  it('announces failures to assistive technology', () => {
    expect(src).toContain('role="alert"');
    expect(src).toContain('role="status"');
  });
});

/* -------------------------------------------------------------- API client */

describe('facebook API client', () => {
  const block = apiSrc.slice(apiSrc.indexOf('export const facebookApi'));

  it('exposes exactly the four documented steps plus listing and disconnect', () => {
    for (const method of ['start:', 'pages:', 'confirm:', 'connections:', 'disconnect:']) {
      expect(block).toContain(method);
    }
    expect(block).toContain("api.post<{ authorizeUrl: string; state: string; expiresAt: string }>");
  });

  it('never asks for a tenant parameter (the server scopes to the session)', () => {
    expect(block).not.toContain('tenantId=');
  });

  it('documents that a null expiry is unknown, not eternal', () => {
    expect(apiSrc).toContain('credentialExpiresAt');
    expect(apiSrc).toContain('NOT the same as "never expires"');
  });
});
describe('facebook connect page: unified connection status', () => {
  it('renders health from the API rule, not from a local re-derivation', () => {
    // The page must consume the API's single rule. If it re-derives health from
    // credentialPresent it will show an EXPIRED OAuth token as connected
    // whenever a legacy credential happens to exist.
    expect(src).toContain('c.connectionHealthy');
    expect(src).not.toMatch(/const live = c\.credentialPresent/);
    expect(src).not.toMatch(/filter\(\(c\) => c\.credentialPresent && c\.status/);
  });

  it('uses the rule for the connected count, the row badge and the page phase', () => {
    // Three consumers, all from the API's rule:
    //   connected count + row badge -> connectionHealthy (is it healthy?)
    //   page phase                -> oauthRequiresReconnect (does it need work?)
    const healthyUses = (src.match(/connectionHealthy/g) || []).length;
    expect(healthyUses).toBeGreaterThanOrEqual(2);
    expect(src).toContain('c.oauthRequiresReconnect');
    expect((src.match(/oauthRequiresReconnect/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it('never treats credential presence as validity', () => {
    // credentialPresent stays a back-compatible PRESENCE flag. It must not be
    // used to decide health anywhere on this page.
    const healthLines = src
      .split('\n')
      .filter((l) => /live\s*=|connectedCount\s*=/.test(l));
    for (const l of healthLines) {
      expect(l).not.toContain('credentialPresent');
    }
  });
});

describe('facebook API client: safe OAuth-only disconnect', () => {
  it('can request an oauth-scoped disconnect', () => {
    expect(apiSrc).toContain("scope?: 'full' | 'oauth'");
    expect(apiSrc).toContain('?scope=');
  });

  it('exposes the unified status fields the page renders', () => {
    for (const f of [
      'oauthConnected: boolean;',
      'oauthHealthy: boolean;',
      'oauthRequiresReconnect: boolean;',
      'connectionHealthy: boolean;'
    ]) {
      expect(apiSrc).toContain(f);
    }
  });
});

describe('facebook connect page: a live legacy integration is never shown as removed', () => {
  it('reads the legacy-only state from the API, not from a local guess', () => {
    expect(src).toContain('c.legacyOnly');
    expect(apiSrc).toContain('legacyOnly: boolean;');
  });

  it('never asks a legacy-only Page to be disconnected', () => {
    // B1 must not be able to remove the live Messenger/Comments integration.
    // Offering a button whose only possible answer is a refusal is a lie, so
    // the button is not rendered for a legacy-only row.
    expect(src).toMatch(/legacyOnly \? null : \(/);
  });

  it('labels a legacy-only Page as a live integration, not as needing a reconnect', () => {
    expect(src).toContain('status.legacyOnly');
    expect(src).toContain('status.needsReconnect');
  });

  it('does not let a legacy-only row ask for a reconnect on the page itself', () => {
    // The page-level "needs work" state must be driven by the OAuth rule only.
    // A legacy-only row is an ACTIVE integration, not a broken one.
    expect(src).toContain('c.oauthRequiresReconnect || (c.oauthConnected && c.status !==');
  });
});

describe('facebook connect page: requested scopes are never presented as granted', () => {
  it('shows the CONFIRMED scopes when Meta stated them', () => {
    expect(src).toContain('c.scopesVerified');
    expect(src).toContain('c.grantedScopes');
    expect(src).toContain('connections.scopesConfirmed');
  });

  it('says "not confirmed" and names only the REQUEST when Meta did not say', () => {
    expect(src).toContain('connections.scopesUnconfirmed');
    expect(src).toContain('c.requestedScopes');
  });

  it('never renders the requested scopes as if they were granted', () => {
    // The CONFIRMED branch must read the granted scopes and nothing else.
    // The requested scopes may appear ONLY in the "not confirmed" branch, where
    // they are labelled as a request.
    const confirmed = src.slice(
      src.indexOf('connections.scopesConfirmed'),
      src.indexOf('connections.scopesUnconfirmed')
    );
    expect(confirmed).toContain('c.grantedScopes');
    expect(confirmed).not.toContain('c.requestedScopes');

    const unconfirmed = src.slice(src.indexOf('connections.scopesUnconfirmed'));
    expect(unconfirmed).toContain('c.requestedScopes');
    expect(unconfirmed).not.toContain('c.grantedScopes');
  });
});
