// B1 - Facebook Page Self-Service OAuth test suite.
//
// REAL-POSTGRESQL, MOCKED META.
//
// Meta is never contacted: setGraphTransport() swaps the Graph HTTP layer for a
// deterministic mock, so the whole connect flow is exercised against real rows
// and real HTTP without a network call, a real Facebook account, or a real
// token. That means these tests CAN prove our logic - state replay, tenant
// isolation, ownership conflicts, token encryption - but they CANNOT prove that
// Meta's real API behaves as modelled. Nothing here is evidence of real Meta
// connectivity.
//
// Follows the established A1 pattern (scripts/test-roles-pg.mjs): apply the real
// migration ledger to a throwaway database, exercise the services against real
// rows, then mount the router over real HTTP to test the gates a service test
// cannot see.

import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TEST_DATABASE_URL;

// A missing database is NOT a pass. CI must supply one.
if (!url) {
  console.log('  SKIP  TEST_DATABASE_URL not set - this is NOT a pass. CI must provide a database.');
  process.exit(1);
}

process.env.DATABASE_URL ||= url;
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
process.env.FB_APP_ID ||= 'test-app-id';
process.env.FB_APP_SECRET ||= 'test-app-secret';
process.env.META_OAUTH_REDIRECT_URI ||= 'https://social.universalfoodco.com/api/v1/integrations/facebook/callback';
process.env.META_OAUTH_REDIRECT_URIS ||= process.env.META_OAUTH_REDIRECT_URI;
process.env.META_OAUTH_PKCE ||= 'true';

