/**
 * /driver namespace.
 *
 * One room per driver record (`driver:{driverId}`). The JWT's `sub` is
 * the user id, not the driver id, so we resolve the driver record at
 * connect time. The client MAY pass `driverId` in handshake auth for an
 * extra correctness check (rejected if mismatched); production clients
 * always send it.
 *
 * Client-to-server events:
 *   `driver:location:update` — payload {lat, lng, accuracyMeters?,
 *      speedMps?, headingDeg?, batteryPct?}. Rate-limited to ~1/sec per
 *      socket. On accept we publish a `driver:location` RealtimeEvent onto
 *      the dankdash:realtime stream — that's the single hand-off point with
 *      the customer-room broadcast (a separate worker in Phase 10 persists
 *      the row).
 *
 *      The `orderId`/`customerId` the event carries — and therefore which
 *      customer's room the location fans out to (see streams/router.ts) —
 *      are resolved server-side from the driver's active `orders` row, NOT
 *      taken from the client. A driver must not be able to stream fabricated
 *      GPS into an arbitrary customer's socket by naming their id. Any
 *      `orderId`/`customerId` in the payload is ignored (stripped by the
 *      schema). When the driver has no active delivery the location is
 *      published with null ids and the router drops it (no broadcast).
 *   `driver:heartbeat` — connection keepalive; the server replies with
 *      `driver:heartbeat:ack` so the client can detect a one-way break.
 */
import { publishRealtimeEvent } from '@dankdash/realtime-events';
import { ForbiddenError, ValidationError } from '@dankdash/types';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { createAuthMiddleware, getSocketData } from '../auth-middleware.js';
import { TokenBucket } from '../rate-limit.js';
import { driverRoom } from '../rooms.js';
import type { RealtimeJwtVerifier } from '../../auth/jwt.js';
import type { ActiveDelivery, MembershipRepository } from '../../membership/repo.js';
import type { Logger } from '@dankdash/config';
import type { Redis } from 'ioredis';
import type { Namespace, Socket } from 'socket.io';

/**
 * How long a resolved active-delivery lookup is reused for a socket before
 * re-querying. Bounds the DB load to ≤1 probe / socket / window while the
 * driver streams ~1 location/sec. Staleness is benign and bounded: when a
 * driver's assignment changes, routing catches up within this window —
 * worst case is a few extra pings to the just-served customer or a few
 * seconds' delay before the new customer's tracking starts. Never routes to
 * an *arbitrary* customer, because the id always comes from a real order row.
 */
const DEFAULT_ACTIVE_DELIVERY_TTL_MS = 5_000;

export interface DriverNamespaceOptions {
  readonly verifier: RealtimeJwtVerifier;
  readonly membership: MembershipRepository;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly rateLimit: {
    readonly capacity: number;
    readonly refillPerSecond: number;
  };
  /** Override for tests so the producer can assert deterministic IDs. */
  readonly idGenerator?: () => string;
  readonly clock?: () => Date;
  /** Active-delivery cache window; defaults to {@link DEFAULT_ACTIVE_DELIVERY_TTL_MS}. */
  readonly activeDeliveryTtlMs?: number;
}

interface DeliveryCacheEntry {
  readonly value: ActiveDelivery | null;
  readonly resolvedAtMs: number;
}

interface DriverSocketData {
  readonly driverId: string;
  readonly driverUserId: string;
  readonly locationBucket: TokenBucket;
  // A stable mutable container created at connect; the location handler
  // refreshes `.entry` in place so the TTL cache survives across pings.
  readonly deliveryCache: { entry: DeliveryCacheEntry | null };
}

// `orderId`/`customerId` are deliberately absent: the routing identity is
// derived server-side from the driver's active order, never the client. A
// non-strict object silently strips any such keys a legacy client still sends.
const driverLocationUpdateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().positive().optional(),
  speedMps: z.number().optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
});

export function registerDriverNamespace(nsp: Namespace, options: DriverNamespaceOptions): void {
  const idGen = options.idGenerator ?? (() => uuidv7());
  const clock = options.clock ?? (() => new Date());

  nsp.use(
    createAuthMiddleware({
      verifier: options.verifier,
      allowedRole: 'driver',
      logger: options.logger,
    }),
  );

  nsp.use((socket, next) => {
    resolveDriverIdentity(socket, options)
      .then(() => {
        next();
      })
      .catch((err: unknown) => {
        options.logger.info(
          {
            event: 'realtime.driver.membership.rejected',
            err: err instanceof Error ? err.message : String(err),
          },
          'realtime: driver membership rejected',
        );
        const wrapped =
          err instanceof Error
            ? Object.assign(err, { data: { code: 'FORBIDDEN' } })
            : new Error('driver lookup failed');
        next(wrapped);
      });
  });

  const activeDeliveryTtlMs = options.activeDeliveryTtlMs ?? DEFAULT_ACTIVE_DELIVERY_TTL_MS;

  nsp.on('connection', (socket) => {
    const { claims } = getSocketData(socket);
    const data = socket.data as Partial<DriverSocketData>;
    const driverId = data.driverId;
    const driverUserId = data.driverUserId;
    if (driverId === undefined || driverUserId === undefined) {
      // Unreachable — the second middleware would have rejected.
      socket.disconnect(true);
      return;
    }
    void socket.join(driverRoom(driverId));
    options.logger.info(
      {
        event: 'realtime.driver.connected',
        userId: claims.sub,
        driverId,
        socketId: socket.id,
      },
      'realtime: driver connected',
    );

    socket.on('driver:heartbeat', () => {
      socket.emit('driver:heartbeat:ack', { at: clock().toISOString() });
    });

    socket.on('driver:location:update', (payload: unknown) => {
      void handleLocationUpdate({
        socket,
        driverId,
        driverUserId,
        membership: options.membership,
        payload,
        redis: options.redis,
        logger: options.logger,
        idGen,
        clock,
        activeDeliveryTtlMs,
      });
    });

    socket.on('disconnect', (reason) => {
      options.logger.info(
        {
          event: 'realtime.driver.disconnected',
          userId: claims.sub,
          driverId,
          socketId: socket.id,
          reason,
        },
        'realtime: driver disconnected',
      );
    });
  });
}

