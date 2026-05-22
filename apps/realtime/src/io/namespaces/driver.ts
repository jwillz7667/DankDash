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
 *      speedMps?, headingDeg?, batteryPct?, orderId?}. Rate-limited to
 *      ~1/sec per socket. On accept we publish a `driver:location`
 *      RealtimeEvent onto the dankdash:realtime stream — that's the
 *      single hand-off point with the customer-room broadcast (a
 *      separate worker in Phase 10 persists the row).
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
import type { MembershipRepository } from '../../membership/repo.js';
import type { Logger } from '@dankdash/config';
import type { Redis } from 'ioredis';
import type { Namespace, Socket } from 'socket.io';

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
}

interface DriverSocketData {
  readonly driverId: string;
  readonly locationBucket: TokenBucket;
}

const driverLocationUpdateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().positive().optional(),
  speedMps: z.number().optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  orderId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
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

  nsp.on('connection', (socket) => {
    const { claims } = getSocketData(socket);
    const data = socket.data as Partial<DriverSocketData>;
    const driverId = data.driverId;
    if (driverId === undefined) {
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
        payload,
        redis: options.redis,
        logger: options.logger,
        idGen,
        clock,
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
    locationBucket: new TokenBucket({
      capacity: options.rateLimit.capacity,
      refillPerSecond: options.rateLimit.refillPerSecond,
    }),
  };
  Object.assign(socket.data, data);
}

interface HandleLocationCtx {
  readonly socket: Socket;
  readonly driverId: string;
  readonly payload: unknown;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly idGen: () => string;
  readonly clock: () => Date;
}

async function handleLocationUpdate(ctx: HandleLocationCtx): Promise<void> {
  const data = ctx.socket.data as Partial<DriverSocketData>;
  const bucket = data.locationBucket;
  if (bucket === undefined) {
    // Middleware set both fields — defensive null-check would mask a wiring bug.
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
    await publishRealtimeEvent(ctx.redis, {
      id: ctx.idGen(),
      emittedAt: ctx.clock().toISOString(),
      source: 'api',
      event: {
        type: 'driver:location',
        payload: {
          driverId: ctx.driverId,
          orderId: parsed.orderId ?? null,
          customerId: parsed.customerId ?? null,
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
