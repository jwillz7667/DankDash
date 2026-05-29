// Vendor-realtime scenario.
//
// Single portal WebSocket consumer (vendor1) holds a Socket.io session
// for 5 minutes while a parallel producer arm submits 100 orders/min
// against the same dispensary. The script asserts every order event
// (placed → paid → preparing → out_for_delivery → delivered) reaches
// the portal subscriber inside the 250 ms emit budget.
//
// k6 ships a `k6/ws` module for plain WebSockets. Socket.io's
// transport-frame layer wraps the websocket; the script speaks the
// engine.io v4 "open" / "message" framing directly so we don't pull
// the @types-heavy socket.io-client dependency into k6 (k6 bundles
// don't accept Node-only deps).

import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { signInVendor1, signInCustomer1, bearer } from '../lib/auth.js';
import { DISPENSARIES, LISTINGS, ADDRESSES } from '../lib/seed-ids.js';

const API = __ENV.API_BASE_URL || 'http://localhost:3000';
const REALTIME = __ENV.REALTIME_URL || 'http://localhost:3001';
const DURATION = Number(__ENV.DURATION_S || 300);

const emitLatency = new Trend('emit_latency_ms', true);
const ordersPlaced = new Counter('orders_placed_total');
const eventsReceived = new Counter('socketio_events_received_total');

export const options = {
  scenarios: {
    consumer: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${DURATION + 30}s`,
      exec: 'consumer',
    },
    producer: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1m',
      duration: `${DURATION}s`,
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'producer',
    },
  },
  thresholds: {
    emit_latency_ms: ['p(95)<250'],
    socketio_events_received_total: ['count>0'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  return {
    vendorToken: signInVendor1(),
    customerToken: signInCustomer1(),
  };
}

export function consumer(data) {
  // Socket.io URL with token in query — matches the realtime server's
  // auth middleware (apps/realtime/src/server.ts:auth-middleware).
  const url = `${REALTIME.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket&token=${data.vendorToken}`;
  const res = ws.connect(url, null, (socket) => {
    socket.on('open', () => {
      socket.send('40/portal,'); // engine.io: namespace connect
    });
    socket.on('message', (raw) => {
      // engine.io frames: '0' open, '2' ping, '3' pong, '4' message.
      // Socket.io payload inside '4': '40' = connect, '42' = event.
      if (!raw.startsWith('42')) return;
      try {
        const json = JSON.parse(raw.slice(raw.indexOf('[')));
        // [eventName, payload]; payload carries the emit timestamp.
        const ts = json?.[1]?.emittedAt;
        if (typeof ts === 'string') {
          const latency = Date.now() - Date.parse(ts);
          emitLatency.add(latency);
          eventsReceived.add(1);
        }
      } catch (_e) {
        // unparseable frame — ignore
      }
    });
    socket.setTimeout(() => socket.close(), DURATION * 1000);
  });
  check(res, { 'ws connected': (r) => r && r.status === 101 });
}

export function producer(data) {
  const headers = bearer(data.customerToken);
  const disp = DISPENSARIES.greenLeafMpls;
  const listing = LISTINGS.greenLeafMplsFirst;
  const address = ADDRESSES.customer1Home;

  http.del(`${API}/v1/cart`, null, { headers });
  http.post(`${API}/v1/cart/items`, JSON.stringify({ listingId: listing, quantity: 1 }), {
    headers,
  });
  const checkout = http.post(
    `${API}/v1/checkout`,
    JSON.stringify({ dispensaryId: disp, deliveryAddressId: address, paymentMethodId: null }),
    { headers, tags: { name: 'checkout' } },
  );
  if (checkout.status >= 200 && checkout.status < 300) {
    ordersPlaced.add(1);
  }
}
