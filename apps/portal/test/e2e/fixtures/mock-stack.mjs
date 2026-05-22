/**
 * In-process mock stack for portal e2e tests.
 *
 * Runs three HTTP listeners on configurable ports:
 *
 *   1. Mock API server (`MOCK_API_PORT`, default 4001)
 *      Mirrors the subset of `apps/api` endpoints the portal queue
 *      consumes:
 *        - POST  /v1/auth/login
 *        - POST  /v1/auth/refresh
 *        - GET   /v1/me/dispensaries
 *        - GET   /v1/vendor/orders
 *        - GET   /v1/vendor/orders/:id
 *        - POST  /v1/vendor/orders/:id/accept|reject|prepped|ready|handoff
 *
 *   2. Mock realtime server (`MOCK_REALTIME_PORT`, default 4002)
 *      Real Socket.io v4 server on the `/vendor` namespace — exactly
 *      the shape the portal connects to in production. The handshake
 *      accepts any non-empty `auth.token` (we trust the test setup),
 *      so no JWT signing/verification work is required.
 *
 *   3. Admin server (`MOCK_ADMIN_PORT`, default 4003)
 *      In-band scenario control surface for the Playwright specs.
 *      Tests POST/GET against this to seed orders, fire realtime
 *      events, force the WS into reject mode (polling-fallback test),
 *      and reset state between specs:
 *
 *        - POST  /__reset
 *        - POST  /__set-orders             body: { orders: VendorQueueOrderSummary[] }
 *        - POST  /__set-detail             body: VendorOrderDetail (replaces the detail fixture)
 *        - POST  /__emit-created           body: OrderSummary
 *        - POST  /__emit-status            body: OrderStatusChange
 *        - POST  /__disconnect-sockets
 *        - POST  /__reject-handshakes      body: { reject: boolean }
 *        - GET   /__transitions            returns { calls: TransitionCall[] }
 *        - POST  /__clear-transitions
 *        - GET   /__health                 readiness probe
 *
 * Spawned as a separate process via Playwright's `webServer` config
 * (see playwright.config.ts). Communication with the test suite is
 * over HTTP — there is no shared in-process state.
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Server as SocketIOServer } from 'socket.io';

const API_PORT = Number(process.env['MOCK_API_PORT'] ?? 4001);
const REALTIME_PORT = Number(process.env['MOCK_REALTIME_PORT'] ?? 4002);
const ADMIN_PORT = Number(process.env['MOCK_ADMIN_PORT'] ?? 4003);

const TOKEN_TTL_SECONDS = 60 * 60;
const PREPPING_TRANSITIONS = new Set(['accept', 'reject', 'prepped', 'ready', 'handoff']);

/** @type {{ orders: any[]; detail: any | null; rejectHandshakes: boolean; transitions: any[] }} */
const state = {
  orders: [],
  detail: null,
  rejectHandshakes: false,
  transitions: [],
};

function isoOffsetSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function defaultUser() {
  return {
    id: '01935f3d-0000-7000-8000-000000000abc',
    email: 'manager@dankdash.test',
    phone: null,
    firstName: 'Test',
    lastName: 'Manager',
    role: 'manager',
    status: 'active',
    kycVerified: true,
    // Set true so the portal's `requiresMfa(role) && !mfaEnabled` gate
    // is satisfied immediately after the credentials POST. Without this
    // the e2e flow lands on /two-factor and never reaches /orders.
    mfaEnabled: true,
    createdAt: '2026-05-01T00:00:00.000Z',
  };
}

function defaultTokens() {
  return {
    accessToken: 'e2e.access.token',
    refreshToken: 'e2e.refresh.token',
    accessTokenExpiresAt: isoOffsetSeconds(TOKEN_TTL_SECONDS),
    refreshTokenExpiresAt: isoOffsetSeconds(60 * 60 * 24 * 14),
    tokenType: 'Bearer',
  };
}

