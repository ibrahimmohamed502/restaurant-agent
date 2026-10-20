// Pure-function unit tests: no database required.
// Run with: node scripts/test-token-lifecycle.mjs
import {
  assessCredentialState,
  assessConnectionStatus,
  expiryFromInspection,
  assessGrantedScopes,
  CREDENTIAL_NEVER_EXPIRES_AT
} from '../src/services/facebookConnections.js';

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    failures.push(name + (detail ? ' [' + detail + ']' : ''));
    console.log('  FAIL  ' + name + '  ' + detail);
  }
}

console.log('=== credential state (no database required) ===');

const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const FUTURE = new Date('2026-06-01T00:00:00Z');
const PAST = new Date('2025-06-01T00:00:00Z');

// 1. Absent credential.
let s = assessCredentialState({ present: false, expiresAt: null, now: NOW });
check('an absent credential is not present', s.present === false);
check('an absent credential requires a reconnect', s.requiresReconnect === true);
check('an absent credential is not healthy', s.healthy === false);

// 2. Present with a known future expiry.
s = assessCredentialState({ present: true, expiresAt: FUTURE, now: NOW });
check('a present credential with a future expiry is healthy', s.healthy === true);
check('a present credential with a future expiry is not expired', s.expired === false);
check('a present credential with a future expiry does not require a reconnect', s.requiresReconnect === false);
check('a known expiry is not unknown', s.expiryUnknown === false);

// 3. Present with a known past expiry.
s = assessCredentialState({ present: true, expiresAt: PAST, now: NOW });
check('an expired credential is reported expired', s.expired === true);
check('an expired credential is not healthy', s.healthy === false);
check('an expired credential requires a reconnect', s.requiresReconnect === true);

// 4. Present with an UNKNOWN expiry.
s = assessCredentialState({ present: true, expiresAt: null, now: NOW });
check('an unknown expiry is flagged as unknown', s.expiryUnknown === true);
check('an unknown expiry is NOT treated as valid', s.healthy === false);
check('an unknown expiry requires a reconnect', s.requiresReconnect === true);
check('an unknown expiry is not reported as expired', s.expired === false);

// 5. A string expiry is accepted (the shape the DB driver returns).
s = assessCredentialState({ present: true, expiresAt: '2026-06-01T00:00:00Z', now: NOW });
check('a string expiry is understood', s.healthy === true);

// 6. An expiry exactly at now counts as expired.
s = assessCredentialState({ present: true, expiresAt: new Date(NOW), now: NOW });
check('an expiry exactly at now is expired', s.expired === true);

console.log('');
console.log('=== connection status: THE single rule ===');

// 7. OAuth connected and healthy.
let c = assessConnectionStatus({
  oauthConnected: true, oauthPresent: true, expiresAt: FUTURE, now: NOW
});
check('a connected, valid connection is healthy', c.connectionHealthy === true);
check('a connected, valid connection does not need a reconnect', c.oauthRequiresReconnect === false);
check('a connected, valid connection reports itself connected', c.oauthConnected === true);

// 8. OAuth connected but the credential is EXPIRED.
c = assessConnectionStatus({
  oauthConnected: true, oauthPresent: true, expiresAt: PAST, now: NOW
});
check('an expired OAuth credential is NOT healthy', c.connectionHealthy === false);
check('an expired OAuth credential needs a reconnect', c.oauthRequiresReconnect === true);
check('an expired OAuth credential is reported expired', c.oauthCredentialExpired === true);

// 9. OAuth connected but the expiry is UNKNOWN.
c = assessConnectionStatus({
  oauthConnected: true, oauthPresent: true, expiresAt: null, now: NOW
});
check('an unknown-expiry OAuth credential is NOT healthy', c.connectionHealthy === false);
check('an unknown-expiry OAuth credential needs a reconnect', c.oauthRequiresReconnect === true);
check('an unknown expiry is reported as unknown', c.oauthCredentialExpiryUnknown === true);

// 10. OAuth connected but the credential is MISSING.
c = assessConnectionStatus({
  oauthConnected: true, oauthPresent: false, expiresAt: null, now: NOW
});
check('a missing OAuth credential needs a reconnect', c.oauthRequiresReconnect === true);
check('a missing OAuth credential is not healthy', c.connectionHealthy === false);

// 11. NEVER OAuth-connected: nothing to reconnect, so not a false alarm.
c = assessConnectionStatus({
  oauthConnected: false, oauthPresent: false, expiresAt: null, now: NOW
});
check('a never-connected channel does not need a reconnect', c.oauthRequiresReconnect === false);
check('a never-connected channel is not healthy', c.connectionHealthy === false);
check('a never-connected channel reports itself not connected', c.oauthConnected === false);

// 12. The rule does not depend on a legacy credential - the masking case.
c = assessConnectionStatus({
  oauthConnected: true, oauthPresent: true, expiresAt: PAST, now: NOW
});
check('the rule has no legacy input at all', !('legacyPresent' in c));

console.log('');
console.log('=== credential state: the "never expires" fact ===');

