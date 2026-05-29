// Sign in as a seeded user (consumer / driver / vendor) and return
// the access token. The k6 scenarios call this once per VU during
// `setup()` so the per-iteration cost is just request overhead, not
// auth overhead.
//
// API surface: POST /v1/auth/sign-in with { email, password } returns
// { accessToken, refreshToken, user }. The body matches what the iOS
// consumer sends — no special "loadtest" endpoint. Failing logins
// raise here so a bad password in CI doesn't quietly mask itself as a
// slow test.

import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.API_BASE_URL || 'http://localhost:3000';
const PASSWORD = __ENV.LOADTEST_PASSWORD || 'Loadtest!23';

function signIn(email) {
  const res = http.post(`${API}/v1/auth/sign-in`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'auth.signIn' },
  });
  if (
    !check(res, {
      'sign-in 200': (r) => r.status === 200,
      'sign-in has token': (r) => {
        try {
          return typeof r.json('accessToken') === 'string';
        } catch (_e) {
          return false;
        }
      },
    })
  ) {
    throw new Error(`sign-in failed for ${email}: status=${res.status} body=${res.body}`);
  }
  return res.json('accessToken');
}

export function signInCustomer1() {
  return signIn('alice@dankdash.test');
}

export function signInCustomer2() {
  return signIn('bob@dankdash.test');
}

export function signInDriver1() {
  return signIn('driver1@dankdash.test');
}

export function signInVendor1() {
  return signIn('vendor1@dankdash.test');
}

export function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
