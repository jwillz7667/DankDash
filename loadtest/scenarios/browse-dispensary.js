// Browse-dispensary scenario.
//
// Profile: 1000 VUs ramp over 60 s, hold for 5 min, ramp down for 60 s.
// Each VU paginates a dispensary menu and views a product detail.
// Read-only.
//
// Spec §8.3 commits to p95 < 500 ms on read endpoints. http_req_failed
// must stay under 1% — anything above means the API or pool is
// over-provisioned.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { signInCustomer1, bearer } from '../lib/auth.js';
import { DISPENSARIES, LISTINGS, PAGE_SIZES } from '../lib/seed-ids.js';

const API = __ENV.API_BASE_URL || 'http://localhost:3000';
const RAMPUP = Number(__ENV.RAMPUP_S || 60);
const DURATION = Number(__ENV.DURATION_S || 300);

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${RAMPUP}s`, target: 1000 },
        { duration: `${DURATION}s`, target: 1000 },
        { duration: `${RAMPUP}s`, target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:listings}': ['p(95)<500'],
    'http_req_duration{name:detail}': ['p(95)<500'],
    http_req_duration: ['p(99)<800'],
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

  const listingsRes = http.get(
    `${API}/v1/dispensaries/${disp}/listings?page=1&pageSize=${PAGE_SIZES.menu}`,
    { headers, tags: { name: 'listings' } },
  );
  check(listingsRes, {
    'listings 200': (r) => r.status === 200,
    'listings has items': (r) => {
      try {
        const items = r.json('items');
        return Array.isArray(items) && items.length > 0;
      } catch (_e) {
        return false;
      }
    },
  });

  const detailRes = http.get(`${API}/v1/listings/${LISTINGS.greenLeafMplsFirst}`, {
    headers,
    tags: { name: 'detail' },
  });
  check(detailRes, {
    'detail 200': (r) => r.status === 200,
  });

  sleep(1 + Math.random() * 2);
}
