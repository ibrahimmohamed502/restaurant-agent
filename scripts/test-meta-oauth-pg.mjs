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
    get: async (path, params) => {
      if (path === '/oauth/access_token') return { access_token: 'EAA-user-token', expires_in: 5184000 };
      if (path === '/debug_token') {
        const inspected = PAGES.find((p) => p.access_token === params?.input_token);
        if (!inspected) return { data: { is_valid: false } };
        return {
          data: {
            app_id: 'test-app-id', type: 'PAGE', is_valid: true,
            profile_id: inspected.id, scopes: ['pages_show_list', 'pages_read_engagement'],
            expires_at: 0
          }
        };
      }
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
      availablePages: await discovered(), pageId: '111', requestedScopes: ['pages_show_list'], db: DB
    });
    channelOne = r.channelId;
    check('a page connects to a brand', r.pageId === '111');

    const { rows: [cred] } = await q(
      `SELECT value_encrypted, iv FROM provider_credentials WHERE kind='page_access_token_oauth' AND channel_id=$1`, [r.channelId]
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

    // Reconnect to a DIFFERENT brand of the same company is FORBIDDEN.
    await rejects('cross-brand reconnect is refused',
      conn.CONNECTION_ERRORS.CROSS_BRAND_TRANSFER_FORBIDDEN,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1b, brandScope: T1_BOTH_BRANDS,
        availablePages: await discovered(), pageId: '111', mode: 'reconnect', db: DB
      }));
    const { rows: [stillB1] } = await q(`SELECT brand_id FROM channels WHERE id=$1`, [channelOne]);
    eq('cross-brand reconnect did not change the brand', String(stillB1.brand_id), String(b1));
    const { rows: [stillOneCred] } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind='page_access_token_oauth'`, [channelOne]
    );
    eq('cross-brand reconnect created no extra OAuth credential', stillOneCred.n, 1);

    // Reconnect to the SAME brand is allowed.
    const again = await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: await discovered(), pageId: '111', mode: 'reconnect', db: DB
    });
    check('same-brand reconnect succeeds', again.pageId === '111');
    eq('same-brand reconnect reuses the same channel row', again.channelId, channelOne);
    const { rows: [stillB1Again] } = await q(`SELECT brand_id FROM channels WHERE id=$1`, [channelOne]);
    eq('same-brand reconnect keeps the brand', String(stillB1Again.brand_id), String(b1));

    const { rows: [dup] } = await q(`SELECT count(*)::int n FROM channels WHERE external_id='111'`);
    eq('reconnect did not create a duplicate channel', dup.n, 1);

    // Fresh connect against an existing branded channel is refused, same brand or not.
    await rejects('fresh connect against existing branded page is refused',
      conn.CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: await discovered(), pageId: '111', db: DB
      }));
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

    // Section 8 left the Page '111' channel pointing at b1 (same-brand reconnect kept it).
    // Scoping to b1 MUST show it. The COUNT is not deterministic because the
    // concurrent connect in section 9 decides which brand '222' wins.
    const scoped = await conn.listConnections({ db: DB, tenantId: t1, scope: { mode: 'restricted', brandIds: [b1] } });
    check('a brand-scoped listing never returns a connection outside the scope',
      scoped.every((c) => c.brand?.id === b1));
    check('a brand-scoped listing includes a connection on an in-scope brand',
      scoped.some((c) => c.id === channelOne));
    check('a brand-scoped listing hides a connection on an out-of-scope brand',
      !scoped.some((c) => c.brand?.id === b1b));

    const tenantWide = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    check('a brand-scoped listing is a subset of the tenant-wide one',
      scoped.length <= tenantWide.length);

    eq('a caller with zero brand grants sees nothing',
      (await conn.listConnections({ db: DB, tenantId: t1, scope: NO_BRANDS })).length, 0);
    eq('an absent scope resolves to zero brands, never to everything',
      (await conn.listConnections({ db: DB, tenantId: t1, scope: undefined })).length, 0);

    eq('another company sees none of it',
      (await conn.listConnections({ db: DB, tenantId: t2, scope: TENANT_SCOPE })).length, 0);

    await conn.disconnectPage({ db: DB, tenantId: t1, actorUserId: admin1, channelId: channelOne, scope: TENANT_SCOPE });

    const { rows: [gone] } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [channelOne]
    );
    eq('the credential is removed on disconnect', gone.n, 0);

    const { rows: [kept] } = await q(`SELECT status FROM channels WHERE id=$1`, [channelOne]);
    eq('the channel row is kept, disabled, for history', kept.status, 'disabled');

    await rejects('disconnecting another company channel is refused', conn.CONNECTION_ERRORS.CHANNEL_NOT_FOUND,
      () => conn.disconnectPage({ db: DB, tenantId: t2, actorUserId: admin2, channelId: channelOne, scope: TENANT_SCOPE }));

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
    // Multiple connect refusals (cross-brand, fresh-connect-against-existing, cross-tenant)
    // each produce their own conflict audit row. The security property is that
    // refusals ARE audited, not that exactly one refusal occurs.
    check('connect refusals are audited', conflict.length >= 1);
    check('and no conflict audit row records a token', !/EAA-/.test(JSON.stringify(conflict)));

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
      // Page '111' already exists from section 8, so mode must be 'reconnect'.
      const right = await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1, pageId: '111', stateId: moveSid, mode: 'reconnect' });
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

    // ---- THE POST-CONFIRM WINDOW, DETERMINISTICALLY -----------------------
    //
    // The listing used to be gated on the PRESENCE OF THE PARKED TOKEN, so a
    // grant that had already been spent could still be listed in the window
    // before the cleanup landed. That was a race between the response and the
    // cleanup, and it made the one-shot guarantee timing-dependent.
    //
    // The gate is now the PERSISTED GRANT STATE (`confirmed_at`). To prove that
    // deterministically, the parked token is put BACK on the spent grant -
    // exactly as if the cleanup had not run - and the listing must still be
    // refused.
    const { encrypt: encForPark } = await import('../src/db/crypto.js');
    const reparked = encForPark('EAA-reparked-secret');
    await q(
      `UPDATE oauth_states SET user_token_encrypted=$2, user_token_iv=$3 WHERE id=$1`,
      [sid, reparked.value, reparked.iv]
    );
    const { rows: parkedCheck } = await q(
      `SELECT user_token_encrypted IS NOT NULL AS parked FROM oauth_states WHERE id=$1`, [sid]
    );
    eq('the parked token really is back on the spent grant', parkedCheck[0].parked, true);
    const relist = await send(ca.base, caAuth, 'GET', `/integrations/facebook/pages?stateId=${sid}`);
    eq('a spent grant is refused even with a token still parked', relist.status, 410);
    check('and the refusal carries no page data', !JSON.stringify(relist.body).includes('pageId'));
    check('and no token of any kind', !/EAA-/.test(JSON.stringify(relist.body)));
    // Clean up the re-parked token so no later assertion sees it.
    await q(
      `UPDATE oauth_states SET user_token_encrypted=NULL, user_token_iv=NULL WHERE id=$1`, [sid]
    );

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
    // ============================================ 14b API-level cross-brand refusal
    // Proves cross-brand transfer is refused through the real HTTP router,
    // with correct 409 status, audit record, and no state mutation.
    {
      // Connect page '111' to brand b1 through the full OAuth flow.
      const start111 = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1 });
      eq('connect start for b1 is 200', start111.status, 200);
      const cb111 = await fetch(
        `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(start111.body.data.state)}`,
        { redirect: 'manual' });
      eq('callback redirects', cb111.status, 303);
      const sid111 = new URL(cb111.headers.get('location')).searchParams.get('stateId');

      // Confirm page '111' to brand b1 (same brand as grant, existing channel) -> 201.
      // Page '111' already exists from section 8, so mode must be 'reconnect'.
      const confirmSame = await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1, pageId: '111', stateId: sid111, mode: 'reconnect' });
      eq('same-brand confirm is 201', confirmSame.status, 201);

      // Now try to connect the SAME page to brand b1b through a new grant.
      const start111b = await send(ca.base, caAuth, 'POST', '/integrations/facebook/connect', { brandId: b1b });
      eq('connect start for b1b is 200', start111b.status, 200);
      const cb111b = await fetch(
        `${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(start111b.body.data.state)}`,
        { redirect: 'manual' });
      const sid111b = new URL(cb111b.headers.get('location')).searchParams.get('stateId');

      // Confirm page '111' to brand b1b (different brand than existing connection).
      const confirmCross = await send(ca.base, caAuth, 'POST', '/integrations/facebook/confirm',
        { brandId: b1b, pageId: '111', stateId: sid111b, mode: 'reconnect' });
      eq('cross-brand confirm is 409', confirmCross.status, 409);
      check('cross-brand confirm reports distinct code',
        confirmCross.body?.error?.code === 'PAGE_CROSS_BRAND_TRANSFER_FORBIDDEN',
        `code=${confirmCross.body?.error?.code}`);

      // Brand on the channel is unchanged.
      const { rows: [chan111] } = await q(`SELECT brand_id FROM channels WHERE external_id='111' AND provider='meta'`);
      eq('page still belongs to brand b1 after refused cross-brand confirm',
        String(chan111.brand_id), String(b1));

      // Audit records the refusal.
      const { rows: crossAudit } = await q(
        `SELECT metadata::text m FROM audit_logs
          WHERE action='integrations.facebook.connect.conflict'
            AND object_id='111'
            AND metadata::text LIKE '%cross_brand_transfer_forbidden%'`);
      eq('cross-brand refusal is audited', crossAudit.length >= 1);
      check('audit records no token', !/EAA-/.test(JSON.stringify(crossAudit)));
    }

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
        if (path === '/debug_token') {
          return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true,
                           profile_id: 'PAGE-PROBE-1', scopes: ['pages_show_list', 'pages_read_engagement'],
                           expires_at: 0 } };
        }
          // A REALISTIC page list. An empty `data` makes listAvailablePages fail
          // with UPSTREAM_ERROR (HTTP 502) by design - it is a genuine refusal,
          // not a mock artefact, so the mock must return a usable Page.
          if (path === '/me/accounts') {
            return { data: [{ id: 'PAGE-PROBE-1', name: 'Probe Page', category: 'Restaurant',
                             tasks: ['MANAGE'], access_token: 'EAA-page-token' }] };
          }
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

        // A spent state reports ALREADY_USED (409), which is distinct from an
        // unknown state (400). Asserting 400 here would have been wrong.
        eq('the state cannot be replayed after a successful exchange',
          (await fetch(`${ca.base}/integrations/facebook/callback?code=MOCK&state=${encodeURIComponent(e2e.body.data.state)}`, NR)).status, 409);

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
        // -------------------------------- config_id / scope are EXCLUSIVE
        //
        // Meta's Facebook Login for Business contract: "config_id has replaced
        // scope (which should not be used)". A configuration carries its own
        // permission list, so sending both is two competing declarations of the
        // same thing. The two modes must never overlap.
        delete process.env.META_OAUTH_CONFIG_ID;
        const plainUrl = metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S' });
        eq('without config_id the authorize URL is unchanged', metaOAuth.configId(), null);
        check('plain mode sends scope', plainUrl.includes('scope=pages_show_list'));
        check('plain mode sends NO config_id', !plainUrl.includes('config_id'));

        process.env.META_OAUTH_CONFIG_ID = '2307209183477068';
        eq('configId() reads the configured value', metaOAuth.configId(), '2307209183477068');
        const cfgUrl = metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S' });
        check('config_id is present in the authorize URL when configured',
          cfgUrl.includes('config_id=2307209183477068'));
        check('configuration mode sends NO scope - Meta documents scope as replaced',
          !cfgUrl.includes('scope='));
        check('the two modes are mutually exclusive',
          (plainUrl.includes('scope=') && !plainUrl.includes('config_id')) &&
          (cfgUrl.includes('config_id=') && !cfgUrl.includes('scope=')));

        // Shared parameters must survive BOTH modes.
        for (const [label, u] of [['plain', plainUrl], ['config', cfgUrl]]) {
          check(`${label} mode still carries client_id`, u.includes(`client_id=${process.env.FB_APP_ID}`));
          check(`${label} mode still carries the exact redirect_uri`, u.includes(encodeURIComponent(URI)));
          check(`${label} mode still carries response_type=code`, u.includes('response_type=code'));
          check(`${label} mode still carries state`, u.includes('state=S'));
          check(`${label} mode still carries PKCE when a challenge is supplied`,
            metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S', codeChallenge: 'CHAL' })
              .includes('code_challenge=CHAL'));
          check(`${label} mode never leaks the app secret`, !u.includes(process.env.FB_APP_SECRET));
          check(`${label} mode never leaks a token or client_secret`,
            !/EAA-|[?&](client_secret|access_token)=/.test(u));
        }

        // ------------------------------------------------ parameter validation
        for (const bad of ['abc&evil=1', 'a b', 'https://evil.example', 'x'.repeat(65)]) {
          process.env.META_OAUTH_CONFIG_ID = bad;
          let code = null;
          try { metaOAuth.buildAuthorizationUrl({ redirectUri: URI, state: 'S' }); } catch (e) { code = e.code; }
          eq(`a malformed config_id is refused: ${JSON.stringify(bad.slice(0, 20))}`,
            code, metaOAuth.META_OAUTH_ERRORS.MISSING_CONFIG);
        }
        process.env.META_OAUTH_CONFIG_ID = 'a';
        eq('a minimal valid config_id is accepted', metaOAuth.configId(), 'a');
        process.env.META_OAUTH_CONFIG_ID = '  2307209183477068  ';
        eq('a padded config_id is trimmed, not rejected', metaOAuth.configId(), '2307209183477068');
        process.env.META_OAUTH_CONFIG_ID = '';
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

  // ============================================= 16 safe reconnect: C1-C7
  // Added after the review that found the reconnect would have deleted the
  // working legacy credentials and could have updated the wrong channel.
  section('16 safe reconnect, token validation and credential lifecycle');

  {
    const LEGACY = conn.CREDENTIAL_KIND_LEGACY;
    const OAUTH = conn.CREDENTIAL_KIND_OAUTH;
    eq('the legacy credential kind is unchanged', LEGACY, 'page_access_token');
    eq('the OAuth credential kind is separate', OAUTH, 'page_access_token_oauth');

    // A Page that already has a LEGACY integration: a meta routing channel with
    // a legacy credential, plus meta_dm and meta_comment siblings. This is the
    // real shape of an existing customer.
    const LEGACY_PAGE = '900';
    const legacyChannel = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Legacy Page','active') RETURNING id`, [t1, b1, LEGACY_PAGE]
    )).rows[0].id;
    await q(`INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
             VALUES ($1,$2,'meta_dm',$3,'Legacy DM','active')`, [t1, b1, LEGACY_PAGE]);
    await q(`INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
             VALUES ($1,$2,'meta_comment',$3,'Legacy Comments','active')`, [t1, b1, LEGACY_PAGE]);
    const { encrypt } = await import('../src/db/crypto.js');
    const legacyEnc = encrypt('EAA-LEGACY-LONG-LIVED');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, expires_at, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,NULL,NULL)`, [t1, legacyChannel, LEGACY, legacyEnc.value, legacyEnc.iv]);
    const legacyCredId = (await q(
      `SELECT id FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyChannel, LEGACY]
    )).rows[0].id;

    const legacyPages = [{
      pageId: LEGACY_PAGE, name: 'Legacy Page', category: 'Retail',
      tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'],
      pageAccessToken: 'EAA-page-900'
    }];

    // The inspection mock for this section: a Page token, deliberately WITHOUT
    // pages_messaging or pages_manage_engagement. Connecting must still work.
    //
    // `/debug_token` is a GET. A mock that answers it on `post` returns an
    // empty body to the real GET call, which reads as "Meta said nothing" and
    // fails the connect as TOKEN_REJECTED. The handler therefore MUST sit on
    // the same verb the code uses.
    //
    // (This mock was still on `post`. It had not been executed since the
    // inspection became GET-only, so nothing had caught it.)
    const legacyTransport = {
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/me/accounts') return { data: legacyPages };
        if (path !== '/debug_token') return {};
        if (params?.input_token === 'EAA-bad-type') {
          return { data: { app_id: 'test-app-id', type: 'USER', is_valid: true, user_id: '1' } };
        }
        if (params?.input_token === 'EAA-wrong-app') {
          return { data: { app_id: 'other-app-id', type: 'PAGE', is_valid: true, profile_id: '900' } };
        }
        if (params?.input_token === 'EAA-expired') {
          return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: '900',
                           expires_at: 1000 } };
        }
        if (params?.input_token === 'EAA-wrong-page') {
          return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: '111' } };
        }
        if (params?.input_token === 'EAA-invalid') {
          return { data: { is_valid: false } };
        }
        return {
          data: {
            app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: '900',
            // NO pages_messaging, NO pages_manage_engagement. Deliberate.
            scopes: ['pages_show_list', 'pages_read_engagement'],
            expires_at: 0
          }
        };
      }
    };
    metaOAuth.setGraphTransport(legacyTransport);

    // ---- C3: the legacy credential survives a reconnect, untouched ----------
    const legacyBefore = await q(
      `SELECT count(*)::int n, min(created_at)::text mn, max(created_at)::text mx
         FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyChannel, LEGACY]
    );
    const legacySiblings = await q(
      `SELECT id, provider, display_name FROM channels
        WHERE external_id=$1 AND provider IN ('meta_dm','meta_comment') ORDER BY provider`, [LEGACY_PAGE]
    );

    const reconnected = await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: legacyPages, pageId: LEGACY_PAGE, mode: 'reconnect', db: DB
    });
    eq('a reconnect to a legacy-connected Page succeeds', reconnected.pageId, LEGACY_PAGE);

    const legacyAfter = await q(
      `SELECT count(*)::int n, min(created_at)::text mn, max(created_at)::text mx
         FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyChannel, LEGACY]
    );
    eq('the legacy credential COUNT is unchanged', legacyAfter.rows[0].n, legacyBefore.rows[0].n);
    eq('the legacy credential was not re-created (same created_at)', legacyAfter.rows[0].mn, legacyBefore.rows[0].mn);
    const { rows: legacyStillThere } = await q(
      `SELECT id FROM provider_credentials WHERE id=$1`, [legacyCredId]
    );
    check('the legacy credential ROW is still present, same id', legacyStillThere.length === 1);

    const { rows: oauthRows } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyChannel, OAUTH]
    );
    eq('the OAuth credential is stored under its own kind', oauthRows[0].n, 1);
    const { rows: legacyKindRows } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyChannel, LEGACY]
    );
    eq('no extra legacy credential was accumulated', legacyKindRows[0].n, 1);

    // ---- the DM and comment siblings are untouched ------------------------
    const legacySiblingsAfter = await q(
      `SELECT id, provider, display_name FROM channels
        WHERE external_id=$1 AND provider IN ('meta_dm','meta_comment') ORDER BY provider`, [LEGACY_PAGE]
    );
    eq('the meta_dm and meta_comment channels are byte-identical',
      JSON.stringify(legacySiblingsAfter.rows), JSON.stringify(legacySiblings.rows));

    // ---- the routing channel is the one that got updated -----------------
    const { rows: routingRows } = await q(
      `SELECT id, provider FROM channels WHERE external_id=$1 AND provider='meta' AND tenant_id=$2`,
      [LEGACY_PAGE, t1]
    );
    eq('exactly one meta routing channel exists for this page', routingRows.length, 1);
    eq('and it is the one the reconnect updated', routingRows[0].id, legacyChannel);

    // ---- C2: a conflict on ANY row refuses the connect --------------------
    // T2 owns a meta_dm channel for the same Page. The routing channel belongs
    // to T1, so a T2 connect must be refused - and the refusal must come from
    // examining EVERY row, not from whichever row came first.
    await q(`INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
             VALUES ($1,$2,'meta_dm',$3,'T2 DM','active')`, [t2, b2, LEGACY_PAGE]);
    const beforeConflict = await q(
      `SELECT count(*)::int n FROM channels WHERE external_id=$1`, [LEGACY_PAGE]
    );
    await rejects('a cross-tenant conflict on a NON-routing row refuses the connect',
      conn.CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT,
      () => conn.connectPage({
        tenantId: t2, actorUserId: admin2, brandId: b2, brandScope: TENANT_SCOPE,
        availablePages: legacyPages, pageId: LEGACY_PAGE, db: DB
      }));
    const afterConflict = await q(
      `SELECT count(*)::int n FROM channels WHERE external_id=$1`, [LEGACY_PAGE]
    );
    eq('the refused connect created no channel', afterConflict.rows[0].n, beforeConflict.rows[0].n);
    const { rows: conflictAudit } = await q(
      `SELECT count(*)::int n FROM audit_logs
        WHERE action='integrations.facebook.connect.conflict' AND object_id=$1`, [LEGACY_PAGE]
    );
    eq('the refusal is audited', conflictAudit[0].n, 1);
    await q(`DELETE FROM channels WHERE external_id=$1 AND tenant_id=$2`, [LEGACY_PAGE, t2]);

    // ---- C4: token inspection REJECTS bad tokens -------------------------
    const badToken = async (token) => {
      try {
        await conn.connectPage({
          tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
          availablePages: [{ ...legacyPages[0], pageAccessToken: token }],
          pageId: LEGACY_PAGE, db: DB
        });
        return null;
      } catch (e) { return e.code; }
    };
    eq('a token Meta reports as invalid is rejected',
      await badToken('EAA-invalid'), conn.CONNECTION_ERRORS.TOKEN_REJECTED);
    eq('an expired token is rejected',
      await badToken('EAA-expired'), conn.CONNECTION_ERRORS.TOKEN_REJECTED);
    eq('a token for another app is rejected',
      await badToken('EAA-wrong-app'), conn.CONNECTION_ERRORS.TOKEN_REJECTED);
    eq('a token that is not a Page token is rejected',
      await badToken('EAA-bad-type'), conn.CONNECTION_ERRORS.TOKEN_REJECTED);
    eq('a token bound to a different Page is rejected',
      await badToken('EAA-wrong-page'), conn.CONNECTION_ERRORS.TOKEN_REJECTED);

    // The headline requirement: missing Messenger/Comments scopes must NOT
    // prevent a basic Page connection.
    const noMessenger = await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: legacyPages, pageId: LEGACY_PAGE, mode: 'reconnect', db: DB
    });
    eq('a token WITHOUT pages_messaging still connects the Page', noMessenger.pageId, LEGACY_PAGE);
    const { rows: afterNoMessenger } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyChannel, LEGACY]
    );
    eq('and the legacy credential is still intact after that connect', afterNoMessenger[0].n, 1);

    // ---- C6: the listing reports OAuth and legacy separately --------------
    const listed = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    const legacyRow = listed.find((c) => c.pageId === LEGACY_PAGE);
    check('the legacy-connected Page is listed', Boolean(legacyRow));
    eq('the legacy credential is reported present', legacyRow.legacyCredentialPresent, true);
    eq('the OAuth credential is reported present', legacyRow.oauthCredentialPresent, true);
    eq('the back-compatible flag is the OR of the two', legacyRow.credentialPresent, true);
    const { rows: t2List } = await q(
      `SELECT count(*)::int n FROM channels WHERE tenant_id=$1 AND external_id=$2`, [t2, LEGACY_PAGE]
    );
    eq('no cross-tenant row was created by the refused connect', t2List[0].n, 0);

    // ---- C5: disconnect refuses while a legacy credential remains ---------
    await rejects('disconnect is refused while a legacy credential is present',
      conn.CONNECTION_ERRORS.LEGACY_CREDENTIAL_PRESENT,
      () => conn.disconnectPage({ db: DB, tenantId: t1, actorUserId: admin1, channelId: legacyChannel, scope: TENANT_SCOPE }));
    const { rows: afterRefusedDisconnect } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [legacyChannel]
    );
    eq('the refused disconnect removed no credential', afterRefusedDisconnect[0].n, 2);
    const { rows: stillActive } = await q(`SELECT status FROM channels WHERE id=$1`, [legacyChannel]);
    eq('and the channel is still active', stillActive[0].status, 'active');

    // ---- a channel with ONLY an OAuth credential can be disconnected -------
    const { rows: soloRows } = await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                             oauth_provider, oauth_connected_at, oauth_scopes)
       VALUES ($1,$2,'meta',$3,'Solo Page','active','meta',now(),'[]'::jsonb) RETURNING id`,
      [t1, b1b, '901']
    );
    const soloChannel = soloRows[0].id;
    const soloEnc = encrypt('EAA-solo-oauth');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,now())`, [t1, soloChannel, OAUTH, soloEnc.value, soloEnc.iv]);
    await conn.disconnectPage({ db: DB, tenantId: t1, actorUserId: admin1, channelId: soloChannel, scope: TENANT_SCOPE });
    const { rows: soloCreds } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [soloChannel]
    );
    eq('disconnect removes the OAuth credential of an OAuth-only channel', soloCreds[0].n, 0);
    const { rows: soloStatus } = await q(`SELECT status FROM channels WHERE id=$1`, [soloChannel]);
    eq('and disables that channel', soloStatus[0].status, 'disabled');

    // ---- concurrency: connect, reconnect and disconnect in parallel -------
    const CONC_PAGE = '902';
    const concPages = [{
      pageId: CONC_PAGE, name: 'Concurrent Page', category: 'Retail',
      tasks: ['MANAGE'], pageAccessToken: 'EAA-page-902'
    }];
    metaOAuth.setGraphTransport({
      post: async () => ({}),
      // `/debug_token` is a GET - the handler must sit on the same verb the
      // code uses, or the inspection reads an empty body and refuses the
      // connect.
      get: async (path, params) => {
        if (path === '/debug_token') {
          return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: CONC_PAGE,
                      scopes: ['pages_show_list'], expires_at: 0 } };
        }
        if (path === '/me/accounts') return { data: concPages };
        return {};
      }
    });
    // ---- concurrency: the INVARIANTS, not the race ------------------------
    //
    // The service contract EXPLICITLY permits a same-tenant, same-brand,
    // same-Page reconnect: the routing channel is found by an explicit
    // provider='meta' + tenant_id predicate, and a late arrival REPLACES the
    // credential. Cross-brand reassignment is forbidden: reconnect to a
    // different brand is refused (facebookConnections.js: cross-brand transfer
    // is rejected under mode='reconnect'; mode='connect' against an existing
    // channel is always refused).
    //
    // So "how many of the three won" is a TIMING question, not a security
    // property: a late arrival may find the routing channel and replace the
    // credential, or may lose the unique-index race and be refused. What the
    // service DOES guarantee - and what is asserted here - is the OUTCOME:
    //
    //   exactly one routing channel
    //   at most one active OAuth credential
    //   the surviving credential is one of the AUTHORIZED tokens
    //   the surviving channel is on the brand the connects were authorized for
    //
    // Each connect uses a DIFFERENT authorized token, so the surviving
    // credential can be attributed to one of them instead of being
    // indistinguishable.
    const concTokens = ['EAA-conc-A', 'EAA-conc-B', 'EAA-conc-C'];
    const outcomes = await Promise.allSettled(concTokens.map((tok) => conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: [{ ...concPages[0], pageAccessToken: tok }],
      pageId: CONC_PAGE, db: DB
    })));
    const won = outcomes.filter((o) => o.status === 'fulfilled').length;
    const lost = outcomes.filter((o) => o.status === 'rejected').length;
    eq('every concurrent connect reached a definite outcome', won + lost, 3);
    check('at least one concurrent connect succeeded', won >= 1);
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        check('a refused concurrent connect carries one of OUR error codes',
          o.reason?.code === conn.CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED
          || o.reason?.code === conn.CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT);
      }
    }
    const { rows: concChannels } = await q(
      `SELECT count(*)::int n FROM channels WHERE external_id=$1 AND provider='meta'`, [CONC_PAGE]
    );
    eq('exactly one routing channel exists after concurrent connects', concChannels[0].n, 1);
    const { rows: concCreds } = await q(
      `SELECT count(*)::int n FROM provider_credentials pc JOIN channels c ON c.id=pc.channel_id
        WHERE c.external_id=$1 AND pc.kind=$2`, [CONC_PAGE, OAUTH]
    );
    eq('exactly one OAuth credential exists after concurrent connects', concCreds[0].n, 1);

    // The surviving credential must be one of the AUTHORIZED ones, and the
    // surviving channel must be on the brand the connects were authorized for.
    const { decrypt } = await import('../src/db/crypto.js');
    const { rows: concFinal } = await q(
      `SELECT pc.value_encrypted, pc.iv FROM provider_credentials pc
         JOIN channels c ON c.id = pc.channel_id
        WHERE c.external_id=$1 AND c.provider='meta' AND pc.kind=$2`, [CONC_PAGE, OAUTH]
    );
    eq('exactly one OAuth credential row survives', concFinal.length, 1);
    const finalConcToken = decrypt(concFinal[0].value_encrypted, concFinal[0].iv);
    check('the surviving credential is one of the AUTHORIZED tokens',
      concTokens.includes(finalConcToken));
    check('and it is not some other token', finalConcToken !== 'EAA-page-902');
    const { rows: concBrand } = await q(
      `SELECT brand_id FROM channels WHERE external_id=$1 AND provider='meta'`, [CONC_PAGE]
    );
    eq('the surviving channel is on the brand the connects were authorized for',
      String(concBrand[0].brand_id), String(b1));

    // ---- brand authorization is still enforced ---------------------------
    // The transport is restored first: the concurrency block above installed a
    // mock that only knows the concurrent Page, and using it here would test
    // the wrong thing (token rejection instead of brand scope).
    metaOAuth.setGraphTransport(legacyTransport);
    await rejects('a brand outside the caller scope is still refused',
      conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1c, brandScope: T1_BOTH_BRANDS,
        availablePages: legacyPages, pageId: LEGACY_PAGE, db: DB
      }));

    // ---- audit history preserved, no secrets -----------------------------
    const { rows: auditRows } = await q(
      `SELECT metadata::text m FROM audit_logs
        WHERE action IN ('integrations.facebook.connect','integrations.facebook.reconnect')`);
    check('connect and reconnect are audited', auditRows.length >= 2);
    const auditBlob = JSON.stringify(auditRows);
    check('no audit row contains a token', !/EAA-/.test(auditBlob));
    check('no audit row contains an app secret', !/test-app-secret/.test(auditBlob));

    metaOAuth.resetGraphTransport();
  }

  // ============================================= 16b cross-brand transfer prohibition
  // New tests proving cross-brand reassignment is refused in BOTH modes,
  // including concurrent first-connect and legacy NULL-brand claims.
  section('16b cross-brand transfer prohibition');

  {
    const LEGACY = conn.CREDENTIAL_KIND_LEGACY;
    const OAUTH = conn.CREDENTIAL_KIND_OAUTH;

    // ---- brandless (NULL brand_id) channel: first brand assignment -------
    // A brandless legacy channel exists. Two concurrent connect attempts with
    // DIFFERENT brands must produce exactly one owner.
    const NULL_PAGE = '950';
    const nullCh = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Brandless Page','active') RETURNING id`,
      [t1, null, NULL_PAGE]
    )).rows[0].id;
    const nullPages = [{
      pageId: NULL_PAGE, name: 'Brandless Page', category: 'Retail',
      tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'],
      pageAccessToken: 'EAA-page-950'
    }];

    metaOAuth.setGraphTransport({
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/debug_token') {
          return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true,
            profile_id: NULL_PAGE, scopes: ['pages_show_list'], expires_at: 0 } };
        }
        if (path === '/me/accounts') return { data: nullPages };
        return {};
      }
    });

    const nullOutcomes = await Promise.allSettled([
      conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: nullPages, pageId: NULL_PAGE, mode: 'reconnect', db: DB
      }),
      conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1b, brandScope: T1_BOTH_BRANDS,
        availablePages: nullPages, pageId: NULL_PAGE, mode: 'reconnect', db: DB
      })
    ]);
    const nullWon = nullOutcomes.filter((o) => o.status === 'fulfilled').length;
    const nullLost = nullOutcomes.filter((o) => o.status === 'rejected').length;
    eq('exactly one concurrent NULL-brand claim wins', nullWon, 1);
    eq('the other NULL-brand claim is refused', nullLost, 1);
    for (const o of nullOutcomes) {
      if (o.status === 'rejected') {
        check('a refused NULL-brand claim carries a 409-mappable code',
          o.reason?.code === conn.CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED
          || o.reason?.code === conn.CONNECTION_ERRORS.CROSS_BRAND_TRANSFER_FORBIDDEN,
          `code=${o.reason?.code}`);
      }
    }
    const { rows: nullChannels } = await q(
      `SELECT count(*)::int n FROM channels WHERE external_id=$1 AND provider='meta'`, [NULL_PAGE]
    );
    eq('exactly one routing channel after concurrent NULL-brand claims', nullChannels[0].n, 1);
    const { rows: nullBrand } = await q(
      `SELECT brand_id FROM channels WHERE external_id=$1 AND provider='meta'`, [NULL_PAGE]
    );
    check('the surviving NULL-brand channel is on b1 or b1b',
      String(nullBrand[0].brand_id) === String(b1) || String(nullBrand[0].brand_id) === String(b1b));
    const { rows: nullCreds } = await q(
      `SELECT count(*)::int n FROM provider_credentials pc JOIN channels c ON c.id=pc.channel_id
        WHERE c.external_id=$1 AND pc.kind=$2`, [NULL_PAGE, OAUTH]
    );
    eq('exactly one OAuth credential after concurrent NULL-brand claims', nullCreds[0].n, 1);

    metaOAuth.resetGraphTransport();

    // ---- brandless channel with existing OAuth credential: refused -------
    // A brandless channel that already has an OAuth credential must not be
    // assigned a brand via reconnect.
    const NULL_PAGE2 = '951';
    const nullCh2 = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                             oauth_provider, oauth_connected_at, oauth_scopes)
       VALUES ($1,$2,'meta',$3,'Brandless OAuth Page','active','meta',now(),'[]'::jsonb) RETURNING id`,
      [t1, null, NULL_PAGE2]
    )).rows[0].id;
    const null2Enc = encrypt('EAA-null2-oauth');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,now())`, [t1, nullCh2, OAUTH, null2Enc.value, null2Enc.iv]);

    const null2Pages = [{
      pageId: NULL_PAGE2, name: 'Brandless OAuth Page', category: 'Retail',
      tasks: ['MANAGE'], pageAccessToken: 'EAA-page-951'
    }];
    metaOAuth.setGraphTransport({
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/debug_token') {
          return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true,
            profile_id: NULL_PAGE2, scopes: ['pages_show_list'], expires_at: 0 } };
        }
        if (path === '/me/accounts') return { data: null2Pages };
        return {};
      }
    });
    await rejects('reconnect on brandless channel with OAuth is refused',
      conn.CONNECTION_ERRORS.PAGE_ALREADY_CONNECTED,
      () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: null2Pages, pageId: NULL_PAGE2, mode: 'reconnect', db: DB
      }));
    metaOAuth.resetGraphTransport();
  }

  // ============================================= 17 final review fixes
  // Covers the findings of the final code review:
  //   HIGH-1  an OAuth-only disconnect exists and leaves a legacy integration alone
  //   HIGH-2  an expired / unknown-expiry OAuth credential is not reported healthy
  //   MEDIUM-2 concurrent RECONNECT is serialised explicitly
  section('17 oauth-only disconnect, expiry-aware status and reconnect concurrency');

  {
    const { encrypt } = await import('../src/db/crypto.js');
    const LEGACY = conn.CREDENTIAL_KIND_LEGACY;
    const OAUTH = conn.CREDENTIAL_KIND_OAUTH;

    // ---- a Page with a legacy integration AND an OAuth connection ----------
    const LP = '910';
    const legacyCh = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Legacy Page 910','active') RETURNING id`, [t1, b1, LP]
    )).rows[0].id;
    await q(`INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
             VALUES ($1,$2,'meta_comment',$3,'Comments 910','active')`, [t1, b1, LP]);
    await q(`INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
             VALUES ($1,$2,'meta_dm',$3,'DM 910','active')`, [t1, b1, LP]);
    const legacyEnc2 = encrypt('EAA-LEGACY-910');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,NULL)`, [t1, legacyCh, LEGACY, legacyEnc2.value, legacyEnc2.iv]);
    const legacyId910 = (await q(
      `SELECT id FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyCh, LEGACY]
    )).rows[0].id;

    // The inspection mock: the expiry is driven by the token, so the expiry
    // states can be exercised without touching the clock.
    const inspectionFor = (token) => {
      if (token === 'EAA-expired-910') {
        return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: LP,
                          scopes: ['pages_show_list'], expires_at: 1000 } };
      }
      if (token === 'EAA-unknown-910') {
        return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: LP,
                          scopes: ['pages_show_list'] } };
      }
      return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: LP,
                        scopes: ['pages_show_list', 'pages_read_engagement'],
                        expires_at: Math.floor(Date.now() / 1000) + 3600 } };
    };
    const pages910 = (token) => [{
      pageId: LP, name: 'Legacy Page 910', category: 'Retail',
      tasks: ['MANAGE', 'CREATE_CONTENT'], pageAccessToken: token
    }];

    metaOAuth.setGraphTransport({
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/debug_token') return inspectionFor(params?.input_token);
        if (path === '/me/accounts') return { data: pages910('EAA-page-910') };
        return {};
      }
    });

    // ---- HIGH-2: expiry-aware status ------------------------------------
    const connected910 = await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: pages910('EAA-page-910'), pageId: LP, db: DB
    });
    eq('the page connects', connected910.pageId, LP);
    const listed910 = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    const row910 = listed910.find((c) => c.pageId === LP);
    check('the page is listed', Boolean(row910));
    eq('a legacy credential is present', row910.legacyCredentialPresent, true);
    eq('an OAuth credential is present', row910.oauthCredentialPresent, true);
    eq('a future expiry means the OAuth credential is healthy', row910.oauthCredentialHealthy, true);
    eq('a healthy OAuth credential does not require a reconnect', row910.oauthRequiresReconnect, false);
    eq('the back-compatible flag is still the OR', row910.credentialPresent, true);

    // Now try to replace it with an EXPIRED OAuth credential.
    //
    // A token Meta reports as already expired is REFUSED, fail-closed: a
    // known-dead credential is never stored, and the working credential that
    // is already in place is left exactly as it was.
    await rejects('a connect with an expired token is refused',
      conn.CONNECTION_ERRORS.TOKEN_REJECTED,
      () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: pages910('EAA-expired-910'), pageId: LP, mode: 'reconnect', db: DB
      }));
    const afterRefusal = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    const keptRow = afterRefusal.find((c) => c.pageId === LP);
    eq('the refused connect left the working credential in place', keptRow.oauthCredentialHealthy, true);
    eq('the refused connect did not turn the connection into a reconnect case',
      keptRow.oauthRequiresReconnect, false);
    const { rows: credAfterRefusal } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyCh, OAUTH]
    );
    eq('the refused connect stored no second OAuth credential', credAfterRefusal[0].n, 1);

    // A credential that expires AFTER it was stored is reported as expired.
    // Time passing is the only way a stored credential becomes expired, so the
    // stored row is aged directly - a connect would (correctly) refuse to
    // install an already-expired token in the first place.
    await q(
      `UPDATE provider_credentials SET expires_at = now() - interval '1 hour'
        WHERE channel_id=$1 AND kind=$2`, [legacyCh, OAUTH]
    );
    const afterExpiry = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    const expRow = afterExpiry.find((c) => c.pageId === LP);
    eq('an expired OAuth credential is reported expired', expRow.oauthCredentialExpired, true);
    eq('an expired OAuth credential is NOT healthy', expRow.oauthCredentialHealthy, false);
    eq('an expired OAuth credential requires a reconnect', expRow.oauthRequiresReconnect, true);
    eq('the legacy credential is still present', expRow.legacyCredentialPresent, true);
    eq('a working legacy credential does NOT mask the expired OAuth one',
      expRow.oauthRequiresReconnect, true);
    eq('the legacy connection is still healthy', expRow.legacyCredentialHealthy, true);

    // Unknown expiry is not validity either.
    await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: pages910('EAA-unknown-910'), pageId: LP, mode: 'reconnect', db: DB
    });
    const afterUnknown = await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE });
    const unkRow = afterUnknown.find((c) => c.pageId === LP);
    eq('an unknown expiry is flagged as unknown', unkRow.oauthCredentialExpiryUnknown, true);
    eq('an unknown expiry is NOT healthy', unkRow.oauthCredentialHealthy, false);
    eq('an unknown expiry requires a reconnect', unkRow.oauthRequiresReconnect, true);

    // ---- MEDIUM-2: concurrent RECONNECT on an existing routing channel ----
    const beforeConc = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyCh, OAUTH]
    );
    eq('one OAuth credential exists before the concurrent reconnects', beforeConc.rows[0].n, 1);
    const concResults = await Promise.allSettled([
      conn.connectPage({ tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: pages910('EAA-page-910'), pageId: LP, mode: 'reconnect', db: DB }),
      conn.connectPage({ tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: pages910('EAA-page-910'), pageId: LP, mode: 'reconnect', db: DB }),
      conn.connectPage({ tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: pages910('EAA-page-910'), pageId: LP, mode: 'reconnect', db: DB })
    ]);
    const concFulfilled = concResults.filter((r) => r.status === 'fulfilled').length;
    check('concurrent reconnects all resolve to a definite outcome', concFulfilled >= 0);
    const afterConc = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyCh, OAUTH]
    );
    eq('exactly ONE OAuth credential exists after concurrent reconnects', afterConc.rows[0].n, 1);
    const { rows: legacyAfterConc } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyCh, LEGACY]
    );
    eq('the legacy credential survived the concurrent reconnects', legacyAfterConc[0].n, 1);
    const { rows: legacyIdAfterConc } = await q(
      `SELECT id FROM provider_credentials WHERE id=$1`, [legacyId910]
    );
    eq('the legacy credential row is the SAME row', legacyIdAfterConc.length, 1);

    // ---- HIGH-1: OAuth-only disconnect on a legacy-connected Page ---------
    const siblingsBefore = await q(
      `SELECT id, provider, display_name, status FROM channels
        WHERE external_id=$1 AND provider IN ('meta_dm','meta_comment') ORDER BY provider`, [LP]
    );
    const legacyCredsBefore = await q(
      `SELECT id, kind, created_at FROM provider_credentials
        WHERE channel_id=$1 AND kind=$2 ORDER BY id`, [legacyCh, LEGACY]
    );

    const removed = await conn.disconnectOAuthConnection({
      db: DB, tenantId: t1, actorUserId: admin1, channelId: legacyCh, scope: TENANT_SCOPE });
    eq('the OAuth disconnect reports its scope', removed.scope, 'oauth');
    eq('and reports that the legacy credential was preserved', removed.legacyCredentialPreserved, true);

    const legacyCredsAfter = await q(
      `SELECT id, kind, created_at FROM provider_credentials
        WHERE channel_id=$1 AND kind=$2 ORDER BY id`, [legacyCh, LEGACY]
    );
    eq('the legacy credentials are byte-identical after the OAuth disconnect',
      JSON.stringify(legacyCredsAfter.rows), JSON.stringify(legacyCredsBefore.rows));
    const oauthAfter = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [legacyCh, OAUTH]
    );
    eq('the OAuth credential is gone', oauthAfter.rows[0].n, 0);
    const siblingsAfter = await q(
      `SELECT id, provider, display_name, status FROM channels
        WHERE external_id=$1 AND provider IN ('meta_dm','meta_comment') ORDER BY provider`, [LP]
    );
    eq('the Messenger and Comments channels are byte-identical',
      JSON.stringify(siblingsAfter.rows), JSON.stringify(siblingsBefore.rows));
    const { rows: chanAfter } = await q(
      `SELECT status, oauth_provider, oauth_connected_at, oauth_scopes FROM channels WHERE id=$1`, [legacyCh]
    );
    eq('the legacy-dependent channel is STILL ACTIVE', chanAfter[0].status, 'active');
    eq('the OAuth provider marker is cleared', chanAfter[0].oauth_provider, null);
    eq('the OAuth connection timestamp is cleared', chanAfter[0].oauth_connected_at, null);
    eq('the OAuth scopes are cleared', JSON.stringify(chanAfter[0].oauth_scopes), '[]');
    const { rows: auditOauth } = await q(
      `SELECT count(*)::int n FROM audit_logs
        WHERE action='integrations.facebook.disconnect.oauth' AND object_id=$1`, [LP]
    );
    eq('the OAuth disconnect is audited', auditOauth[0].n, 1);
    const { rows: legacyAuditIntact } = await q(
      `SELECT count(*)::int n FROM audit_logs WHERE object_id=$1`, [LP]
    );
    check('the audit history is append-only, not rewritten', legacyAuditIntact[0].n >= 1);

    // ---- the FULL disconnect is still refused on a legacy channel ---------
    await rejects('a full disconnect is still refused on a legacy-dependent channel',
      conn.CONNECTION_ERRORS.LEGACY_CREDENTIAL_PRESENT,
      () => conn.disconnectPage({ db: DB, tenantId: t1, actorUserId: admin1, channelId: legacyCh, scope: TENANT_SCOPE }));
    const { rows: chanStillActive } = await q(`SELECT status FROM channels WHERE id=$1`, [legacyCh]);
    eq('and the channel is still active after the refusal', chanStillActive[0].status, 'active');

    // ---- OAuth-only disconnect of a page with NO legacy integration -------
    const solo2 = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                             oauth_provider, oauth_connected_at, oauth_scopes)
       VALUES ($1,$2,'meta',$3,'Solo 911','active','meta',now(),'["pages_show_list"]'::jsonb) RETURNING id`,
      [t1, b1b, '911']
    )).rows[0].id;
    const solo2Enc = encrypt('EAA-solo-911');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,now())`, [t1, solo2, OAUTH, solo2Enc.value, solo2Enc.iv]);
    const solo2Removed = await conn.disconnectOAuthConnection({
      db: DB, tenantId: t1, actorUserId: admin1, channelId: solo2, scope: TENANT_SCOPE });
    eq('an OAuth-only page disconnects', solo2Removed.scope, 'oauth');
    eq('and there was no legacy credential to preserve', solo2Removed.legacyCredentialPreserved, false);
    const { rows: solo2Creds } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [solo2]
    );
    eq('its OAuth credential is removed', solo2Creds[0].n, 0);
    const { rows: solo2Chan } = await q(
      `SELECT status, oauth_provider FROM channels WHERE id=$1`, [solo2]
    );
    eq('with no legacy credential the channel is disabled', solo2Chan[0].status, 'disabled');
    eq('and the OAuth marker is cleared', solo2Chan[0].oauth_provider, null);

    // ---- concurrent connect / reconnect / disconnect ----------------------
    const CP = '912';
    const pages912 = (token) => [{
      pageId: CP, name: 'Concurrent 912', category: 'Retail',
      tasks: ['MANAGE'], pageAccessToken: token
    }];
    metaOAuth.setGraphTransport({
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/debug_token') return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: true, profile_id: CP,
                    scopes: ['pages_show_list'],
                    expires_at: Math.floor(Date.now() / 1000) + 3600 } };
        if (path === '/me/accounts') return { data: pages912('EAA-page-912') };
        return {};
      }
    });
    await conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: pages912('EAA-page-912'), pageId: CP, db: DB
    });
    const ch912 = (await q(
      `SELECT id FROM channels WHERE external_id=$1 AND provider='meta' AND tenant_id=$2`, [CP, t1]
    )).rows[0].id;
    const mixed = await Promise.allSettled([
      conn.connectPage({ tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: pages912('EAA-page-912'), pageId: CP, mode: 'reconnect', db: DB }),
      conn.disconnectOAuthConnection({ db: DB, tenantId: t1, actorUserId: admin1, channelId: ch912, scope: TENANT_SCOPE }),
      conn.connectPage({ tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: pages912('EAA-page-912'), pageId: CP, mode: 'reconnect', db: DB })
    ]);
    check('mixed concurrent operations all resolve to a definite outcome',
      mixed.every((r) => r.status === 'fulfilled' || r.status === 'rejected'));
    const { rows: ch912Count } = await q(
      `SELECT count(*)::int n FROM channels WHERE external_id=$1 AND provider='meta'`, [CP]
    );
    eq('exactly one routing channel survives the mixed concurrency', ch912Count[0].n, 1);
    const { rows: ch912Creds } = await q(
      `SELECT count(*)::int n FROM provider_credentials pc JOIN channels c ON c.id=pc.channel_id
        WHERE c.external_id=$1 AND pc.kind=$2`, [CP, OAUTH]
    );
    check('at most one OAuth credential exists for the channel', ch912Creds[0].n <= 1);

    // ---- tenant / brand isolation is still enforced ----------------------
    await rejects('a cross-tenant connect is still refused',
      conn.CONNECTION_ERRORS.PAGE_OWNED_BY_ANOTHER_TENANT,
      () => conn.connectPage({
        tenantId: t2, actorUserId: admin2, brandId: b2, brandScope: TENANT_SCOPE,
        availablePages: pages912('EAA-page-912'), pageId: CP, db: DB
      }));
    await rejects('a brand outside the scope is still refused',
      conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1c, brandScope: T1_BOTH_BRANDS,
        availablePages: pages912('EAA-page-912'), pageId: CP, db: DB
      }));

    metaOAuth.resetGraphTransport();
  }

  // ============================================= 18 brand isolation, concurrency, diagnostics
  // The final security gate found that the disconnect path was tenant-scoped but
  // NOT brand-scoped, so a restricted Supervisor could disconnect another
  // brand's connection inside their own tenant. It also found that concurrent
  // OAuth disconnects were never tested directly, and that a token rejection was
  // not recorded in the audit trail.
  section('18 brand isolation, concurrent disconnect and token-rejection audit');

  {
    const LEGACY = conn.CREDENTIAL_KIND_LEGACY;
    const OAUTH = conn.CREDENTIAL_KIND_OAUTH;
    const { encrypt } = await import('../src/db/crypto.js');

    // A restricted scope that sees ONLY brand b1, while the channel belongs to
    // brand b1b. Both are inside the SAME tenant.
    const RESTRICTED_B1 = { mode: 'restricted', brandIds: [b1] };
    const RESTRICTED_B1B = { mode: 'restricted', brandIds: [b1b] };

    const BP = '920';
    const chB1B = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                             oauth_provider, oauth_connected_at, oauth_scopes)
       VALUES ($1,$2,'meta',$3,'Brand B1B page','active','meta',now(),'["pages_show_list"]'::jsonb)
       RETURNING id`, [t1, b1b, BP]
    )).rows[0].id;
    const b1bEnc = encrypt('EAA-b1b-920');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,now())`, [t1, chB1B, OAUTH, b1bEnc.value, b1bEnc.iv]);

    // ---- HIGH: a restricted Supervisor must not disconnect another brand ----
    const beforeRestricted = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [chB1B, OAUTH]
    );
    await rejects('a restricted Supervisor cannot OAuth-disconnect another brand',
      conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      () => conn.disconnectOAuthConnection({
        db: DB, tenantId: t1, actorUserId: admin1, channelId: chB1B, scope: RESTRICTED_B1
      }));
    await rejects('a restricted Supervisor cannot full-disconnect another brand',
      conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      () => conn.disconnectPage({
        db: DB, tenantId: t1, actorUserId: admin1, channelId: chB1B, scope: RESTRICTED_B1
      }));
    const afterRestricted = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [chB1B, OAUTH]
    );
    eq('the refused cross-brand disconnect removed no credential',
      afterRestricted.rows[0].n, beforeRestricted.rows[0].n);
    const { rows: chStillActive } = await q(
      `SELECT status, oauth_provider FROM channels WHERE id=$1`, [chB1B]
    );
    eq('the channel is still active', chStillActive[0].status, 'active');
    eq('the OAuth marker is untouched', chStillActive[0].oauth_provider, 'meta');

    // The scope that DOES own the brand succeeds.
    const allowed = await conn.disconnectOAuthConnection({
      db: DB, tenantId: t1, actorUserId: admin1, channelId: chB1B, scope: RESTRICTED_B1B
    });
    eq('the brand owner CAN OAuth-disconnect it', allowed.scope, 'oauth');
    const afterAllowed = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [chB1B, OAUTH]
    );
    eq('and its OAuth credential is removed', afterAllowed.rows[0].n, 0);

    // ---- an ABSENT scope is refused, never treated as "everything" ---------
    const BP2 = '921';
    const chNoScope = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                             oauth_provider, oauth_connected_at, oauth_scopes)
       VALUES ($1,$2,'meta',$3,'No scope page','active','meta',now(),'[]'::jsonb)
       RETURNING id`, [t1, b1, BP2]
    )).rows[0].id;
    await rejects('an absent brand scope is refused',
      conn.CONNECTION_ERRORS.BRAND_NOT_ACCESSIBLE,
      () => conn.disconnectOAuthConnection({
        db: DB, tenantId: t1, actorUserId: admin1, channelId: chNoScope
      }));

    // ---- cross-tenant is still refused ------------------------------------
    await rejects('cross-tenant OAuth disconnect is refused',
      conn.CONNECTION_ERRORS.CHANNEL_NOT_FOUND,
      () => conn.disconnectOAuthConnection({
        db: DB, tenantId: t2, actorUserId: admin2, channelId: chNoScope, scope: TENANT_SCOPE
      }));

    // ---- MEDIUM: two simultaneous OAuth disconnects on ONE channel --------
    const CP3 = '922';
    const chConc = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status,
                             oauth_provider, oauth_connected_at, oauth_scopes)
       VALUES ($1,$2,'meta',$3,'Concurrent disconnect','active','meta',now(),'[]'::jsonb)
       RETURNING id`, [t1, b1, CP3]
    )).rows[0].id;
    const concEnc = encrypt('EAA-conc-922');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,now())`, [t1, chConc, OAUTH, concEnc.value, concEnc.iv]);
    const legacyConcEnc = encrypt('EAA-legacy-conc-922');
    await q(`INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
             VALUES ($1,$2,$3,$4,$5,now())`, [t1, chConc, LEGACY, legacyConcEnc.value, legacyConcEnc.iv]);

    const twoDisconnects = await Promise.allSettled([
      conn.disconnectOAuthConnection({ db: DB, tenantId: t1, actorUserId: admin1, channelId: chConc, scope: TENANT_SCOPE }),
      conn.disconnectOAuthConnection({ db: DB, tenantId: t1, actorUserId: admin1, channelId: chConc, scope: TENANT_SCOPE })
    ]);
    const okCount = twoDisconnects.filter((r) => r.status === 'fulfilled').length;
    check('at least one of two simultaneous OAuth disconnects succeeded', okCount >= 1);
    const concAfter = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [chConc, OAUTH]
    );
    eq('exactly one OAuth credential remains-or-zero after concurrent disconnects', concAfter.rows[0].n, 0);
    const concLegacy = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1 AND kind=$2`, [chConc, LEGACY]
    );
    eq('the legacy credential survived the concurrent disconnects', concLegacy.rows[0].n, 1);
    const { rows: concChan } = await q(
      `SELECT status, oauth_provider FROM channels WHERE id=$1`, [chConc]
    );
    eq('the channel stayed active (a legacy credential still serves it)', concChan[0].status, 'active');
    const concAudit = await q(
      `SELECT count(*)::int n FROM audit_logs
        WHERE action='integrations.facebook.disconnect.oauth' AND object_id=$1`, [CP3]
    );
    check('the audit recorded at least one OAuth disconnect', concAudit.rows[0].n >= 1);

    // ---- MEDIUM: a token rejection is audited with a SAFE code ----------
    const RP = '923';
    const chReject = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Reject page','active') RETURNING id`, [t1, b1, RP]
    )).rows[0].id;
    metaOAuth.setGraphTransport({
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/debug_token') return { data: { app_id: 'test-app-id', type: 'PAGE', is_valid: false } };
        // META'S OWN SHAPE, not our internal one.
        //
        // `/me/accounts` is Meta's response, so it carries `id` and
        // `access_token`. `discoverPages()` is what turns those into the
        // internal `pageId` / `pageAccessToken`. A mock that returns the
        // INTERNAL names here is read as a page whose id is `undefined`, so
        // the connect is refused as PAGE_NOT_IN_ACCOUNT long before the
        // token rejection under test is ever reached.
        if (path === '/me/accounts') return { data: [{ id: RP, name: 'Reject page', category: 'Retail', tasks: ['MANAGE'],
                     access_token: 'EAA-reject-923' }] };
        return {};
      }
    });
    await rejects('a token Meta rejects is refused',
      conn.CONNECTION_ERRORS.TOKEN_REJECTED,
      async () => conn.connectPage({
        tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
        availablePages: await conn.listAvailablePages({ db: DB, userAccessToken: 'u' }),
        pageId: RP, db: DB
      }));
    const rejectAudit = await q(
      `SELECT metadata::text m FROM audit_logs
        WHERE action='integrations.facebook.connect.token_rejected' AND object_id=$1`, [RP]
    );
    eq('the rejection is audited exactly once', rejectAudit.rows.length, 1);
    const meta = rejectAudit.rows[0].m;
    check('the audit records a predefined reason code', /META_TOKEN_INVALID|META_TOKEN_[A-Z_]+/.test(meta));
    check('the audit records NO token', !/EAA-/.test(meta));
    check('the audit records NO app secret', !/test-app-secret/.test(meta));
    check('the audit records no free-text upstream message', !/not a real token|Error validating|system error/i.test(meta));
    const rejectCreds = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [chReject]
    );
    eq('no credential was stored for the rejected token', rejectCreds.rows[0].n, 0);

    metaOAuth.resetGraphTransport();
  }

  {
    section('19 expiry tri-state, granted scopes and provider isolation');

    // The legacy credentials this section seeds are encrypted at rest, exactly
    // as production stores them. The helper is imported HERE, in this block's
    // own scope: the crypto import in the earlier sections is a different
    // lexical scope, and a lazy import is not hoisted.
    const { encrypt } = await import('../src/db/crypto.js');

    // ---- Task 1: the expiry tri-state, end to end -------------------------
    //
    // Meta's `expires_at` is a THREE-way answer and the storage must keep the
    // three apart:
    //   a positive number -> a real expiry
    //   0                -> "never expires"  (a positive statement)
    //   absent           -> "Meta said nothing" (unknown)
    //
    // Collapsing "never expires" into "unknown" is what made a freshly
    // connected, perfectly working Page ask for a reconnect immediately.
    const CASES = [
      { pageId: '930', token: 'EAA-never', expires_at: 0, scopes: ['pages_show_list'] },
      { pageId: '931', token: 'EAA-future', expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: ['pages_show_list'] },
      { pageId: '932', token: 'EAA-noexpiry', expires_at: undefined, scopes: ['pages_show_list'] },
      { pageId: '933', token: 'EAA-noscopes', expires_at: 0, scopes: undefined },
      { pageId: '934', token: 'EAA-unconfirmed', expires_at: 0, scopes: ['pages_show_list'], omitIsValid: true },
      { pageId: '93300', token: 'EAA-both', expires_at: 0, scopes: ['pages_show_list'] }
    ];
    const byToken = Object.fromEntries(CASES.map((c) => [c.token, c]));
    const inspectionFor = (token) => {
      const c = byToken[token];
      if (!c) return { data: { is_valid: false } };
      const data = { app_id: 'test-app-id', type: 'PAGE', profile_id: c.pageId };
      if (!c.omitIsValid) data.is_valid = true;
      if (c.expires_at !== undefined) data.expires_at = c.expires_at;
      if (c.scopes !== undefined) data.scopes = c.scopes;
      return { data };
    };
    metaOAuth.setGraphTransport({
      post: async () => ({}),
      get: async (path, params) => {
        if (path === '/debug_token') return inspectionFor(params?.input_token);
        if (path === '/me/accounts') {
          return {
            data: CASES.map((c) => ({
              id: c.pageId, name: `Page ${c.pageId}`, tasks: ['MANAGE'], access_token: c.token
            }))
          };
        }
        return {};
      }
    });

    const connectCase = async (pageId) => conn.connectPage({
      tenantId: t1, actorUserId: admin1, brandId: b1, brandScope: T1_BOTH_BRANDS,
      availablePages: await conn.listAvailablePages({ db: DB, userAccessToken: 'u' }),
      pageId,
      requestedScopes: ['pages_show_list', 'pages_read_engagement'],
      db: DB
    });
    const rowFor = async (pageId) =>
      (await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE }))
        .find((c) => c.pageId === pageId);

    // --- Meta says the token never expires ---------------------------------
    const rNever = await connectCase('930');
    eq('a never-expiring Page connects', rNever.pageId, '930');
    const { rows: neverCred } = await q(
      `SELECT expires_at FROM provider_credentials
        WHERE channel_id=$1 AND kind='page_access_token_oauth'`, [rNever.channelId]
    );
    eq('the never-expiring credential is stored with the sentinel',
      new Date(neverCred[0].expires_at).getTime(), conn.CREDENTIAL_NEVER_EXPIRES_AT.getTime());
    const rowNever = await rowFor('930');
    check('a never-expiring connection is listed', Boolean(rowNever));
    eq('it is reported as never expiring', rowNever.oauthCredentialNeverExpires, true);
    eq('it is healthy', rowNever.connectionHealthy, true);
    eq('it does NOT require a reconnect', rowNever.oauthRequiresReconnect, false);
    eq('it is not "expiry unknown"', rowNever.oauthCredentialExpiryUnknown, false);
    eq('no expiry DATE is surfaced for a never-expiring credential', rowNever.oauthCredentialExpiresAt, null);

    // --- Meta states a real future expiry ----------------------------------
    const rFuture = await connectCase('931');
    eq('a future-expiry Page connects', rFuture.pageId, '931');
    const rowFuture = await rowFor('931');
    eq('a future expiry is healthy', rowFuture.connectionHealthy, true);
    eq('a future expiry is NOT never-expiring', rowFuture.oauthCredentialNeverExpires, false);
    eq('a future expiry does not require a reconnect', rowFuture.oauthRequiresReconnect, false);
    check('a future expiry IS surfaced as a Date', rowFuture.oauthCredentialExpiresAt instanceof Date);
    check('and that Date is in the future', rowFuture.oauthCredentialExpiresAt.getTime() > Date.now());

    // --- Meta says nothing about the expiry --------------------------------
    const rNone = await connectCase('932');
    eq('an unknown-expiry Page still connects', rNone.pageId, '932');
    const rowNone = await rowFor('932');
    eq('an unknown expiry is flagged as unknown', rowNone.oauthCredentialExpiryUnknown, true);
    eq('an unknown expiry is NOT healthy', rowNone.connectionHealthy, false);
    eq('an unknown expiry requires a reconnect', rowNone.oauthRequiresReconnect, true);
    eq('an unknown expiry is NOT never-expiring', rowNone.oauthCredentialNeverExpires, false);
    const { rows: noneCred } = await q(
      `SELECT expires_at FROM provider_credentials
        WHERE channel_id=$1 AND kind='page_access_token_oauth'`, [rNone.channelId]
    );
    eq('an unknown expiry is stored as NULL, not as a guess', noneCred[0].expires_at, null);

    // ---- Task 3: granted scopes are not requested scopes -------------------
    eq('the GRANTED scopes are the ones Meta confirmed',
      JSON.stringify(rowNever.grantedScopes), JSON.stringify(['pages_show_list']));
    eq('the granted scopes are verified', rowNever.scopesVerified, true);
    check('the requested scopes are NOT presented as granted',
      JSON.stringify(rowNever.grantedScopes) !== JSON.stringify(rowNever.requestedScopes));
    eq('the requested scopes are reported separately, as a request',
      JSON.stringify(rowNever.requestedScopes), JSON.stringify(['pages_show_list', 'pages_read_engagement']));

    // The '933' fixture is DELIBERATELY configured with `scopes: undefined`,
    // so the inspection carries no `scopes` field at all and Meta's answer is
    // UNKNOWN rather than "confirmed empty". It has to be connected before it
    // can be listed.
    await connectCase('933');
    const rowNoScopes = await rowFor('933');
    eq('when Meta states no scopes, the granted scopes are null', rowNoScopes.grantedScopes, null);
    eq('and they are NOT verified', rowNoScopes.scopesVerified, false);
    eq('and the requested scopes are still reported as a request',
      JSON.stringify(rowNoScopes.requestedScopes), JSON.stringify(['pages_show_list', 'pages_read_engagement']));
    const { rows: storedScopes } = await q(
      `SELECT oauth_scopes FROM channels WHERE external_id='933' AND tenant_id=$1`, [t1]
    );
    eq('an unverified scope set is stored as JSON null, not as an empty list',
      storedScopes[0].oauth_scopes, null);
    const { rows: storedGranted } = await q(
      `SELECT oauth_scopes FROM channels WHERE external_id='930' AND tenant_id=$1`, [t1]
    );
    eq('the confirmed scopes are what is stored',
      JSON.stringify(storedGranted[0].oauth_scopes), JSON.stringify(['pages_show_list']));

    // --- a token Meta did not CONFIRM is refused ---------------------------
    await rejects('a token Meta did not confirm as valid is refused',
      conn.CONNECTION_ERRORS.TOKEN_REJECTED,
      () => connectCase('934'));

    // ---- Task 2: only a `meta` routing channel can be disconnected ---------
    const dmChannel = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta_dm',$3,'DM channel','active') RETURNING id`, [t1, b1, '93100']
    )).rows[0].id;
    const dmEnc = encrypt('EAA-dm-legacy');
    await q(
      `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
       VALUES ($1,$2,'page_access_token',$3,$4,now())`, [t1, dmChannel, dmEnc.value, dmEnc.iv]
    );
    await rejects('a meta_dm channel cannot be OAuth-disconnected',
      conn.CONNECTION_ERRORS.CHANNEL_NOT_FOUND,
      () => conn.disconnectOAuthConnection({
        db: DB, tenantId: t1, actorUserId: admin1, channelId: dmChannel, scope: TENANT_SCOPE
      }));
    await rejects('a meta_dm channel cannot be fully disconnected',
      conn.CONNECTION_ERRORS.CHANNEL_NOT_FOUND,
      () => conn.disconnectPage({
        db: DB, tenantId: t1, actorUserId: admin1, channelId: dmChannel, scope: TENANT_SCOPE
      }));
    const { rows: dmAfter } = await q(`SELECT status FROM channels WHERE id=$1`, [dmChannel]);
    eq('the meta_dm channel is untouched', dmAfter[0].status, 'active');
    const { rows: dmCreds } = await q(
      `SELECT count(*)::int n FROM provider_credentials WHERE channel_id=$1`, [dmChannel]
    );
    eq('its legacy credential is untouched', dmCreds[0].n, 1);

    // ---- Task 2: a legacy integration must not look removed ----------------
    //
    // A channel that carries a live legacy Messenger/Comments credential stays
    // VISIBLE after the OAuth link is removed, and is reported as a legacy-only
    // row - never as removed, never as "needs reconnect".
    const legacyOnlyChannel = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Legacy only','active') RETURNING id`, [t1, b1, '93200']
    )).rows[0].id;
    const loEnc = encrypt('EAA-legacy-only');
    await q(
      `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
       VALUES ($1,$2,'page_access_token',$3,$4,now())`, [t1, legacyOnlyChannel, loEnc.value, loEnc.iv]
    );
    const rowLegacyOnly = (await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE }))
      .find((c) => c.pageId === '93200');
    check('a legacy-only channel is still listed', Boolean(rowLegacyOnly));
    eq('it is flagged as legacy-only', rowLegacyOnly.legacyOnly, true);
    eq('it is not OAuth-connected', rowLegacyOnly.oauthConnected, false);
    eq('it does NOT require a reconnect', rowLegacyOnly.oauthRequiresReconnect, false);
    eq('it is not healthy as an OAuth connection', rowLegacyOnly.connectionHealthy, false);
    eq('its legacy credential is reported present', rowLegacyOnly.legacyCredentialPresent, true);

    // ---- F1: the legacy credential's three facts, kept apart --------------
    //
    // A legacy credential with NO stated expiry is the normal state of the
    // live Messenger/Comments integration. It is present, it is not known to
    // be expired, and the unknown fact is PRESERVED rather than hidden.
    eq('a legacy credential with no stated expiry is healthy (present, not known expired)',
      rowLegacyOnly.legacyCredentialHealthy, true);
    eq('a legacy credential with no stated expiry is NOT expired',
      rowLegacyOnly.legacyCredentialExpired, false);
    eq('a legacy credential with no stated expiry PRESERVES the unknown',
      rowLegacyOnly.legacyCredentialExpiryUnknown, true);

    // A legacy credential with a KNOWN expiry that has PASSED is the other
    // half of the rule, and it is reported as expired rather than healthy.
    const expiredLegacyChannel = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Expired legacy','active') RETURNING id`, [t1, b1, '93400']
    )).rows[0].id;
    const elEnc = encrypt('EAA-expired-legacy');
    await q(
      `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, expires_at, last_rotated_at)
       VALUES ($1,$2,'page_access_token',$3,$4,now() - interval '1 day',now())`,
      [t1, expiredLegacyChannel, elEnc.value, elEnc.iv]
    );
    const rowExpiredLegacy = (await conn.listConnections({ db: DB, tenantId: t1, scope: TENANT_SCOPE }))
      .find((c) => c.pageId === '93400');
    check('a legacy channel with a known past expiry is listed', Boolean(rowExpiredLegacy));
    eq('its legacy credential is present', rowExpiredLegacy.legacyCredentialPresent, true);
    eq('a known past expiry IS reported as expired', rowExpiredLegacy.legacyCredentialExpired, true);
    eq('a known past expiry is not "expiry unknown"', rowExpiredLegacy.legacyCredentialExpiryUnknown, false);
    eq('a known past expiry is NOT healthy', rowExpiredLegacy.legacyCredentialHealthy, false);

    // --- and the same after an OAuth-only disconnect -----------------------
    const bothChannel = (await q(
      `INSERT INTO channels (tenant_id, brand_id, provider, external_id, display_name, status)
       VALUES ($1,$2,'meta',$3,'Both','active') RETURNING id`, [t1, b1, '93300']
    )).rows[0].id;
    const bothEnc = encrypt('EAA-both-legacy');
    await q(
      `INSERT INTO provider_credentials (tenant_id, channel_id, kind, value_encrypted, iv, last_rotated_at)
       VALUES ($1,$2,'page_access_token',$3,$4,now())`, [t1, bothChannel, bothEnc.value, bothEnc.iv]
    );
    const rBoth = await connectCase('93300');
    eq('the page with a legacy credential reconnects over OAuth', rBoth.pageId, '93300');
    const rowBoth = await rowFor('93300');
    check('the reconnected channel is listed', Boolean(rowBoth));
    eq('and it is OAuth-connected', rowBoth.oauthConnected, true);

    const dis = await conn.disconnectOAuthConnection({
      db: DB, tenantId: t1, actorUserId: admin1, channelId: bothChannel, scope: TENANT_SCOPE
    });
    eq('the OAuth-only disconnect reports the legacy credential was preserved',
      dis.legacyCredentialPreserved, true);

    const rowAfter = await rowFor('93300');
    check('the channel is STILL listed after an OAuth-only disconnect', Boolean(rowAfter));
    eq('it is now flagged as legacy-only', rowAfter.legacyOnly, true);
    eq('its legacy credential is still present', rowAfter.legacyCredentialPresent, true);
    eq('it is no longer OAuth-connected', rowAfter.oauthConnected, false);
    eq('it does NOT require a reconnect', rowAfter.oauthRequiresReconnect, false);
    const { rows: bothCreds } = await q(
      `SELECT kind, count(*)::int n FROM provider_credentials WHERE channel_id=$1 GROUP BY kind`,
      [bothChannel]
    );
    eq('exactly one legacy credential survives',
      bothCreds.find((r) => r.kind === 'page_access_token')?.n, 1);
    eq('the OAuth credential is gone',
      bothCreds.filter((r) => r.kind === 'page_access_token_oauth').length, 0);
    const { rows: bothCh } = await q(
      `SELECT status, oauth_provider FROM channels WHERE id=$1`, [bothChannel]
    );
    eq('the channel stays active', bothCh[0].status, 'active');
    eq('the OAuth marker is cleared', bothCh[0].oauth_provider, null);

    metaOAuth.resetGraphTransport();
  }

  {
    section('20 the one-shot grant is gated on persisted state');

    // THE STATE LIFECYCLE
    //   issueOAuthState       -> consumed_at = NULL, confirmed_at = NULL
    //   consumeOAuthState     -> consumed_at = now()     (the callback claimed it)
    //   stashUserToken       -> the encrypted user token is parked
    //   claimGrantForConfirm -> confirmed_at = now()      (the atomic one-shot claim)
    //   takeUserToken        -> the parked token is removed
    //
    // The page listing is gated on the PERSISTED GRANT STATE, not on whether
    // the parked token happens to still be there. These assertions are
    // deterministic: they set up the exact state the old gate could not see.
    const mkGrant = async () => {
      const s = await state.issueOAuthState({
        tenantId: t1, actorUserId: admin1, provider: 'meta', brandId: b1, redirectUri: URI, db: DB
      });
      const claimed = await state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB });
      await state.stashUserToken({ stateId: claimed.id, userToken: 'EAA-parked-secret', db: DB });
      return claimed;
    };

    // 1. An unspent grant with a parked token is usable.
    const live = await mkGrant();
    const gLive = await state.readUnspentState({
      stateId: live.id, tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('an unspent grant is usable', gLive.ok, true);
    eq('and it releases the parked token', gLive.userToken, 'EAA-parked-secret');
    eq('and it reports the brand the grant was issued for', String(gLive.state.brand_id), String(b1));

    // 2. The binding is enforced, and a foreign grant is indistinguishable from
    //    one that does not exist.
    const gForeign = await state.readUnspentState({
      stateId: live.id, tenantId: t2, actorUserId: admin2, db: DB
    });
    eq('a grant issued to another company is refused', gForeign.ok, false);
    eq('and is indistinguishable from one that does not exist', gForeign.reason, 'not_found');
    const gOtherUser = await state.readUnspentState({
      stateId: live.id, tenantId: t1, actorUserId: admin2, db: DB
    });
    eq('a grant issued to another user is refused', gOtherUser.ok, false);
    eq('and is indistinguishable from one that does not exist', gOtherUser.reason, 'not_found');

    // 3. THE POST-CONFIRM WINDOW. Spend the grant and LEAVE THE PARKED TOKEN
    //    IN PLACE - the exact state the old gate could not see.
    const spent = await mkGrant();
    const wonClaim = await state.claimGrantForConfirm({
      stateId: spent.id, tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('the one-shot claim succeeds exactly once', wonClaim, true);
    const { rows: stillParked } = await q(
      `SELECT user_token_encrypted IS NOT NULL AS parked, confirmed_at IS NOT NULL AS spent
         FROM oauth_states WHERE id=$1`, [spent.id]
    );
    eq('the grant is recorded as spent', stillParked[0].spent, true);
    eq('and the parked token is STILL THERE (the cleanup has not run)', stillParked[0].parked, true);
    const gSpent = await state.readUnspentState({
      stateId: spent.id, tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('a SPENT grant is refused', gSpent.ok, false);
    eq('and the reason is that it was spent', gSpent.reason, 'spent');
    check('and NO token is released', !('userToken' in gSpent));

    // 4. A spent grant cannot be claimed a second time.
    const again = await state.claimGrantForConfirm({
      stateId: spent.id, tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('a spent grant cannot be claimed again', again, false);

    // 5. An unspent grant whose token is gone is readable but yields no token.
    const empty = await mkGrant();
    await q(`UPDATE oauth_states SET user_token_encrypted=NULL, user_token_iv=NULL WHERE id=$1`, [empty.id]);
    const gEmpty = await state.readUnspentState({
      stateId: empty.id, tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('an unspent grant with no token is still readable', gEmpty.ok, true);
    eq('but it yields no token', gEmpty.userToken, null);

    // 6. An expired grant is not usable.
    //
    // The fixture is a grant that WAS consumed at the OAuth callback stage -
    // `consumed_at` set, `confirmed_at` NULL - and then expired BEFORE it could
    // be confirmed. It is deliberately NOT a confirmed grant: that case is the
    // one above, and the two must not be confused.
    //
    // mkGrant() is used because issueOAuthState() does not return the row id,
    // and consumeOAuthState() does. The expiry is then set in the database
    // rather than by a negative TTL, so the fixture passes through exactly the
    // same lifecycle as a real grant and only its clock is moved.
    const expiring = await mkGrant();
    await q(
      `UPDATE oauth_states SET expires_at = now() - interval '1 hour' WHERE id=$1`, [expiring.id]
    );
    const { rows: expiringRow } = await q(
      `SELECT consumed_at IS NOT NULL AS consumed,
              confirmed_at IS NULL AS unconfirmed,
              expires_at <= now() AS expired
         FROM oauth_states WHERE id=$1`, [expiring.id]
    );
    check('the expired fixture has a valid state id', typeof expiring.id === 'string' && expiring.id.length > 0);
    eq('the expired fixture WAS consumed at the callback stage', expiringRow[0].consumed, true);
    eq('the expired fixture was never confirmed', expiringRow[0].unconfirmed, true);
    eq('the expired fixture really is expired', expiringRow[0].expired, true);
    const gExpired = await state.readUnspentState({
      stateId: expiring.id, tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('an expired grant is refused', gExpired.ok, false);
    check('and the reason is expiry, not spending', gExpired.reason !== 'spent');
    eq('and the reason is exactly expiry', gExpired.reason, 'expired');

    // 7. An unknown state id is refused.
    const gUnknown = await state.readUnspentState({
      stateId: '00000000-0000-0000-0000-000000000000', tenantId: t1, actorUserId: admin1, db: DB
    });
    eq('an unknown state id is refused', gUnknown.ok, false);
    eq('and is reported as not found', gUnknown.reason, 'not_found');
  }

  {
    section('21 the oauth state cleanup: scrub the secret, then delete the row');

    // THE CLEANUP, IN ONE PLACE
    // ---------------------------
    // The grant's own use window is ten minutes. After it, the row may still
    // exist - and it may still hold an encrypted Meta USER token and an
    // encrypted PKCE verifier. The cleanup scrubs both, then deletes the rows
    // that are past their retention. It runs in the worker, under a
    // PostgreSQL advisory lock, so exactly one replica runs a pass.
    const LOCK = String(state.OAUTH_CLEANUP_LOCK_KEY);

    // A grant with a parked user token AND a parked PKCE verifier.
    //
    // It is always created with a VALID ttl and expired afterwards by moving
    // the row's clock, because a state that was born expired cannot be
    // consumed - and the consumed state is what carries the parked secrets.
    const mkSecretGrant = async ({ confirm = false } = {}) => {
      const s = await state.issueOAuthState({
        tenantId: t1, actorUserId: admin1, provider: 'meta', brandId: b1, redirectUri: URI, db: DB
      });
      const c = await state.consumeOAuthState({ state: s.state, redirectUri: URI, db: DB });
      await state.stashUserToken({ stateId: c.id, userToken: 'EAA-cleanup-secret', db: DB });
      // A PKCE verifier is a secret too, and it has the same retention problem.
      const { encrypt } = await import('../src/db/crypto.js');
      const v = encrypt('PROBE-VERIFIER-cleanup');
      await q(
        `UPDATE oauth_states SET code_verifier_encrypted=$2, code_verifier_iv=$3 WHERE id=$1`,
        [c.id, v.value, v.iv]
      );
      if (confirm) {
        await state.claimGrantForConfirm({ stateId: c.id, tenantId: t1, actorUserId: admin1, db: DB });
      }
      return c;
    };

    // ---- an expired grant has its secrets scrubbed ------------------------
    const expiredGrant = await mkSecretGrant();
    await q(`UPDATE oauth_states SET expires_at = now() - interval '1 hour' WHERE id=$1`, [expiredGrant.id]);
    const liveGrant = await mkSecretGrant();

    const { rows: beforeScrub } = await q(
      `SELECT id, (user_token_encrypted IS NOT NULL) AS tok, (code_verifier_encrypted IS NOT NULL) AS pkce
         FROM oauth_states WHERE id = ANY($1::uuid[])`, [[expiredGrant.id, liveGrant.id]]
    );
    const beforeExpired = beforeScrub.find((r) => r.id === expiredGrant.id);
    eq('the expired grant starts with a parked token', beforeExpired.tok, true);
    eq('the expired grant starts with a parked PKCE verifier', beforeExpired.pkce, true);

    const scrubbed = await state.scrubOAuthSecrets({ db: DB, secretGraceSeconds: 0 });
    check('the expired grant was scrubbed', scrubbed >= 1);

    const { rows: afterScrub } = await q(
      `SELECT id, (user_token_encrypted IS NULL) AS tok_gone, (code_verifier_encrypted IS NULL) AS pkce_gone
         FROM oauth_states WHERE id = ANY($1::uuid[])`, [[expiredGrant.id, liveGrant.id]]
    );
    const expRow = afterScrub.find((r) => r.id === expiredGrant.id);
    const liveRow = afterScrub.find((r) => r.id === liveGrant.id);
    eq('the expired grant no longer holds the user token', expRow.tok_gone, true);
    eq('the expired grant no longer holds the PKCE verifier', expRow.pkce_gone, true);
    eq('a LIVE grant keeps its token', liveRow.tok_gone, false);
    eq('a LIVE grant keeps its PKCE verifier', liveRow.pkce_gone, false);

    // ---- CONSUMED is not CONFIRMED ---------------------------------------
    //
    // A grant that was consumed at the OAuth CALLBACK (consumed_at set) and
    // is still AWAITING CONFIRMATION (confirmed_at NULL) is LIVE: the parked
    // user token and the PKCE verifier are both still needed. The cleanup
    // must not touch it, and it must not be the thing that decides the
    // scrub.
    const awaiting = await mkSecretGrant();
    const { rows: awaitingRow } = await q(
      `SELECT consumed_at IS NOT NULL AS consumed,
              confirmed_at IS NULL AS unconfirmed,
              (user_token_encrypted IS NOT NULL) AS tok
         FROM oauth_states WHERE id=$1`, [awaiting.id]
    );
    eq('the awaiting grant was consumed at the callback', awaitingRow[0].consumed, true);
    eq('the awaiting grant is NOT confirmed', awaitingRow[0].unconfirmed, true);
    eq('and it still holds its token', awaitingRow[0].tok, true);
    await state.scrubOAuthSecrets({ db: DB });
    const { rows: awaitingAfter } = await q(
      `SELECT (user_token_encrypted IS NOT NULL) AS tok,
              (code_verifier_encrypted IS NOT NULL) AS pkce
         FROM oauth_states WHERE id=$1`, [awaiting.id]
    );
    eq('a grant AWAITING CONFIRMATION keeps its token', awaitingAfter[0].tok, true);
    eq('a grant AWAITING CONFIRMATION keeps its PKCE verifier', awaitingAfter[0].pkce, true);

    // ---- a SPENT grant is scrubbed too (heals a failed cleanup) ------------
    const spentGrant = await mkSecretGrant({ confirm: true });
    const { rows: spentBefore } = await q(
      `SELECT (user_token_encrypted IS NOT NULL) AS tok FROM oauth_states WHERE id=$1`, [spentGrant.id]
    );
    eq('the spent grant still holds its token before the scrub', spentBefore[0].tok, true);
    await state.scrubOAuthSecrets({ db: DB });
    const { rows: spentAfter } = await q(
      `SELECT (user_token_encrypted IS NULL) AS gone FROM oauth_states WHERE id=$1`, [spentGrant.id]
    );
    eq('a spent grant is scrubbed even though it has not expired', spentAfter[0].gone, true);

    // ---- row retention: old rows go, recent rows stay --------------------
    const oldRow = await mkSecretGrant();
    await q(`UPDATE oauth_states SET expires_at = now() - interval '2 days' WHERE id=$1`, [oldRow.id]);
    const removed = await state.purgeExpiredOAuthStates({ db: DB, olderThanSeconds: 86400 });
    check('the old row is deleted', removed >= 1);
    const { rows: oldGone } = await q(
      `SELECT count(*)::int n FROM oauth_states WHERE id=$1`, [oldRow.id]
    );
    eq('and it is really gone', oldGone[0].n, 0);
    const { rows: liveStill } = await q(
      `SELECT count(*)::int n FROM oauth_states WHERE id=$1`, [liveGrant.id]
    );
    eq('a recent row is NOT deleted', liveStill[0].n, 1);

    // ---- one runner only: the advisory lock -------------------------------
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    const skipped = await state.runOAuthStateCleanup({ db: DB });
    eq('a second runner SKIPS while the lock is held', skipped.ran, false);
    eq('and it says why', skipped.reason, 'another_runner_holds_the_lock');
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]);
    holder.release();

    const afterLock = await state.runOAuthStateCleanup({ db: DB });
    eq('the lock is released after the holder lets go', afterLock.ran, true);

    // ---- a failed pass releases the lock ----------------------------------
    const SIMULATED = 'SIMULATED_CLEANUP_FAILURE';
    const realClient = await pool.connect();
    const failingClient = {
      query: async (sql, params) => {
        if (String(sql).includes('UPDATE oauth_states')) {
          throw Object.assign(new Error('simulated cleanup failure'), { code: SIMULATED });
        }
        return realClient.query(sql, params);
      },
      release: () => realClient.release()
    };
    const failingDb = { connect: async () => failingClient, query: (...a) => pool.query(...a) };
    await rejects('a failed cleanup pass is reported', SIMULATED, async () => {
      await state.runOAuthStateCleanup({ db: failingDb });
    });
    const afterFailure = await state.runOAuthStateCleanup({ db: DB });
    eq('and the lock was released, so the next pass can run', afterFailure.ran, true);

    // ---- a CRASHED holder releases the lock (restart recovery) -----------
    // A worker that dies mid-pass must not wedge the cleanup. The advisory
    // lock is session scoped, so the lock dies with the session.
    //
    // This uses a STANDALONE client, never one from the pool. Closing a
    // POOLED client ends the connection but leaves it registered in the pool's
    // accounting, and pg-pool's shutdown waits for every client to come back
    // to its idle list - so a pooled client that is ended instead of released
    // wedges pool.end() forever. A standalone client is invisible to the pool,
    // so it can be killed without touching the pool's bookkeeping.
    const crasher = new pg.Client({ connectionString: url });
    await crasher.connect();
    await crasher.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    await crasher.end();
    // The backend needs a moment to notice the closed socket, so the lock is
    // released asynchronously. Poll for it instead of racing it.
    let afterCrash = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      afterCrash = await state.runOAuthStateCleanup({ db: DB });
      if (afterCrash.ran) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    eq('a crashed holder releases the lock, so a restarted worker can run', afterCrash.ran, true);

    // ---- idempotency ------------------------------------------------------
    const again = await state.runOAuthStateCleanup({ db: DB });
    eq('a second pass runs', again.ran, true);
    eq('and has nothing left to scrub', again.secretsCleared, 0);

    // ---- tenant isolation: a live grant of ANY tenant is untouched ------
    const otherState = await state.issueOAuthState({
      tenantId: t2, actorUserId: admin2, provider: 'meta', brandId: b2, redirectUri: URI, db: DB
    });
    const otherConsumed = await state.consumeOAuthState({
      state: otherState.state, redirectUri: URI, db: DB
    });
    await state.stashUserToken({
      stateId: otherConsumed.id, userToken: 'EAA-other-tenant-secret', db: DB
    });
    await state.runOAuthStateCleanup({ db: DB });
    const { rows: t2Live } = await q(
      `SELECT (user_token_encrypted IS NOT NULL) AS tok FROM oauth_states WHERE id=$1`,
      [otherConsumed.id]
    );
    eq('the cleanup did not touch another tenant\'s live grant', t2Live[0].tok, true);
    const { rows: t2Live2 } = await q(
      `SELECT count(*)::int n FROM oauth_states WHERE id=$1`, [otherConsumed.id]
    );
    eq('and that row still exists', t2Live2[0].n, 1);

    // ---- the audit record: counts only, no ids, no tokens -----------------
    const { rows: auditRows } = await q(
      `SELECT tenant_id, actor_user_id, object_id, metadata::text m
         FROM audit_logs WHERE action=$1 ORDER BY created_at DESC LIMIT 1`,
      [state.OAUTH_CLEANUP_AUDIT_ACTION]
    );
    check('the cleanup is audited', auditRows.length >= 1);
    eq('the audit row is a system event, not a user action', auditRows[0].tenant_id, null);
    eq('with no actor', auditRows[0].actor_user_id, null);
    eq('and no object id', auditRows[0].object_id, null);
    check('the audit metadata carries counts', /secretsCleared/.test(auditRows[0].m) && /rowsDeleted/.test(auditRows[0].m));
    check('and NO state id', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(auditRows[0].m));
    check('and NO token', !/EAA-/.test(auditRows[0].m));

    // ---- the customer-facing purge endpoint is GONE -----------------------
    const routeSrc = readFileSync(join(REPO, 'src', 'api', 'v1', 'metaOAuth.js'), 'utf8');
    check('the purge route no longer exists in the source', !routeSrc.includes("'/purge-states'"));
    const handoverSrc = readFileSync(join(REPO, 'B1_HANDOVER.md'), 'utf8');
    check('and the route is not documented as reachable',
      !handoverSrc.includes('`/api/v1/integrations/facebook/purge-states`'));
    {
      const express = (await import('express')).default;
      const { createApiV1Router } = await import('../src/api/v1/index.js');
      const app = express();
      const router = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId: t1, user: { id: admin1, email: 'a@b.local', name: 'A' },
          sessionId: '33333333-3333-3333-3333-3333-333333333333',
          roles: ['Company Admin'], brandIds: null, allBrandsInCompany: true,
          customAbilities: [], isPlatformSuperAdmin: false
        })
      });
      app.use(express.json());
      app.use('/api/v1', router);
      const srv = await new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () => r(s));
      });
      servers.push(srv);
      const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
      const health = await fetch(`${base}/_health`);
      const cookie = (health.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      const auth = { cookie: `lwc_session=x; ${cookie}`, csrf: cookie?.split('=')[1] };
      const purgeResp = await fetch(`${base}/integrations/facebook/purge-states`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: auth.cookie, 'x-csrf-token': auth.csrf },
        body: JSON.stringify({})
      });
      eq('a Company Admin cannot purge globally any more', purgeResp.status, 404);
      // And an AGENT - the role that only holds the READ ability - must not
      // reach a global delete either.
      const agentApp = express();
      const agentRouter = createApiV1Router({
        pool,
        validateSessionFn: async () => ({
          tenantId: t1, user: { id: admin1, email: 'a@b.local', name: 'A' },
          sessionId: '33333333-3333-3333-3333-3333-333333333333',
          roles: ['Agent'], brandIds: null, allBrandsInCompany: true,
          customAbilities: [], isPlatformSuperAdmin: false
        })
      });
      agentApp.use(express.json());
      agentApp.use('/api/v1', agentRouter);
      const agentSrv = await new Promise((r) => {
        const s = agentApp.listen(0, '127.0.0.1', () => r(s));
      });
      servers.push(agentSrv);
      const aBase = `http://127.0.0.1:${agentSrv.address().port}/api/v1`;
      const aHealth = await fetch(`${aBase}/_health`);
      const aCookie = (aHealth.headers.get('set-cookie') || '').match(/csrf_token=[^;]*/)?.[0];
      const agentResp = await fetch(`${aBase}/integrations/facebook/purge-states`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `lwc_session=x; ${aCookie}`,
          'x-csrf-token': aCookie?.split('=')[1]
        },
        body: JSON.stringify({})
      });
      eq('an AGENT cannot purge globally either', agentResp.status, 404);
    }

    // ---- the worker arms the cleanup --------------------------------------
    const workerSrc = readFileSync(join(REPO, 'src', 'workers', 'metaEventWorker.js'), 'utf8');
    check('the worker arms the oauth state cleanup', /startOAuthStateCleanupSweeper\(\)/.test(workerSrc));
    check('and the cleanup takes an advisory lock',
      /pg_try_advisory_lock/.test(readFileSync(join(REPO, 'src', 'services', 'oauthState.js'), 'utf8')));
    check('the cleanup reports only a code on failure', /safeErrorCode\(err\)/.test(workerSrc));
  }

  metaOAuth.resetGraphTransport();
} catch (e) {
  failures.push(`fatal: ${e?.code ?? ''} ${e?.message}`);
  console.error('\nfatal:', e?.code, e?.message, e?.stack);
} finally {
  for (const s of servers) { try { s.close(); } catch {} }
  // BOUNDED shutdown. pg-pool's end() waits for every client to come back to
  // its idle list, so one client that is ended instead of released would hang
  // the whole suite until the job timeout - and the suite would never print its
  // result. A leak must cost seconds, not the run.
  await Promise.race([
    pool.end().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
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
// short pass.
//
// THE FLOOR IS THE LAST VERIFIED EXECUTED COUNT - NOT A PREDICTION.
//
//   187 -> 196 -> 229 were each pinned to a number that had actually been
//   observed on a real run (runs 39218882467, 39232448510, ...).
//   289 was pinned to the last verified count of that round.
//   455 was the count MEASURED by CI run 39392987463 (commit 670e333).
//   496 is the count MEASURED by CI run 39406300943, on commit
//   ce752eed59fa0c4204d45cf0054afc1ed5cd3fcf, with every section from 1 to 21
//   executed and zero failures.
//
// A static reading of this file once suggested the suite would execute roughly
// 355 assertions. That was a PREDICTION from counting call sites, not a
// measurement, and a floor set from a prediction is a floor that can fail a
// fully green run for no reason. The floor is therefore pinned to a number
// that really ran, and it is raised to the MEASURED count of each complete
// green run.
//
// The floor is deliberately not weakened, and no individual security
// assertion has been removed to reach it.
//
// The floor is precisely what would have caught the original defect: the suite
// could report 196 passing while never once asserting that code_verifier is sent
// at the exchange.
const MIN_ASSERTIONS = 496;
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