async function resolveDriverIdentity(
  socket: Socket,
  options: DriverNamespaceOptions,
): Promise<void> {
  const { claims } = getSocketData(socket);
  const handshakeAuth = socket.handshake.auth as Record<string, unknown>;
  const requested = handshakeAuth['driverId'];

  let driverId: string | null;
  if (typeof requested === 'string' && requested.length > 0) {
    const ok = await options.membership.isDriver(claims.sub, requested);
    if (!ok) {
      throw new ForbiddenError('user does not own requested driver record', {
        driverId: requested,
      });
    }
    driverId = requested;
  } else {
    driverId = await options.membership.findDriverIdForUser(claims.sub);
    if (driverId === null) {
      throw new ForbiddenError('user has no driver record');
    }
  }

  const data: DriverSocketData = {
    driverId,
    driverUserId: claims.sub,
    locationBucket: new TokenBucket({
      capacity: options.rateLimit.capacity,
      refillPerSecond: options.rateLimit.refillPerSecond,
    }),
    deliveryCache: { entry: null },
  };
  Object.assign(socket.data, data);
}

/**
 * Resolve which order/customer the driver is delivering, reusing a recent
 * lookup for up to `ttlMs`. The cache is the per-socket `{ entry }` container
 * mutated in place. Exported for unit tests that assert the cache-hit /
 * cache-miss boundary without a live socket.
 */
export async function resolveActiveDelivery(params: {
  readonly membership: MembershipRepository;
  readonly driverUserId: string;
  readonly cache: { entry: DeliveryCacheEntry | null };
  readonly nowMs: number;
  readonly ttlMs: number;
}): Promise<ActiveDelivery | null> {
  const cached = params.cache.entry;
  if (cached !== null && params.nowMs - cached.resolvedAtMs < params.ttlMs) {
    return cached.value;
  }
  const value = await params.membership.findActiveDeliveryForDriverUser(params.driverUserId);
  params.cache.entry = { value, resolvedAtMs: params.nowMs };
  return value;
}

interface HandleLocationCtx {
  readonly socket: Socket;
  readonly driverId: string;
  readonly driverUserId: string;
  readonly membership: MembershipRepository;
  readonly payload: unknown;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly idGen: () => string;
  readonly clock: () => Date;
  readonly activeDeliveryTtlMs: number;
}

export async function handleLocationUpdate(ctx: HandleLocationCtx): Promise<void> {
  const data = ctx.socket.data as Partial<DriverSocketData>;
  const bucket = data.locationBucket;
  const deliveryCache = data.deliveryCache;
  if (bucket === undefined || deliveryCache === undefined) {
    // Middleware sets both fields — a defensive null-check would mask a wiring bug.
    ctx.socket.emit('error', { code: 'INTERNAL', message: 'rate limiter not initialized' });
    return;
  }
  if (!bucket.consume()) {
    ctx.socket.emit('driver:location:rate_limited', {
      retryAfterMs: 1000,
    });
    return;
  }

  let parsed: z.infer<typeof driverLocationUpdateSchema>;
  try {
    parsed = driverLocationUpdateSchema.parse(ctx.payload);
  } catch (err) {
    const validation = new ValidationError('driver:location:update payload invalid', {}, err);
    ctx.socket.emit('error', { code: validation.code, message: validation.message });
    return;
  }

  try {
    // Authoritative routing identity: the driver's active order and its
    // customer, resolved from the DB — never the client payload. Null when
    // the driver is not on a delivery, in which case the router fans out to
    // no one (streams/router.ts drops a null-customer location).
    const delivery = await resolveActiveDelivery({
      membership: ctx.membership,
      driverUserId: ctx.driverUserId,
      cache: deliveryCache,
      nowMs: ctx.clock().getTime(),
      ttlMs: ctx.activeDeliveryTtlMs,
    });

    await publishRealtimeEvent(ctx.redis, {
      id: ctx.idGen(),
      emittedAt: ctx.clock().toISOString(),
      source: 'api',
      event: {
        type: 'driver:location',
        payload: {
          driverId: ctx.driverId,
          orderId: delivery?.orderId ?? null,
          customerId: delivery?.customerId ?? null,
          dispensaryId: delivery?.dispensaryId ?? null,
          lat: parsed.lat,
          lng: parsed.lng,
          accuracyMeters: parsed.accuracyMeters ?? null,
          speedMps: parsed.speedMps ?? null,
          headingDeg: parsed.headingDeg ?? null,
          recordedAt: ctx.clock().toISOString(),
        },
      },
    });
  } catch (err) {
    ctx.logger.error(
      {
        event: 'realtime.driver.location.publish_failed',
        driverId: ctx.driverId,
        err: err instanceof Error ? err.message : String(err),
      },
      'realtime: failed to publish driver location to stream',
    );
    ctx.socket.emit('error', { code: 'INTERNAL', message: 'location publish failed' });
  }
}