const client = new pg.Client({ connectionString: url });
// Module scope, not try-block scope: the `finally` below has to close it even
// when the suite dies before reaching the section that creates it.
const pool = new pg.Pool({ connectionString: url, max: 8 });
const q = (sql, params) => client.query(sql, params);

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` [${detail}]` : ''}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const rejects = async (name, code, fn) => {
  try { await fn(); check(name, false, 'expected a rejection, got success'); }
  catch (e) { check(name, e?.code === code, `code=${e?.code} want=${code}`); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const servers = [];

try {
  await client.connect();

  // ---------------------------------------------------------------- helpers
  const DB = { connect: () => pool.connect(), query: (sql, params) => pool.query(sql, params) };

  let t1, t2, b1, b1b, b1c, b2, admin1, admin2;

  // ---------------------------------------------------------------- 0 migrations
  const dirs = readdirSync(join(REPO, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of dirs) await q(readFileSync(join(REPO, 'migrations', f), 'utf8'));
  check('every migration applies cleanly, including 023', true);

  // ---------------------------------------------------------------- 1 schema
  section('1 023 shape');
  {
    const { rows: cols } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='oauth_states' ORDER BY ordinal_position`
    );
    const names = cols.map((r) => r.column_name);
    for (const c of ['state_hash', 'code_verifier_hash', 'user_token_encrypted', 'user_token_iv',
                     'redirect_uri', 'expires_at', 'consumed_at', 'brand_id', 'session_id']) {
      check(`oauth_states.${c} exists`, names.includes(c));
    }

    const { rows: storable } = await q(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name='oauth_states' AND column_name IN ('state','state_token')`
    );
    eq('no plaintext state column exists', storable[0].n, 0);

    const { rows: idx } = await q(`SELECT indexname FROM pg_indexes WHERE tablename='oauth_states'`);
    const idxNames = idx.map((r) => r.indexname);
    check('oauth_states_hash_uidx exists', idxNames.includes('oauth_states_hash_uidx'));
    check('oauth_states_inflight_uidx exists', idxNames.includes('oauth_states_inflight_uidx'));
    check('oauth_states_expires_idx exists', idxNames.includes('oauth_states_expires_idx'));

    const { rows: own } = await q(
      `SELECT indexname FROM pg_indexes WHERE indexname='channels_meta_tenant_owner_uidx'`
    );
    check('channels_meta_tenant_owner_uidx exists', own.length === 1);

    const { rows: chCols } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='channels' AND column_name LIKE 'oauth_%' ORDER BY column_name`
    );
    eq('channels gains exactly the three oauth_* columns',
      chCols.map((r) => r.column_name), ['oauth_connected_at', 'oauth_provider', 'oauth_scopes']);

    // Additive only: the pre-existing A1/P0.5 objects are untouched.
    const { rows: legacy } = await q(
      `SELECT indexname FROM pg_indexes WHERE indexname='channels_meta_external_uidx'`
    );
    check('the pre-existing channels_meta_external_uidx is still present', legacy.length === 1);
  }

  // ---------------------------------------------------------------- 2 fixtures
  section('2 fixtures');
  ({ rows: [{ id: t1 }] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T1','b1-t1') RETURNING id`));
  ({ rows: [{ id: t2 }] } = await q(`INSERT INTO tenants (name,slug) VALUES ('T2','b1-t2') RETURNING id`));
  ({ rows: [{ id: b1 }] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1','b1-b1') RETURNING id`, [t1]));
  ({ rows: [{ id: b1b }] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1 second','b1-b1b') RETURNING id`, [t1]));
  ({ rows: [{ id: b1c }] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B1 third','b1-b1c') RETURNING id`, [t1]));
  ({ rows: [{ id: b2 }] } = await q(`INSERT INTO brands (tenant_id,name,slug) VALUES ($1,'B2','b1-b2') RETURNING id`, [t2]));
  ({ rows: [{ id: admin1 }] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'a1@b1.local','A1','x') RETURNING id`, [t1]));
  ({ rows: [{ id: admin2 }] } = await q(`INSERT INTO users (tenant_id,email,name,password_hash) VALUES ($1,'a2@b2.local','A2','x') RETURNING id`, [t2]));
  check('two companies, three brands on the first and one on the second', true);

  const state = await import('../src/services/oauthState.js');
  const conn = await import('../src/services/facebookConnections.js');
  const metaOAuth = await import('../src/providers/meta/oauth.js');

  const URI = process.env.META_OAUTH_REDIRECT_URI;

  // ---------------------------------------------------------------- 1b transport
  section('1b Meta adapter transport and redaction (stubbed HTTP, no network)');
  {
    // This section deliberately drives the REAL graphPost/graphGet by stubbing
    // global fetch, rather than replacing the transport. Replacing it would test
    // the mock and prove nothing about the code that actually runs in production.
    const realFetch = globalThis.fetch;
    try {
      let seen = null;
      globalThis.fetch = async (u, opts) => { seen = { url: String(u), headers: opts.headers, body: opts.body }; return new Response(JSON.stringify({ access_token: 'EAA-user' }), { status: 200 }); };

      await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI });
      // The documented GET form necessarily carries client_secret in the query
      // string. The guarantee is not "the secret is not in the URL" - it is that
      // the URL is never logged and no error path can echo it. Those are asserted
      // below and in the redaction section.
      check('the documented GET form does send client_secret as a parameter',
        seen.url.includes('client_secret=test-app-secret'));
      check('and it sends no body', seen.body === undefined || seen.body === null);

      seen = null;
      await metaOAuth.discoverPages({ userAccessToken: 'EAA-super-secret' });
      check('the access token is never placed in a query string', !seen.url.includes('EAA-super-secret'));
      eq('it is sent as an Authorization header', seen.headers.Authorization, 'Bearer EAA-super-secret');

      // Meta error bodies can echo request parameters back. Nothing may be echoed.
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: { message: 'redirect_uri=https://evil/abc&secret=leak', code: 100, error_subcode: 533 } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
      await rejects('a Graph JSON error is normalised', metaOAuth.META_OAUTH_ERRORS.UPSTREAM_ERROR,
        () => metaOAuth.discoverPages({ userAccessToken: 'U' }));
      try {
        await metaOAuth.discoverPages({ userAccessToken: 'U' });
      } catch (e) {
        check('the upstream error body is never echoed', !/leak|evil/.test(String(e.message)));
        eq('only the numeric code and subcode survive', e.detail, { code: 100, subcode: 533 });
      }

      globalThis.fetch = async () => new Response('<html>secret=leak</html>', { status: 502 });
      await rejects('a non-JSON Graph response is normalised', metaOAuth.META_OAUTH_ERRORS.UPSTREAM_ERROR,
        () => metaOAuth.discoverPages({ userAccessToken: 'U' }));
      try {
        await metaOAuth.discoverPages({ userAccessToken: 'U' });
      } catch (e) {
        check('a non-JSON body is never echoed', !/leak/.test(String(e.message)));
      }

      globalThis.fetch = async () => { throw new TypeError('fetch failed: ENOTFOUND secret-host'); };
      await rejects('an unreachable Graph host is a clean upstream error', metaOAuth.META_OAUTH_ERRORS.UPSTREAM_UNAVAILABLE,
        () => metaOAuth.discoverPages({ userAccessToken: 'U' }));
      try {
        await metaOAuth.discoverPages({ userAccessToken: 'U' });
      } catch (e) {
        check('a low-level network error is never echoed', !/secret-host/.test(String(e.message)));
      }

      // The injectable transport must actually be honoured. A direct call to the
      // private graphPost/graphGet would bypass it and hit Meta for real.
      // Path-aware, because the code exchange now uses GET and therefore goes
      // through transport.get rather than transport.post.
      const originalFetch = globalThis.fetch;
      let transportUsed = 0;
      metaOAuth.setGraphTransport({
        post: async () => { transportUsed++; return { access_token: 'EAA-mock' }; },
        get: async (path) => {
          transportUsed++;
          return path === '/oauth/access_token'
            ? { access_token: 'EAA-mock' }
            : { data: [] };
        }
      });
      await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI });
      await metaOAuth.discoverPages({ userAccessToken: 'U' });
      metaOAuth.resetGraphTransport();
      globalThis.fetch = originalFetch;
      eq('the injectable transport is actually used, not bypassed', transportUsed, 2);
    } finally {
      globalThis.fetch = realFetch;
      metaOAuth.resetGraphTransport();
    }

    eq('B1 pins the current Graph API version', metaOAuth.META_GRAPH_VERSION, 'v26.0');
    eq('B1 requests only the discovery baseline scopes', metaOAuth.B1_SCOPES, ['pages_show_list', 'pages_read_engagement']);

    // Open-redirect safety, by construction: origin comes from the allowlisted
    // callback URI, the path is fixed configuration, and params are fixed keys.
    const built = metaOAuth.buildPostLoginRedirect({
      origin: new URL(URI).origin, params: { stateId: 'abc-123', error: '' }
    });
    eq('the post-login redirect is built from the allowlisted origin',
      built, 'https://social.universalfoodco.com/integrations/facebook?stateId=abc-123');
    check('an absolute attacker URL cannot escape the origin',
      new URL(metaOAuth.buildPostLoginRedirect({
        origin: new URL(URI).origin,
        path: '/integrations/facebook',
        params: { next: 'https://evil.example' }
      })).origin === 'https://social.universalfoodco.com');
    await rejects('building a redirect with no origin throws', metaOAuth.META_OAUTH_ERRORS.INVALID_REDIRECT_URI,
      async () => metaOAuth.buildPostLoginRedirect({ origin: '' }));
  }

  // The exact shapes brandScopeFromSession() produces.
  const TENANT_SCOPE = { mode: 'tenant', brandIds: null };
  const FIRST_BRAND_ONLY = { mode: 'restricted', brandIds: [b1] };
  const T1_BOTH_BRANDS = { mode: 'restricted', brandIds: [b1, b1b] };
  const T2_BRAND_ONLY = { mode: 'restricted', brandIds: [b2] };
  const NO_BRANDS = { mode: 'restricted', brandIds: [] };

  // ---------------------------------------------------------------- 3 oauth state
  section('3 oauth state');
  {
    const s = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, provider: 'meta', brandId: b1, redirectUri: URI, db: DB
    });
    check('a state is issued', typeof s.state === 'string' && s.state.length >= 32);

    const { rows: [row] } = await q(`SELECT state_hash FROM oauth_states WHERE actor_user_id=$1`, [admin1]);
    eq('the row stores a 32-byte SHA-256 digest', row.state_hash.length, 32);
    check('the plaintext state is not stored verbatim',
      Buffer.from(row.state_hash).toString('hex') !== Buffer.from(s.state).toString('hex'));

    const first = await state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB });
    check('the state can be consumed once', typeof first.id === 'string');
    // The callback cannot know the tenant or the user yet: it authenticates BY
    // the state. It must therefore receive the row's own binding rather than a
    // mismatch. (This is the path a real Facebook redirect takes.)
    eq('and it returns the tenant the state was issued for', String(first.tenantId), t1);
    eq('and the user it was issued for', String(first.actorUserId), admin1);
    eq('and the brand chosen before authorizing', String(first.brandId), b1);

    await rejects('replaying the same state is refused', state.OAUTH_STATE_ERRORS.ALREADY_USED,
      () => state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB }));

    await rejects('an unknown state is refused', state.OAUTH_STATE_ERRORS.NOT_FOUND,
      () => state.consumeOAuthState({ state: 'never-issued-at-all', redirectUri: URI, db: DB }));

    // Binding.
    const s2 = await state.issueOAuthState({ tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB });
    await rejects('a state issued for one user is refused for another', state.OAUTH_STATE_ERRORS.MISMATCH,
      () => state.consumeOAuthState({ state: s2.state, tenantId: t1, actorUserId: admin2, redirectUri: URI, db: DB }));

    const s3 = await state.issueOAuthState({ tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB });
    await rejects('a state issued for one company is refused for another', state.OAUTH_STATE_ERRORS.MISMATCH,
      () => state.consumeOAuthState({ state: s3.state, tenantId: t2, actorUserId: admin1, redirectUri: URI, db: DB }));

    const s4 = await state.issueOAuthState({ tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB });
    await rejects('a state is refused when the redirect uri differs', state.OAUTH_STATE_ERRORS.MISMATCH,
      () => state.consumeOAuthState({ state: s4.state, redirectUri: 'https://evil.example/callback', db: DB }));

    // Session binding.
    const s4b = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, sessionId: '11111111-1111-1111-1111-111111111111',
      brandId: b1, redirectUri: URI, db: DB
    });
    await rejects('a state issued in another session is refused', state.OAUTH_STATE_ERRORS.MISMATCH,
      () => state.consumeOAuthState({
        state: s4b.state, sessionId: '22222222-2222-2222-2222-222222222222', redirectUri: URI, db: DB
      }));

    // Expiry.
    const s5 = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB, ttlSeconds: -1
    });
    await rejects('an expired state is refused', state.OAUTH_STATE_ERRORS.EXPIRED,
      () => state.consumeOAuthState({ state: s5.state, redirectUri: URI, db: DB }));

    await rejects('an unsupported provider is refused', state.OAUTH_STATE_ERRORS.UNSUPPORTED_PROVIDER,
      () => state.issueOAuthState({ tenantId: t1, actorUserId: admin1, provider: 'instagram', redirectUri: URI, db: DB }));

    // State entropy.
    const a = state.generateStateToken();
    const b = state.generateStateToken();
    check('states are unique', a !== b && a.length >= 40);
  }

  // ---------------------------------------------------------------- 4 concurrency
  section('4 concurrent replay');
  {
    const s = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB
    });
    const results = await Promise.allSettled([
      state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB }),
      state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB }),
      state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB })
    ]);
    eq('exactly one concurrent consume wins', results.filter((r) => r.status === 'fulfilled').length, 1);
    eq('the other two are rejected', results.filter((r) => r.status === 'rejected').length, 2);
  }

  // ---------------------------------------------------------------- 5 in-flight guard
  section('5 in-flight guard');
  {
    await state.issueOAuthState({ tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB });
    await state.issueOAuthState({ tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB });
    const { rows } = await q(
      `SELECT count(*)::int n FROM oauth_states WHERE actor_user_id=$1 AND consumed_at IS NULL`, [admin1]
    );
    eq('a second attempt supersedes the first instead of failing', rows[0].n, 1);
  }

  // ---------------------------------------------------------------- 6 redirect allowlist
  section('6 redirect uri allowlist');
  {
    check('the configured uri is allowed', metaOAuth.isAllowedRedirectUri(URI) === true);
    check('an unlisted uri is refused', metaOAuth.isAllowedRedirectUri('https://evil.example/cb') === false);
    check('a prefix of the allowed uri is refused', metaOAuth.isAllowedRedirectUri(URI + '/extra') === false);
    check('a suffix/typo is refused', metaOAuth.isAllowedRedirectUri(URI + 'x') === false);
    await rejects('authorizing against an unlisted uri throws', metaOAuth.META_OAUTH_ERRORS.INVALID_REDIRECT_URI,
      () => metaOAuth.buildAuthorizationUrl({ redirectUri: 'https://evil.example/cb', state: 'x' }));
  }

  // ---------------------------------------------------------------- 7 page permissions
  // CONNECT scope, not FEATURE scope. B1 links a Page and lists it; it does not
  // post, reply or moderate. Requiring CREATE_CONTENT/MODERATE here would demand
  // capability for features that do not exist yet and refuse legitimate Pages.
  section('7 page permission assessment (connect scope)');
  {
    const CONNECT = ['MANAGE'];
    check('MANAGE alone is connectable', metaOAuth.assessPagePermissions(['MANAGE']).connectable === true);
    check('MANAGE plus extra tasks is connectable',
      metaOAuth.assessPagePermissions(['MANAGE', 'CREATE_CONTENT', 'MODERATE']).connectable === true);
    const readOnly = metaOAuth.assessPagePermissions(['READ_CONTENT']);
    check('read-only is NOT connectable', readOnly.connectable === false);
    eq('and the missing task is reported', readOnly.missingTasks, CONNECT);
    check('an empty task list is not connectable',
      metaOAuth.assessPagePermissions([]).connectable === false);
    check('task comparison is case-insensitive',
      metaOAuth.assessPagePermissions(['manage']).connectable === true);
    check('CREATE_CONTENT alone is not connectable - visibility is not administration',
      metaOAuth.assessPagePermissions(['CREATE_CONTENT']).connectable === false);

    eq('the default threshold is connect scope only', metaOAuth.requiredPageTasks(), CONNECT);
    eq('and it is reported back to the caller',
      metaOAuth.assessPagePermissions(['READ_CONTENT']).requiredTasks, CONNECT);

    // The ladder is explicit so the UI and the operator cannot disagree.
    eq('the documented ladder separates connect from feature scope',
      metaOAuth.PAGE_TASK_LADDER,
      {
        connectOnly: ['MANAGE'],
        withPublishing: ['MANAGE', 'CREATE_CONTENT'],
        withModeration: ['MANAGE', 'CREATE_CONTENT', 'MODERATE']
      });

    // Raising the threshold for a later feature batch is one env var.
    process.env.META_OAUTH_REQUIRED_TASKS = 'MANAGE,CREATE_CONTENT';
    eq('the threshold can be raised for a publishing feature',
      metaOAuth.requiredPageTasks(), ['MANAGE', 'CREATE_CONTENT']);
    check('and a MANAGE-only page is then refused',
      metaOAuth.assessPagePermissions(['MANAGE']).connectable === false);

    process.env.META_OAUTH_REQUIRED_TASKS = 'MANAGE,CREATE_CONTENT,MODERATE';
    check('the original full threshold is still reachable',
      metaOAuth.assessPagePermissions(['MANAGE', 'CREATE_CONTENT', 'MODERATE']).connectable === true);

    process.env.META_OAUTH_REQUIRED_TASKS = '   ';
    eq('a blank value falls back to the default, never to "no tasks"',
      metaOAuth.requiredPageTasks(), CONNECT);
    delete process.env.META_OAUTH_REQUIRED_TASKS;
    eq('and deleting it restores the default', metaOAuth.requiredPageTasks(), CONNECT);
  }

  // ---------------------------------------------------------------- 7b exchange method
  // DEFAULT IS THE DOCUMENTED FORM.
  //
  // Researched 2026-10-19: every official Meta page that shows
  // /oauth/access_token uses GET - the manual login flow guide, the long-lived
  // token guide, "Access Tokens for Meta Technologies", and Marketing API
  // authentication. POST appears only in community threads where developers
  // report it works. That is evidence of tolerance, not of documented support.
  //
  // So B1 defaults to GET rather than betting the whole connect flow on
  // undocumented tolerance. POST remains available as an opt-in, and its whole
  // advantage is that the secret never touches a URL.
  section('7b code exchange method (GET is the documented form)');
  {
    eq('the exchange method defaults to the documented GET', metaOAuth.exchangeMethod(), 'GET');

    const calls = [];
    metaOAuth.setGraphTransport({
      post: async (p) => { calls.push('post'); return { access_token: 'EAA-mock' }; },
      get: async (p) => { calls.push('get'); return { access_token: 'EAA-mock' }; }
    });

    await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI });
    eq('GET is used by default', calls, ['get']);

    calls.length = 0;
    process.env.META_OAUTH_EXCHANGE_METHOD = 'post';
    eq('POST is selectable without a code change', metaOAuth.exchangeMethod(), 'POST');
    await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI });
    eq('and the undocumented POST form is then used', calls, ['post']);

    // The reason POST exists: it keeps client_secret out of the URL entirely.
    // The transport must be reset first, or exchangeCode would use the mock
    // instead of the stubbed fetch and nothing would be captured.
    metaOAuth.resetGraphTransport();
    const realFetch2 = globalThis.fetch;
    try {
      let seenPost = null;
      globalThis.fetch = async (u, opts) => {
        seenPost = { url: String(u), body: opts.body };
        return new Response(JSON.stringify({ access_token: 'EAA-mock' }), { status: 200 });
      };
      await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI });
      check('POST keeps the app secret out of the URL', !seenPost.url.includes('test-app-secret'));
      check('and puts it in the body instead', String(seenPost.body).includes('client_secret=test-app-secret'));

      // Under the DEFAULT GET the secret IS in the URL, so the guarantee has to
      // be that no failure path ever echoes that URL or its secret.
      globalThis.fetch = async () => { throw new TypeError('fetch failed: ENOTFOUND graph.facebook.com'); };
      let netErr = null;
      try { await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI }); } catch (e) { netErr = e; }
      check('a network failure is reported without the secret',
        netErr && !/client_secret|test-app-secret/.test(String(netErr.message)),
        `message=${netErr?.message}`);
      check('a network failure does not leak the upstream hostname',
        netErr && !/graph\.facebook\.com/.test(String(netErr.message)));

      globalThis.fetch = async () => new Response('<html>client_secret=test-app-secret</html>', { status: 500 });
      let redactionError = null;
      try { await metaOAuth.exchangeCode({ code: 'C', redirectUri: URI }); } catch (e) { redactionError = e; }
      check('a non-JSON error body cannot leak the secret',
        redactionError && !/client_secret|test-app-secret/.test(String(redactionError.message)),
        `message=${redactionError?.message}`);
    } finally {
      globalThis.fetch = realFetch2;
      delete process.env.META_OAUTH_EXCHANGE_METHOD;
    }

    process.env.META_OAUTH_EXCHANGE_METHOD = 'PUT';
    await rejects('an unsupported method is refused rather than guessed',
      metaOAuth.META_OAUTH_ERRORS.MISSING_CONFIG,
      async () => metaOAuth.exchangeCode({ code: 'C', redirectUri: URI }));
    delete process.env.META_OAUTH_EXCHANGE_METHOD;

    metaOAuth.resetGraphTransport();
  }

  // ---------------------------------------------------------------- 8 connect + isolation
  section('8 connect, brand scope and ownership');
  const PAGES = [
    { id: '111', name: 'Page One', category: 'Retail', tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'], access_token: 'EAA-page-111' },
    { id: '222', name: 'Page Two', category: 'Food', tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'], access_token: 'EAA-page-222' },
    { id: '333', name: 'Read Only Page', category: 'Other', tasks: ['READ_CONTENT'], access_token: 'EAA-page-333' }
  ];
  // Real discovery normalises the Meta response shape; the mock returns it raw so
  // the normalisation itself is under test rather than bypassed.
  //
  // Path-aware because the code exchange uses the documented GET form, so BOTH
  // /oauth/access_token and /me/accounts arrive through the same GET transport.
  // A single-shape mock would silently return the wrong body for one of them.
  metaOAuth.setGraphTransport({
    get: async (path) => {
      if (path === '/oauth/access_token') return { access_token: 'EAA-user-token', expires_in: 5184000 };
      if (path !== '/me/accounts') return {};
      return {
        data: PAGES.map((p) => ({
          id: p.id, name: p.name, category: p.category, tasks: p.tasks,
          access_token: p.access_token, picture: { data: { url: `https://cdn/${p.id}.jpg` } }
        }))
      };
    },
    // Retained so the suite still exercises the opt-in POST path if the method
    // is switched back during the Real Meta Spike.
    post: async (path) => (path === '/oauth/access_token'
      ? { access_token: 'EAA-user-token', expires_in: 5184000 }
      : {})
  });

  const discovered = () => conn.listAvailablePages({ db: DB, userAccessToken: 'u' });
  let channelOne;

  {
    // Regression guard. connectPage() stores the per-Page token, so the
    // discovery result MUST carry it internally - an earlier version dropped it
    // and every single connect failed with CREDENTIAL_MISSING. The two checks
    // below pin both halves: carried inside the service, never across HTTP.
    const firstLook = await discovered();
    check('discovery carries the page token internally', firstLook[0].pageAccessToken === 'EAA-page-111');
    check('and the service is documented as internal-only',
      /SERVER-INTERNAL/.test(readFileSync(join(REPO, 'src/services/facebookConnections.js'), 'utf8')));

    const r = await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: TENANT_SCOPE,
      availablePages: await discovered(), pageId: '111', scopes: ['pages_show_list'], db: DB
    });
    channelOne = r.channelId;
    check('a page connects to a brand', r.pageId === '111');

    const { rows: [cred] } = await q(
      `SELECT value_encrypted, iv FROM provider_credentials WHERE kind='page_access_token' AND channel_id=$1`, [r.channelId]
    );
    check('a credential row exists', Boolean(cred));
    check('the credential is encrypted at rest, not plaintext',
      Buffer.from(cred.value_encrypted).toString('utf8') !== 'EAA-page-111');
    const { decrypt } = await import('../src/db/crypto.js');
    eq('and it decrypts back to the original token', decrypt(cred.value_encrypted, cred.iv), 'EAA-page-111');

    await rejects('a page outside the grant is refused', conn.CONNECTION_ERRORS.PAGE_NOT_IN_ACCOUNT,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: TENANT_SCOPE,
        availablePages: await discovered(), pageId: '999', db: DB
      }));

    await rejects('a read-only page is refused', conn.CONNECTION_ERRORS.PAGE_NOT_CONNECTABLE,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: TENANT_SCOPE,
        availablePages: await discovered(), pageId: '333', db: DB
      }));

    // Cross-BRAND: a brand of the same company that the caller was not granted.
    await rejects('a brand outside the caller brand scope is refused', conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1c, brandScope: FIRST_BRAND_ONLY,
        availablePages: await discovered(), pageId: '222', db: DB
      }));

    await rejects('a caller with zero brand grants is refused', conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: NO_BRANDS,
        availablePages: await discovered(), pageId: '222', db: DB
      }));

    // Cross-TENANT: the same page, claimed by a different company.
    await rejects('a page already owned by another company is refused',
      conn.CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT,
      async () => conn.connectPage({
        tenantId: t2, actorUserId: admin2, brandId: b2, brandScope: T2_BRAND_ONLY,
        availablePages: await discovered(), pageId: '111', db: DB
      }));

    // Cross-TENANT: a brand that belongs to somebody else.
    await rejects('a brand belonging to another company is refused', conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      async () => conn.connectPage({
        tenantId: t2, actorUserId: admin2, brandId: b1, brandScope: TENANT_SCOPE,
        availablePages: await discovered(), pageId: '222', db: DB
      }));

    // The refused attempts above must have left nothing behind.
    const { rows: [afterRefusals] } = await q(`SELECT count(*)::int n FROM channels WHERE external_id IN ('111','222','333')`);
    eq('no channel row was created by any refused attempt', afterRefusals.n, 1);
    const { rows: [credsAfter] } = await q(
      `SELECT count(*)::int n FROM provider_credentials pc JOIN channels c ON c.id=pc.channel_id WHERE c.external_id IN ('111','222','333')`
    );
    eq('and no credential row either', credsAfter.n, 1);

    // Reconnect inside the SAME company is allowed, and re-points the brand.
    const again = await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1b, brandScope: T1_BOTH_BRANDS,
      availablePages: await discovered(), pageId: '111', mode: 'reconnect', db: DB
    });
    check('reconnecting within the same company succeeds', again.pageId === '111');
    eq('and it reuses the same channel row', again.channelId, channelOne);
    const { rows: [moved] } = await q(`SELECT brand_id FROM channels WHERE id=$1`, [channelOne]);
    eq('and the page now points at the second brand', String(moved.brand_id), String(b1b));

    const { rows: [dup] } = await q(`SELECT count(*)::int n FROM channels WHERE external_id='111'`);
    eq('reconnect did not create a duplicate channel', dup.n, 1);
  }

  // ---------------------------------------------------------------- 9 concurrent connect
  section('9 concurrent connect of the same page');
  {
    const settled = await Promise.allSettled([
      conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: TENANT_SCOPE,
        availablePages: await discovered(), pageId: '222', db: DB
      }),
      conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1b, brandScope: T1_BOTH_BRANDS,
        availablePages: await discovered(), pageId: '222', db: DB
      })
    ]);
    const { rows: [counted] } = await q(`SELECT count(*)::int n FROM channels WHERE external_id='222'`);
    eq('concurrent connects of one page still produce exactly one channel', counted.n, 1);
    eq('exactly one concurrent connect succeeds',
      settled.filter((r) => r.status === 'fulfilled').length, 1);
    // The loser must surface as a CONFLICT, never as a raw database error.
    const loser = settled.find((r) => r.status === 'rejected');
    check('the losing concurrent connect is refused with a connection error',
      loser?.reason?.name === 'ConnectionError',
      `name=${loser?.reason?.name} code=${loser?.reason?.code}`);
    check('and with a code the API maps to 409',
      loser?.reason?.code === conn.CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED
      || loser?.reason?.code === conn.CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT,
      `code=${loser?.reason?.code}`);
  }

  // ---------------------------------------------------------------- 10 list + disconnect
  section('10 list and disconnect');
  {
    const list = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    eq('two connections are listed', list.length, 2);
    check('no token value appears anywhere in the listing', !JSON.stringify(list).includes('EAA-page'));
    check('credential presence is reported', list.every((c) => c.credentialPresent === true));
    check('expiry is surfaced as-is (null means unknown, not eternal)',
      list.every((c) => 'credentialExpiresAt' in c));

    // Section 8 left the Page '111' channel pointing at b1b, so scoping to b1 MUST
    // hide it. That is a deterministic assertion; the COUNT is not, because the
    // concurrent connect in section 9 decides which brand '222' wins.
    const scoped = await conn.listConnections({ db: DB, tenantId: t1, scope: { mode: 'restricted', brandIds: [b1] } });
    check('a brand-scoped listing never returns a connection outside the scope',
      scoped.every((c) => c.brand?.id === b1));
    check('a brand-scoped listing hides a connection on a brand outside the scope',
      !scoped.some((c) => c.id === channelOne));

    const tenantWide = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    check('a brand-scoped listing is a subset of the tenant-wide one',
      scoped.length <= tenantWide.length);

    eq('a caller with zero brand grants sees nothing',
      (await conn.listConnections({ db: DB, tenantId: t1, scope: NO_BRANDS })).length, 0);
    eq('an absent scope resolves to zero brands, never to everything',
      (await conn.listConnections({ db: DB, tenantId: t1, scope: undefined })).length, 0);

    eq('another company sees none of it',
      (await conn.listConnections({ db: DB, tenantId: t2, scope: TENANT_SCOPE })).length, 0);

    await conn.disconnectPage({ db: DB, tenantId: t1, actorUserId: admin1, channelId: channelOne });

    const { rows: [gone] } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [channelOne]
    );
    eq('the credential is removed on disconnect', gone.n, 0);

    const { rows: [kept] } = await q(`SELECT status FROM channels WHERE id=$1`, [channelOne]);
    eq('the channel row is kept, disabled, for history', kept.status, 'disabled');

    await rejects('disconnecting another company channel is refused', conn.CONNECTION_ERRORS.CHANNEL_NOT_FOUND,
      () => conn.disconnectPage({ db: DB, tenantId: t2, actorUserId: admin2, channelId: channelOne }));

    const afterDisconnect = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    check('a disconnected page is no longer reported as connected',
      afterDisconnect.filter((c) => c.credentialPresent).length === 1);
  }

  // ---------------------------------------------------------------- 11 audit
  section('11 audit trail');
  {
    const { rows: acts } = await q(
      `SELECT action, object_type, object_id FROM audit_logs WHERE object_type='channel' ORDER BY created_at`
    );
    const list = acts.map((r) => r.action);
    check('a connect was audited', list.includes('integrations.facebook.connect'));
    check('a reconnect was audited', list.includes('integrations.facebook.reconnect'));
    check('a disconnect was audited', list.includes('integrations.facebook.disconnect'));

    const { rows: conflict } = await q(
      `SELECT metadata FROM audit_logs WHERE action='integrations.facebook.connect.conflict'`
    );
    check('a connect refused for an ownership conflict is audited too', conflict.length === 1);
    check('and it records no token', !JSON.stringify(conflict).includes('EAA-'));

    // The conflict audit must not name the other company.
    const { rows: conflictRow } = await q(
      `SELECT metadata, object_id FROM audit_logs WHERE action='integrations.facebook.connect.conflict'`
    );
    check('the conflict audit records the page, not its real owner',
      conflictRow[0].object_id === '111' && !JSON.stringify(conflictRow[0].metadata).includes(String(t2)));
  }

  // ---------------------------------------------------------------- 12 parked user token
  section('12 parked user token handoff');
  {
    const s = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB
    });
    const claimed = await state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB });

    // The guard is "stash at most once per state", NOT "refuse a consumed state":
    // a consumed state with nothing parked yet is exactly the callback's normal
    // starting position.
    eq('the first stash on a consumed state is accepted',
      await state.stashUserToken({ stateId: claimed.id, userToken: 'EAA-secret-user-token', db: DB }), 1);
    eq('a second stash on the same state is refused',
      await state.stashUserToken({ stateId: claimed.id, userToken: 'EAA-overwritten', db: DB }), 0);
    eq('and the refused value never overwrote the parked one',
      await state.takeUserToken({ stateId: claimed.id, db: DB }), 'EAA-secret-user-token');

    const { rows: [enc] } = await q(`SELECT user_token_encrypted FROM oauth_states WHERE id=$1`, [claimed.id]);
    check('the parked token is encrypted at rest',
      Buffer.from(enc.user_token_encrypted).toString('utf8') !== 'EAA-secret-user-token');

    await state.takeUserToken({ stateId: claimed.id, db: DB, destroy: true });
    eq('and is destroyed after one use', await state.takeUserToken({ stateId: claimed.id, db: DB }), null);

    // Cross-user / cross-tenant read of a consumed state.
    const s2 = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB
    });
    const claimed2 = await state.consumeOAuthState({ state: s2.state, redirectUri: URI, db: DB });
    await rejects('a consumed state cannot be read by a different user', state.OAUTH_STATE_ERRORS.NOT_FOUND,
      () => state.readConsumedState({ stateId: claimed2.id, tenantId: t1, actorUserId: admin2, db: DB }));
    await rejects('a consumed state cannot be read from a different company', state.OAUTH_STATE_ERRORS.NOT_FOUND,
      () => state.readConsumedState({ stateId: claimed2.id, tenantId: t2, actorUserId: admin1, db: DB }));
    check('its owner can read it', Boolean(await state.readConsumedState({
      stateId: claimed2.id, tenantId: t1, actorUserId: admin1, db: DB
    })));
  }

  // ---------------------------------------------------------------- 13 purge
  section('13 purge');
  {
    await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB, ttlSeconds: -100000
    });
    const before = await q(`SELECT count(*)::int n FROM oauth_states WHERE expires_at < now() - interval '1 hour'`);
    const removed = await state.purgeExpiredOAuthStates({ db: DB, olderThanSeconds: 3600 });
    check('expired states are purged', removed >= 1 && removed <= before.rows[0].n);
  }

  // ---------------------------------------------------------------- 13b one-shot claim
  section('13b one-shot grant is an atomic claim, not a best-effort cleanup');
  {
    // Previously one-shot was INFERRED from the parked token being cleared in a
    // finally block whose errors are swallowed. This section proves it no longer
    // depends on that cleanup succeeding.
    const fresh = async () => {
      const s = await state.issueOAuthState({
        tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB
      });
      const c = await state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB });
      await state.stashUserToken({ stateId: c.id, userToken: 'EAA-t', db: DB });
      return c;
    };

    const g1 = await fresh();
    eq('an unspent grant claims successfully',
      await state.claimGrantForConfirm({ stateId: g1.id, tenantId: t1, actorUserId: admin1, db: DB }), true);
    eq('and a spent grant does not',
      await state.claimGrantForConfirm({ stateId: g1.id, tenantId: t1, actorUserId: admin1, db: DB }), false);
    check('grantIsSpent agrees', (await state.grantIsSpent({ stateId: g1.id, db: DB })) === true);

    // Even if the parked token is still present - the exact condition under which
    // the old, cleanup-dependent design would have allowed a second confirm -
    // the claim still refuses it.
    const g2 = await fresh();
    await state.claimGrantForConfirm({ stateId: g2.id, tenantId: t1, actorUserId: admin1, db: DB });
    check('the parked token is still readable after the claim',
      (await state.takeUserToken({ stateId: g2.id, db: DB })) === 'EAA-t');
    eq('but the grant cannot be claimed a second time',
      await state.claimGrantForConfirm({ stateId: g2.id, tenantId: t1, actorUserId: admin1, db: DB }), false);

    // Binding is enforced on the claim too.
    const g3 = await fresh();
    eq('a grant cannot be claimed by a different user',
      await state.claimGrantForConfirm({ stateId: g3.id, tenantId: t1, actorUserId: admin2, db: DB }), false);
    eq('nor by a different company',
      await state.claimGrantForConfirm({ stateId: g3.id, tenantId: t2, actorUserId: admin1, db: DB }), false);

    // Concurrency: many simultaneous claims, exactly one winner.
    const g4 = await fresh();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        state.claimGrantForConfirm({ stateId: g4.id, tenantId: t1, actorUserId: admin1, db: DB }))
    );
    eq('exactly one of 8 concurrent claims wins', results.filter(Boolean).length, 1);

    // An expired grant cannot be claimed.
    const sExp = await state.issueOAuthState({
      tenantId: t1, actorUserId: admin1, brandId: b1, redirectUri: URI, db: DB, ttlSeconds: -1
    });
    eq('an expired state cannot be consumed at all',
      await (async () => { try { await state.consumeOAuthState({ state: sExp.state, redirectUri: URI, db: DB }); return true; } catch { return false; } })(),
      false);
  }

  // ---------------------------------------------------------------- 14 HTTP gates
  section('14 HTTP authorization (real Express, real DB, mocked Meta)');
  {
    const express = (await import('express')).default;
    const { createApiV1Router } = await import('../src/api/v1/index.js');

    const appFor = ({ roles, customAbilities = [], tenant = t1, brandIds = undefined, allBrands = false, userId = admin1 }) => {
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId: tenant,
          user: { id: userId, email: 'a@b.local', name: 'A' },
          sessionId: '33333333-3333-3333-3333-333333333333',
          roles,
          brandIds,
          allBrandsInCompany: allBrands,
          customAbilities,
          isPlatformSuperAdmin: false
        })
      });
      app.use(express.json());
      app.use('/api/v1', router);
      return new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}/api/v1` }));
        servers.push(s);
      });
    };

    const authFor = async (base) => {
      const r = await fetch(`${base}/_health`);
      const c = (r.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      return { cookie: `lwc_session=x; ${c}`, csrf: c?.split('=')[1] };
    };
    const send = (base, auth, method, path, body) => fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: auth.cookie,
        ...(method === 'GET' ? {} : { 'x-csrf-token': auth.csrf })
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    // Company admin, tenant-wide brand scope.
    const ca = await appFor({ roles: ['Company Admin'], brandIds: null, allBrands: true });
    const caAuth = await authFor(ca.base);

    eq('connect without a brand is a 400',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', {})).status, 400);
    eq('connect with a malformed brand is a 400',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: 'nope' })).status, 400);
    eq('connect with an unknown brand is a 403',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect',
        { brandId: '00000000-0000-0000-0000-000000000000' })).status, 403);

    const started = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
    eq('an admin can start a connect', started.status, 200);
    const body = started.body?.data || {};
    check('an authorize url is returned', String(body.authorizeUrl).includes('facebook.com'));
    check('the authorize url carries the state', String(body.authorizeUrl).includes(String(body.state)));
    check('the authorize url requests only the B1 scopes',
      body.authorizeUrl.includes('pages_show_list') && !body.authorizeUrl.includes('pages_manage_posts'));
    check('PKCE challenge is present', body.authorizeUrl.includes('code_challenge'));
    check('no token is returned', !JSON.stringify(started.body).match(/EAA-/));

    // CSRF is enforced by the shared guard, not by B1.
    const noCsrf = await fetch(`${ca.base}/integrations/facebook/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: caAuth.cookie },
      body: JSON.stringify({ brandId: b1 })
    });
    eq('a POST without a CSRF token is refused', noCsrf.status, 403);

    // Abilities.
    const agent = await appFor({ roles: ['Agent'], brandIds: null, allBrands: true });
    const agentAuth = await authFor(agent.base);
    eq('a role without brand.integration.connect cannot start a connect',
      (await send(agent.base, agentAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 })).status, 403);
    eq('but the same role can read integration status',
      (await send(agent.base, agentAuth, 'GET', '/integrations/facebook/connections')).status, 200);

    const viewer = await appFor({ roles: ['Brand Viewer'], customAbilities: ['conversation.read'], brandIds: null, allBrands: true });
    const viewerAuth = await authFor(viewer.base);
    eq('a role with no integration abilities cannot list connections',
      (await send(viewer.base, viewerAuth, 'GET', '/integrations/facebook/connections')).status, 403);
    eq('nor can it start a connect',
      (await send(viewer.base, viewerAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 })).status, 403);

    // Brand scope at the HTTP edge.
    const restricted = await appFor({ roles: ['Company Admin'], brandIds: [b1] });
    const restrictedAuth = await authFor(restricted.base);
    eq('a brand-scoped admin cannot start a connect for a brand outside their scope',
      (await send(restricted.base, restrictedAuth, 'POST', '/integrations/facebook/connect', { brandId: b1c })).status, 403);
    eq('but can for a brand inside their scope',
      (await send(restricted.base, restrictedAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 })).status, 200);

    const noBrands = await appFor({ roles: ['Company Admin'], brandIds: [] });
    const noBrandsAuth = await authFor(noBrands.base);
    eq('an admin with zero brand grants cannot connect anything',
      (await send(noBrands.base, noBrandsAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 })).status, 403);

    // Callback negatives. The callback redirects into the app rather than
    // rendering JSON, so these are inspected with redirect: 'manual'.
    const noRedirect = { redirect: 'manual' };
    eq('a callback with no state is a 400',
      (await fetch(`${ca.base}/integrations/facebook/callback?code=abc`, noRedirect)).status, 400);

    const denied = await fetch(`${ca.base}/integrations/facebook/callback?state=x&error=access_denied`, noRedirect);
    eq('a denied callback is a 303 into the app', denied.status, 303);
    const deniedLoc = denied.headers.get('location') || '';
    check('the denial redirect names our own error code, not Meta text',
      deniedLoc.includes('error=META_ACCESS_DENIED') && !/facebook\.com/.test(deniedLoc));
    check('the denial redirect stays on the app origin', deniedLoc.startsWith('https://social.universalfoodco.com/'));

    eq('a callback with an unknown state is refused',
      (await fetch(`${ca.base}/integrations/facebook/callback?code=abc&state=not-a-real-state`, noRedirect)).status, 400);

    // Full round trip with the mocked exchange.
    const started2 = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
    const st2 = started2.body?.data?.state;
    const cb = await fetch(
      `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(st2)}`, noRedirect);
    eq('a valid callback redirects', cb.status, 303);
    const loc = cb.headers.get('location') || '';
    check('the success redirect goes to the app', loc.startsWith('https://social.universalfoodco.com/integrations/facebook'));
    check('and carries no token', !/EAA-/.test(loc));

    const sid = new URL(loc).searchParams.get('stateId');
    check('the success redirect carries a state id', /^[0-9a-f-]{36}$/.test(sid || ''));

    // The page list is fetched by the app over an authenticated call.
    const pagesRes = await send(ca.base, caAuth, 'GET', `/integrations/facebook/pages?stateId=${sid}`);
    eq('the owner can list the discovered pages', pagesRes.status, 200);
    const pageList = pagesRes.body?.data?.pages ?? [];
    eq('all three discovered pages come back', pageList.length, 3);
    check('read-only pages are flagged as not connectable',
      pageList.find((p) => p.pageId === '333')?.connectable === false);
    check('connectable pages are flagged as such',
      pageList.find((p) => p.pageId === '111')?.connectable === true);
    check('the page list carries no page tokens', !JSON.stringify(pageList).includes('EAA-page'));
    check('the page list carries no pageAccessToken field at all',
      pageList.every((p) => !('pageAccessToken' in p)));
    check('and no field value looks like a token',
      pageList.every((p) => Object.values(p).every((v) => !/EAA-/.test(String(v)))));

    // A malformed state id never reaches the database.
    eq('listing pages with a malformed stateId is a 400',
      (await send(ca.base, caAuth, 'GET', '/integrations/facebook/pages?stateId=nope')).status, 400);

    eq('confirm without a stateId is a 400',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm', { brandId: b1, pageId: '111' })).status, 400);
    eq('confirm with a malformed stateId is a 400',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1, pageId: '111', stateId: 'nope' })).status, 400);

    // EXACT BRAND BINDING. The grant is minted for one brand; confirm may not
    // silently retarget another, even one the caller is entitled to.
    {
      const startedMove = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
      const moveCb = await fetch(
        `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(startedMove.body.data.state)}`,
        noRedirect);
      const moveSid = new URL(moveCb.headers.get('location')).searchParams.get('stateId');

      const moved = await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1b, pageId: '111', stateId: moveSid });
      eq('confirming a different brand than the grant was issued for is a 409', moved.status, 409);
      check('and reports a distinct code',
        moved.body?.error?.code === 'BRAND_DOES_NOT_MATCH_GRANT', `code=${moved.body?.error?.code}`);

      // It must not have connected anything.
      const { rows: [onB1b] } = await q(
        `SELECT count(*)::int n FROM channels WHERE tenant_id=$1 AND brand_id=$2 AND oauth_provider='meta' AND status='active'`,
        [t1, b1b]);
      eq('and nothing was written for the retargeted brand', onB1b.n, 0);

      // The grant survives, so the user can simply confirm correctly.
      const right = await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1, pageId: '111', stateId: moveSid });
      eq('confirming the brand the grant was issued for still works', right.status, 201);
    }

    // Cross-tenant: another company must not be able to use this state id.
    const other = await appFor({ roles: ['Company Admin'], brandIds: null, allBrands: true, tenant: t2, userId: admin2 });
    const otherAuth = await authFor(other.base);
    eq('another company cannot read the pages of this grant',
      (await send(other.base, otherAuth, 'GET', `/integrations/facebook/pages?stateId=${sid}`)).status, 400);
    eq('nor confirm with it',
      (await send(other.base, otherAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b2, pageId: '222', stateId: sid })).status, 400);

    // Owner confirms.
    const confirmed = await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
      { brandId: b1, pageId: '111', stateId: sid });
    eq('the owner can confirm', confirmed.status, 201);
    check('and the response carries no token', !JSON.stringify(confirmed.body).includes('EAA-'));

    eq('the grant is one-shot: a second confirm is refused',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1, pageId: '222', stateId: sid })).status, 410);
    eq('and re-listing through the spent grant is a 410',
      (await send(ca.base, caAuth, 'GET', `/integrations/facebook/pages?stateId=${sid}`)).status, 410);

    // Confirming a read-only page is refused at the HTTP edge too.
    const started3 = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
    const cb3 = await fetch(
      `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(started3.body.data.state)}`,
      noRedirect);
    const sid3 = new URL(cb3.headers.get('location')).searchParams.get('stateId');
    eq('confirming a read-only page is a 422',
      (await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1, pageId: '333', stateId: sid3 })).status, 422);

    // Listing at the HTTP edge.
    const listed = await send(ca.base, caAuth, 'GET', '/integrations/facebook/connections');
    eq('connections can be listed', listed.status, 200);
    check('and the listing carries no token', !JSON.stringify(listed.body).includes('EAA-'));

    eq('listing with a malformed brandId is a 400',
      (await send(ca.base, caAuth, 'GET', '/integrations/facebook/connections?brandId=nope')).status, 400);
    eq('disconnecting with a malformed id is a 400',
      (await send(ca.base, caAuth, 'DELETE', '/integrations/facebook/connections/nope')).status, 400);
    eq('disconnecting an unknown channel is a 404',
      (await send(ca.base, caAuth, 'DELETE',
        '/integrations/facebook/connections/00000000-0000-0000-0000-000000000000')).status, 404);
    // ============================================ 15 PKCE round trip + config_id
    // Added after the review defect: B1 sent `code_challenge` to Meta but stored
    // only SHA-256(verifier) and never sent `code_verifier` back at the exchange.
    // Since PKCE requires the RAW verifier, every REAL connect would fail at token
    // exchange - while all 196 prior assertions stayed green, because the suite
    // only ever asserted the challenge went OUT. A mock that only COUNTS calls
    // cannot see a missing parameter; the mock below RECORDS them.
    section('15 PKCE verifier round trip and config_id');

    {
      const nodeCrypto = await import('node:crypto');
      const NR = { redirect: 'manual' };
      const REAL_FETCH = globalThis.fetch;
      let capturedExchange = null;

      metaOAuth.setGraphTransport({
        post: async () => ({ access_token: 'EAA-mock' }),
        get: async (path, params) => {
          if (path === '/oauth/access_token') { capturedExchange = { ...params }; return { access_token: 'EAA-mock' }; }
          return { data: [] };
        }
      });

      try {
        // ---------------------------------------------------------- challenge
        const pk = state.generatePkce();
        check('a PKCE verifier is generated', typeof pk.verifier === 'string' && pk.verifier.length >= 43);
        eq('the challenge is the base64url S256 of the verifier',
          pk.challenge, nodeCrypto.createHash('sha256').update(pk.verifier, 'utf8').digest('base64url'));
        check('two verifiers are never equal', state.generatePkce().verifier !== state.generatePkce().verifier);

        // ------------------------------------------- encrypted persistence
        const issued = await state.issueOAuthState({
          tenantId: t1, actorUserId: admin1, provider: 'meta', brandId: b1,
          redirectUri: URI, pkceVerifier: pk.verifier, db: DB
        });
        const { rows: vr } = await q(
          `SELECT code_verifier_hash, code_verifier_encrypted, code_verifier_iv
             FROM oauth_states WHERE state_hash = $1`,
          [state.hashState(issued.state)]
        );
        check('the RAW verifier is stored, not only its digest', Boolean(vr[0].code_verifier_encrypted));
        check('the ciphertext does not contain the plaintext verifier',
          !vr[0].code_verifier_encrypted.toString('binary').includes(pk.verifier.slice(0, 24)));
        eq('the verifier is stored with a 12-byte IV', vr[0].code_verifier_iv.length, 12);
        eq('the integrity digest is also stored', vr[0].code_verifier_hash.length, 32);

        // ------------------------------------------- claim does not release it
        const claimedPk = await state.consumeOAuthState({ state: issued.state, redirectUri: URI, db: DB });
        check('the claim reports that a verifier exists', claimedPk.hasCodeVerifier === true);
        check('the claim does NOT hand back the ciphertext', claimedPk.codeVerifierEncrypted === undefined);
        check('the claim does NOT hand back the plaintext verifier',
          JSON.stringify(claimedPk).includes(pk.verifier) === false);

        // ------------------------------------------- release + destroy on read
        const released = await state.takePkceVerifier({
          stateId: claimedPk.id, expectedHash: claimedPk.codeVerifierHash, db: DB
        });
        eq('the released verifier is byte-identical to the generated one', released, pk.verifier);
        // Regression for a real bug found by this section: PostgreSQL's
        // `UPDATE ... RETURNING` yields the NEW row, so destroying the ciphertext
        // in the same statement returned NULL on every call. A destroy-and-return
        // helper must read the OLD value, via a CTE.
        check('destroy-on-read returns the value it destroyed, not the NULL it wrote',
          released !== null && released !== undefined && released === pk.verifier);

        const { rows: gone } = await q(
          `SELECT code_verifier_encrypted, code_verifier_iv FROM oauth_states WHERE id = $1`, [claimedPk.id]);
        check('the verifier ciphertext is destroyed on read', gone[0].code_verifier_encrypted === null);
        check('the verifier IV is destroyed on read', gone[0].code_verifier_iv === null);
        eq('a second read returns nothing', await state.takePkceVerifier({ stateId: claimedPk.id, db: DB }), null);

        // ------------------------------------------- corrupt ciphertext refused
        const corrupt = await state.issueOAuthState({
          tenantId: t1, actorUserId: admin1, provider: 'meta', brandId: b1,
          redirectUri: URI, pkceVerifier: pk.verifier, db: DB
        });
        const corruptClaim = await state.consumeOAuthState({ state: corrupt.state, redirectUri: URI, db: DB });
        await q(`UPDATE oauth_states SET code_verifier_encrypted = $2 WHERE id = $1`,
          [corruptClaim.id, Buffer.concat([Buffer.alloc(16), Buffer.from('tampered-value')])]);
        await rejects('a tampered verifier ciphertext is refused, never returned',
          state.OAUTH_STATE_ERRORS.CRYPTO_UNAVAILABLE,
          () => state.takePkceVerifier({ stateId: corruptClaim.id, db: DB }));

        // ------------------------------- THE assertion the old suite lacked
        capturedExchange = null;
        await metaOAuth.exchangeCode({ code: 'CODE', redirectUri: URI, codeVerifier: pk.verifier });
        check('code_verifier IS sent on the code exchange', Boolean(capturedExchange?.code_verifier));
        eq('the code_verifier sent is the released one', capturedExchange.code_verifier, pk.verifier);

        capturedExchange = null;
        await metaOAuth.exchangeCode({ code: 'CODE', redirectUri: URI, codeVerifier: null });
        check('no code_verifier is sent when PKCE is off', !capturedExchange?.code_verifier);

        // ------------------------------------------- end to end over HTTP
        const e2e = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
        const e2eHash = nodeCrypto.createHash('sha256').update(e2e.body.data.state, 'utf8').digest();
        capturedExchange = null;
        const e2eCb = await fetch(
          `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(e2e.body.data.state)}`, NR);
        eq('the end-to-end callback still redirects into the app', e2eCb.status, 303);
        check('THE DEFECT: the callback sends code_verifier on the exchange', Boolean(capturedExchange?.code_verifier));

        const { rows: e2eRow } = await q(
          `SELECT code_verifier_encrypted FROM oauth_states WHERE state_hash = $1`, [e2eHash]);
        check('the verifier is not left behind after a completed callback', e2eRow[0].code_verifier_encrypted === null);

        eq('the state cannot be replayed after a successful exchange',
          (await fetch(`${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(e2e.body.data.state)}`, NR)).status, 400);

        // ------------------------------------------- concurrency
        const cs = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
        const csUrl = `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(cs.body.data.state)}`;
        const conc = await Promise.all([fetch(csUrl, NR), fetch(csUrl, NR), fetch(csUrl, NR)]);
        eq('exactly one of three concurrent callbacks succeeds', conc.filter((r) => r.status === 303).length, 1);

        // ------------------------------------------- PKCE off, end to end
        const savedPkce = process.env.META_OAUTH_PKCE;
        process.env.META_OAUTH_PKCE = 'false';
        try {
          const np = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
          check('with PKCE off there is no code_challenge in the authorize URL',
            !np.body.data.authorizeUrl.includes('code_challenge'));
          capturedExchange = null;
          await fetch(`${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(np.body.data.state)}`, NR);
          check('with PKCE off no code_verifier is sent', !capturedExchange?.code_verifier);
        } finally {
          process.env.META_OAUTH_PKCE = savedPkce;
        }

        // ------------------------------------------- config_id
        const savedCid = process.env.META_OAUTH_CONFIG_ID;
        try {
          delete process.env.META_OAUTH_CONFIG_ID;
          eq('without config_id the authorize URL is unchanged',
            metaOAuth.configId(), null);
          check('no config_id parameter appears when unset',
            !metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S' }).includes('config_id'));

          process.env.META_OAUTH_CONFIG_ID = '1673966207646736';
          eq('configId() reads the configured value', metaOAuth.configId(), '1673966207646736');
          check('config_id is present in the authorize URL when configured',
            metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S' }).includes('config_id=1673966207646736'));

          process.env.META_OAUTH_CONFIG_ID = 'abc&evil=1';
          let threw = null;
          try { metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S' }); } catch (e) { threw = e.code; }
          eq('a config_id carrying URL syntax is refused', threw, metaOAuth.META_OAUTH_ERRORS.MISSING_CONFIG);
        } finally {
          if (savedCid === undefined) delete process.env.META_OAUTH_CONFIG_ID;
          else process.env.META_OAUTH_CONFIG_ID = savedCid;
        }

        // ------------------------------------------- redaction
        const PROBE = 'PROBE-VERIFIER-abcdefghijklmnopqrst';
        const probeState = await state.issueOAuthState({
          tenantId: t1, actorUserId: admin1, provider: 'meta', brandId: b1,
          redirectUri: URI, pkceVerifier: PROBE, db: DB
        });
        const { rows: probeRow } = await q(
          `SELECT code_verifier_encrypted::text AS enc FROM oauth_states WHERE state_hash = $1`,
          [state.hashState(probeState.state)]
        );
        check('the verifier is never stored in the clear', !probeRow[0].enc.includes('abcdefghijklmnopqrst'));
        const { rows: probeCol } = await q(
          `SELECT count(*)::int n FROM oauth_states WHERE code_verifier_encrypted IS NOT NULL AND state_hash = $1`,
          [state.hashState(probeState.state)]
        );
        eq('the probe row still holds exactly one encrypted verifier', probeCol[0].n, 1);
      } finally {
        globalThis.fetch = REAL_FETCH;
        metaOAuth.resetGraphTransport();
      }
    }
  }

  metaOAuth.resetGraphTransport();
} catch (e) {
  failures.push(`fatal: ${e?.code ?? ''} ${e?.message}`);
  console.error('\nfatal:', e?.code, e?.message, e?.stack);
} finally {
  for (const s of servers) { try { s.close(); } catch {} }
  await pool.end().catch(() => {});
  await client.end().catch(() => {});
}

console.log(`\n${'='.repeat(64)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('='.repeat(64));

// A COUNT FLOOR, not just a zero check. If a section throws, the suite dies and
// the remaining sections never run - the run must fail rather than report a
// short pass. This number is the verified count as of run 39218882467; raise it
// when adding coverage, never lower it.
// Raised 196 -> 228 for the PKCE/config_id section. The floor is precisely what
// would have caught the original defect: the suite could report 196 passing
// while never once asserting that code_verifier is sent at the exchange.
const MIN_ASSERTIONS = 228;
if (pass < MIN_ASSERTIONS) {
  console.log(`  ERROR: ${pass} assertions executed, expected at least ${MIN_ASSERTIONS}.`);
  console.log('  This is NOT a pass - sections were almost certainly skipped.');
  process.exit(1);
}
console.log(`  assertion floor satisfied (${pass} >= ${MIN_ASSERTIONS})`);

if (pass === 0) {
  console.log('  ERROR: zero assertions executed - this is NOT a pass');
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);