function defaultMembership() {
  return {
    id: '01935f3d-0000-7000-8000-0000000000d1',
    displayName: 'DankDash Test Store',
    staffRole: 'manager',
    acceptedAt: '2026-05-01T00:00:00.000Z',
    joinedAt: '2026-05-01T00:00:00.000Z',
  };
}

function defaultDetail(orderId) {
  return {
    id: orderId,
    shortCode: orderId.slice(0, 4).toUpperCase(),
    userId: '01935f3d-0000-7000-8000-000000000abc',
    dispensaryId: defaultMembership().id,
    driverId: null,
    status: 'placed',
    statusChangedAt: new Date().toISOString(),
    subtotalCents: 5400,
    cannabisTaxCents: 540,
    salesTaxCents: 270,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 0,
    totalCents: 6210,
    timestamps: {
      placedAt: new Date().toISOString(),
      paymentFailedAt: null,
      acceptedAt: null,
      rejectedAt: null,
      preppingAt: null,
      preparedAt: null,
      awaitingDriverAt: null,
      dispatchFailedAt: null,
      driverAssignedAt: null,
      enRoutePickupAt: null,
      pickedUpAt: null,
      enRouteDropoffAt: null,
      arrivedAtDropoffAt: null,
      idScanPendingAt: null,
      deliveredAt: null,
      returnedToStoreAt: null,
      canceledAt: null,
      disputedAt: null,
      ratedAt: null,
    },
    ratings: { customer: null, review: null, dispensary: null, driver: null },
  };
}

function transitionResponse(orderId, status) {
  return { id: orderId, status, statusChangedAt: new Date().toISOString() };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-dispensary-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.end(JSON.stringify(body));
}

function sendCors(res) {
  res.statusCode = 204;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-dispensary-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function statusToTransitionKey(path) {
  if (path.endsWith('/accept')) return 'accept';
  if (path.endsWith('/reject')) return 'reject';
  if (path.endsWith('/prepped')) return 'prepped';
  if (path.endsWith('/ready')) return 'ready';
  if (path.endsWith('/handoff')) return 'handoff';
  return null;
}

function transitionTargetStatus(key) {
  switch (key) {
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
    case 'prepped':
      return 'prepping';
    case 'ready':
      return 'ready_for_pickup';
    case 'handoff':
      return 'picked_up';
    default:
      return 'placed';
  }
}

const apiServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendCors(res);
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'POST' && path === '/v1/auth/login') {
    const body = await readBody(req);
    if (body['mode'] === 'mfa' || body['mfaCode']) {
      sendJson(res, 200, { status: 'authenticated', user: defaultUser(), tokens: defaultTokens() });
      return;
    }
    sendJson(res, 200, { status: 'authenticated', user: defaultUser(), tokens: defaultTokens() });
    return;
  }

  if (req.method === 'POST' && path === '/v1/auth/refresh') {
    sendJson(res, 200, { tokens: defaultTokens() });
    return;
  }

  if (req.method === 'GET' && path === '/v1/me/dispensaries') {
    sendJson(res, 200, { memberships: [defaultMembership()] });
    return;
  }

  if (req.method === 'GET' && path === '/v1/vendor/orders') {
    sendJson(res, 200, { orders: state.orders, total: state.orders.length });
    return;
  }

  if (req.method === 'GET' && path.startsWith('/v1/vendor/orders/')) {
    const id = path.replace('/v1/vendor/orders/', '');
    const fromOrders = state.orders.find((o) => o.id === id);
    const detail = state.detail?.id === id ? state.detail : null;
    if (detail !== null) {
      sendJson(res, 200, detail);
      return;
    }
    const fallback = defaultDetail(id);
    if (fromOrders !== undefined) {
      fallback.status = fromOrders.status;
      fallback.shortCode = fromOrders.shortCode;
    }
    sendJson(res, 200, fallback);
    return;
  }

  const txKey = path.startsWith('/v1/vendor/orders/') ? statusToTransitionKey(path) : null;
  if (req.method === 'POST' && txKey !== null && PREPPING_TRANSITIONS.has(txKey)) {
    const segments = path.split('/');
    const id = segments[segments.length - 2] ?? '';
    const body = await readBody(req);
    state.transitions.push({ id, key: txKey, body, at: new Date().toISOString() });
    sendJson(res, 200, transitionResponse(id, transitionTargetStatus(txKey)));
    return;
  }

  sendJson(res, 404, { code: 'NOT_FOUND', message: `unmocked ${req.method} ${path}` });
});

