// Driver-GPS scenario.
//
// Profile: 30 driver VUs POSTing a location update every second for
// 5 minutes. This is the high-volume small-payload write path that
// keeps live tracking warm on the consumer + portal sides.
//
// Each tick must complete in well under a second or the iOS driver
// app's 1Hz scheduler starts backing up. The threshold (p95 < 250 ms)
// is what spec §8.3 calls the SLO floor for "interactive writes".
//
// We rotate around a small lat/lon offset so the realtime layer
// actually fans the broadcast out instead of dedup'ing identical
// coordinates.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { signInDriver1, bearer } from '../lib/auth.js';

const API = __ENV.API_BASE_URL || 'http://localhost:3000';
const DURATION = Number(__ENV.DURATION_S || 300);

export const options = {
  scenarios: {
    gps: {
      executor: 'constant-vus',
      vus: 30,
      duration: `${DURATION}s`,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:locations.post}': ['p(95)<250', 'p(99)<500'],
  },
};

export function setup() {
  const token = signInDriver1();
  return { token };
}

// Center on the seed driver's start location (Mpls). We add a small
// jitter so consecutive coordinates differ — most realtime
// implementations short-circuit identical updates and the test would
// otherwise under-exercise the broadcast layer.
const BASE_LAT = 44.9778;
const BASE_LON = -93.265;

export default function (data) {
  const headers = bearer(data.token);
  const dLat = (Math.random() - 0.5) * 0.001;
  const dLon = (Math.random() - 0.5) * 0.001;
  const res = http.post(
    `${API}/v1/drivers/me/location`,
    JSON.stringify({
      lat: BASE_LAT + dLat,
      lon: BASE_LON + dLon,
      heading: Math.floor(Math.random() * 360),
      speedMph: 15 + Math.random() * 10,
      accuracyMeters: 5,
      recordedAt: new Date().toISOString(),
    }),
    { headers, tags: { name: 'locations.post' } },
  );
  check(res, { 'post 200/201/204': (r) => r.status >= 200 && r.status < 300 });

  // 1 Hz target — sleep to the nearest second from request start.
  sleep(1);
}