// 13. Meta stated the token NEVER expires (expires_at: 0). This is a POSITIVE
// statement, not missing information, and it must not ask for a reconnect.
s = assessCredentialState({ present: true, expiresAt: CREDENTIAL_NEVER_EXPIRES_AT, now: NOW });
check('a never-expiring credential is healthy', s.healthy === true);
check('a never-expiring credential is not expired', s.expired === false);
check('a never-expiring credential does not require a reconnect', s.requiresReconnect === false);
check('a never-expiring credential is not "expiry unknown"', s.expiryUnknown === false);
check('a never-expiring credential is flagged as such', s.neverExpires === true);

// 14. The sentinel survives a Date -> ISO string -> Date round trip, which is
// how it comes back out of a timestamptz column.
s = assessCredentialState({
  present: true,
  expiresAt: new Date(CREDENTIAL_NEVER_EXPIRES_AT.toISOString()),
  now: NOW
});
check('the never-expiring sentinel survives a string round trip', s.neverExpires === true);
check('and is still healthy after the round trip', s.healthy === true);

// 15. A real future expiry is NOT the sentinel.
s = assessCredentialState({ present: true, expiresAt: FUTURE, now: NOW });
check('a real future expiry is not reported as never expiring', s.neverExpires === false);

// 16. An unknown expiry is not the sentinel either.
s = assessCredentialState({ present: true, expiresAt: null, now: NOW });
check('an unknown expiry is not reported as never expiring', s.neverExpires === false);

console.log('');
console.log('=== expiryFromInspection: the three states out ===');

// 17. Meta said 0 -> the sentinel, and NOT null.
let e = expiryFromInspection({ expiresAt: 0 });
check('expires_at 0 becomes the never-expiring sentinel', e instanceof Date);
check('expires_at 0 is the sentinel value', e?.getTime() === CREDENTIAL_NEVER_EXPIRES_AT.getTime());

// 18. Meta said a positive number -> a real date.
e = expiryFromInspection({ expiresAt: 1893456000 });
check('a positive expires_at becomes a real date', e?.getTime() === 1893456000000);
check('a positive expires_at is not the sentinel', e?.getTime() !== CREDENTIAL_NEVER_EXPIRES_AT.getTime());

// 19. Meta said nothing -> null (unknown), never the sentinel.
e = expiryFromInspection({ expiresAt: null });
check('a missing expires_at stays null (unknown)', e === null);
e = expiryFromInspection({ expiresAt: undefined });
check('an absent expires_at stays null (unknown)', e === null);

// 20. No inspection at all -> null. A missing inspection is never a guess.
e = expiryFromInspection(null);
check('a missing inspection yields null, never a guess', e === null);
e = expiryFromInspection(undefined);
check('an undefined inspection yields null, never a guess', e === null);

// 21. A nonsense value is not stored as a bogus date.
e = expiryFromInspection({ expiresAt: NaN });
check('a non-numeric expires_at yields null', e === null);
e = expiryFromInspection({ expiresAt: 1e18 });
check('an out-of-range expires_at yields null', e === null);

console.log('');
console.log('=== granted scopes: confirmed vs unknown ===');

// 22. Meta returned a list -> confirmed.
let g = assessGrantedScopes({ granted: ['pages_show_list', 'pages_read_engagement'] });
check('a returned scope list is verified', g.verified === true);
check('the verified scopes are the returned ones', JSON.stringify(g.scopes) === JSON.stringify(['pages_show_list', 'pages_read_engagement']));

// 23. Meta returned an EMPTY list -> confirmed, and confirmed to be empty.
// This is a fact, and it is not the same as the unknown case below.
g = assessGrantedScopes({ granted: [] });
check('an empty scope list is still VERIFIED', g.verified === true);
check('an empty scope list stays empty', JSON.stringify(g.scopes) === '[]');

// 24. Meta did not return a list -> unknown, never an empty list.
g = assessGrantedScopes({ granted: null });
check('a missing scope list is NOT verified', g.verified === false);
check('a missing scope list is null, not an empty list', g.scopes === null);
g = assessGrantedScopes({});
check('an absent scope list is NOT verified', g.verified === false);
check('an absent scope list is null, not an empty list', g.scopes === null);

console.log('');
console.log('=== connection status: never-expires and legacy-only ===');

// 25. An OAuth connection whose credential never expires is HEALTHY. This is
// the regression that stopped a freshly connected, non-expiring Page from
// immediately asking for a reconnect.
c = assessConnectionStatus({
  oauthConnected: true, oauthPresent: true, expiresAt: CREDENTIAL_NEVER_EXPIRES_AT, now: NOW
});
check('a never-expiring OAuth connection is healthy', c.connectionHealthy === true);
check('a never-expiring OAuth connection does not need a reconnect', c.oauthRequiresReconnect === false);
check('a never-expiring OAuth connection is flagged', c.oauthCredentialNeverExpires === true);
check('a never-expiring OAuth connection is not "expiry unknown"', c.oauthCredentialExpiryUnknown === false);

// 26. A legacy-only channel (never OAuth-connected) is neither healthy nor
// asking for a reconnect. It is an active integration, not a broken one.
c = assessConnectionStatus({
  oauthConnected: false, oauthPresent: false, expiresAt: null, now: NOW
});
check('a legacy-only channel does not need a reconnect', c.oauthRequiresReconnect === false);
check('a legacy-only channel is not healthy', c.connectionHealthy === false);
check('a legacy-only channel is not OAuth-connected', c.oauthConnected === false);

console.log('');
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('  credential-state and connection-status unit tests PASSED');
