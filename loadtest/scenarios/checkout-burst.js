// Checkout-burst scenario.
//
// Profile: 100 concurrent VUs hammering checkout for 5 min against
// one dispensary. Each iteration: add an item to cart, validate the
// cart (server-side compliance pass), then complete checkout.
//
// Spec §8.3 commits to write p95 < 1500 ms — and checkout is the
// canonical write path (cart insert + compliance evaluation + order
// creation + ledger write all in one transaction).
//
// Important: the script intentionally does NOT call the real
// AeropayClient in production-staging — staging's Aeropay sandbox
// rate-limits us to ~50 charges/min. The API's checkout endpoint
// expects `paymentMethodId` and runs the auth flow against the
// sandbox; for load tests the AEROPAY_TEST_MODE env on the API must
// be `mock` so charges no-op. The k6 script doesn't enforce this —
// the operator-runbook does.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { signInCustomer1, bearer } from '../lib/auth.js';
import { DISPENSARIES, LISTINGS, ADDRESSES } from '../lib/seed-ids.js';

const API = __ENV.API_BASE_URL || 'http://localhost:3000';
const DURATION = Number(__ENV.DURATION_S || 300);

export const options = {
  scenarios: {
    checkout: {
      executor: 'constant-vus',
      vus: 100,
      duration: `${DURATION}s`,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:cart.addItem}': ['p(95)<800'],
    'http_req_duration{name:cart.validate}': ['p(95)<1000'],
    'http_req_duration{name:checkout}': ['p(95)<1500'],
    iteration_duration: ['p(99)<2500'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  const token = signInCustomer1();
  return { token };
}

export default function (data) {
  const headers = bearer(data.token);
  const disp = DISPENSARIES.greenLeafMpls;
  const listing = LISTINGS.greenLeafMplsFirst;
  const address = ADDRESSES.customer1Home;

  // Empty the cart so each iteration starts fresh — otherwise the
  // accumulated grams will trip the compliance limit by iteration 14.
  http.del(`${API}/v1/cart`, null, { headers, tags: { name: 'cart.clear' } });

  const addRes = http.post(
    `${API}/v1/cart/items`,
    JSON.stringify({ listingId: listing, quantity: 1 }),
    { headers, tags: { name: 'cart.addItem' } },
  );
  check(addRes, { 'add 200/201': (r) => r.status === 200 || r.status === 201 });

  const validateRes = http.post(
    `${API}/v1/cart/validate`,
    JSON.stringify({ dispensaryId: disp, deliveryAddressId: address }),
    { headers, tags: { name: 'cart.validate' } },
  );
  check(validateRes, { 'validate 200': (r) => r.status === 200 });

  const checkoutRes = http.post(
    `${API}/v1/checkout`,
    JSON.stringify({
      dispensaryId: disp,
      deliveryAddressId: address,
      paymentMethodId: null, // mock mode — API uses the seed's mock method
    }),
    { headers, tags: { name: 'checkout' } },
  );
  check(checkoutRes, {
    'checkout 200/201': (r) => r.status === 200 || r.status === 201,
    'checkout returns orderId': (r) => {
      try {
        return typeof r.json('orderId') === 'string';
      } catch (_e) {
        return false;
      }
    },
  });

  sleep(0.5);
}