const realtimeHttp = createServer((_req, res) => {
  res.statusCode = 200;
  res.end('mock-realtime');
});
const io = new SocketIOServer(realtimeHttp, {
  cors: { origin: '*' },
  transports: ['websocket'],
});

const vendorNs = io.of('/vendor');
vendorNs.use((socket, next) => {
  if (state.rejectHandshakes) {
    next(new Error('mock-stack: realtime handshake rejected by admin flag'));
    return;
  }
  const auth = socket.handshake.auth;
  if (
    auth === undefined ||
    auth === null ||
    typeof auth['token'] !== 'string' ||
    auth['token'].length === 0
  ) {
    next(new Error('mock-stack: missing auth token'));
    return;
  }
  next();
});

const adminServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendCors(res);
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/__health') {
    sendJson(res, 200, { ok: true, api: API_PORT, realtime: REALTIME_PORT });
    return;
  }
  if (req.method === 'POST' && path === '/__reset') {
    state.orders = [];
    state.detail = null;
    state.rejectHandshakes = false;
    state.transitions = [];
    const sockets = await vendorNs.fetchSockets();
    for (const s of sockets) s.disconnect(true);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/__set-orders') {
    const body = await readBody(req);
    state.orders = Array.isArray(body['orders']) ? body['orders'] : [];
    sendJson(res, 200, { ok: true, count: state.orders.length });
    return;
  }
  if (req.method === 'POST' && path === '/__set-detail') {
    const body = await readBody(req);
    state.detail = body;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/__emit-created') {
    const body = await readBody(req);
    vendorNs.to(`dispensary:${defaultMembership().id}`).emit('order:created', body);
    // Also emit to all sockets — the e2e client subscribes by namespace,
    // not necessarily by room, depending on join timing.
    vendorNs.emit('order:created', body);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/__emit-status') {
    const body = await readBody(req);
    vendorNs.emit('order:status_changed', body);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/__disconnect-sockets') {
    const sockets = await vendorNs.fetchSockets();
    for (const s of sockets) s.disconnect(true);
    sendJson(res, 200, { ok: true, dropped: sockets.length });
    return;
  }
  if (req.method === 'POST' && path === '/__reject-handshakes') {
    const body = await readBody(req);
    state.rejectHandshakes = body['reject'] === true;
    if (state.rejectHandshakes) {
      const sockets = await vendorNs.fetchSockets();
      for (const s of sockets) s.disconnect(true);
    }
    sendJson(res, 200, { ok: true, rejecting: state.rejectHandshakes });
    return;
  }
  if (req.method === 'GET' && path === '/__transitions') {
    sendJson(res, 200, { calls: state.transitions });
    return;
  }
  if (req.method === 'POST' && path === '/__clear-transitions') {
    state.transitions = [];
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { code: 'NOT_FOUND', message: `unmocked admin ${req.method} ${path}` });
});

apiServer.listen(API_PORT, '127.0.0.1', () => {
  console.log(`[mock-stack] api listening on ${API_PORT}`);
});
realtimeHttp.listen(REALTIME_PORT, '127.0.0.1', () => {
  console.log(`[mock-stack] realtime listening on ${REALTIME_PORT}`);
});
adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log(`[mock-stack] admin listening on ${ADMIN_PORT}`);
});

function shutdown() {
  apiServer.close();
  realtimeHttp.close();
  adminServer.close();
  io.close();
  // Give the close handlers a tick to drain, then exit.
  void delay(50).then(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
