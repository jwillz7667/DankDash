/**
 * Unit coverage for the /driver location handler's server-authoritative
 * routing identity (audit fix H6).
 *
 * The vulnerability this guards against: the handler used to publish the
 * `orderId`/`customerId` verbatim from the client payload, and the streams
 * router fans `driver:location` out to `user:{customerId}`. A malicious
 * driver could therefore stream fabricated GPS into ANY customer's socket
 * by naming their id. These tests prove the published envelope's identity
 * is derived from the driver's active `orders` row via the membership repo
 * — never the payload — and that with no active delivery the ids are null
 * (so the router drops the broadcast).
 *
 * No Redis/DB: `publishRealtimeEvent` only calls `redis.xadd`, so a capture
 * fake suffices, and the membership repo is faked. Runs under an isolated
 * config in local dev (the suite's globalSetup boots a Redis container that
 * this file does not use); in CI it runs in-suite against the real config.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleLocationUpdate, resolveActiveDelivery } from '../src/io/namespaces/driver.js';
import { TokenBucket } from '../src/io/rate-limit.js';
import type { ActiveDelivery, MembershipRepository } from '../src/membership/repo.js';
import type { Logger } from '@dankdash/config';
import type { RealtimeEnvelope } from '@dankdash/realtime-events';
import type { Redis } from 'ioredis';
import type { Socket } from 'socket.io';

const DRIVER_RECORD_ID = '01900000-0000-7000-8000-0000000000c1';
const DRIVER_USER_ID = '01900000-0000-7000-8000-0000000000c2';
const ACTIVE_ORDER_ID = '01900000-0000-7000-8000-0000000000a1';
const ACTIVE_CUSTOMER_ID = '01900000-0000-7000-8000-0000000000b1';
const ACTIVE_DISPENSARY_ID = '01900000-0000-7000-8000-0000000000d1';
// What a malicious client would try to inject to target someone else.
const SPOOFED_ORDER_ID = '01900000-0000-7000-8000-0000000000a9';
const SPOOFED_CUSTOMER_ID = '01900000-0000-7000-8000-0000000000b9';
const ENVELOPE_ID = '01900000-0000-7000-8000-000000000099';
const FIXED_MS = Date.UTC(2026, 4, 19, 12, 0, 0);

function makeRedis(opts: { throws?: boolean } = {}): {
  redis: Redis;
  calls: () => number;
  lastEnvelope: () => RealtimeEnvelope;
} {
  const captured: string[][] = [];
  const redis = {
    xadd: (...args: string[]): Promise<string> => {
      if (opts.throws === true) return Promise.reject(new Error('redis down'));
      captured.push(args);
      return Promise.resolve('1-0');
    },
  };
  return {
    redis: redis as unknown as Redis,
    calls: () => captured.length,
    lastEnvelope: () => {
      const last = captured[captured.length - 1];
      if (last === undefined) throw new Error('no xadd captured');
      return JSON.parse(last[last.length - 1] ?? '') as RealtimeEnvelope;
    },
  };
}

function makeMembership(
  result: ActiveDelivery | null,
  opts: { throws?: boolean } = {},
): { membership: MembershipRepository; calls: () => number } {
  let count = 0;
  const membership: MembershipRepository = {
    isStaffOfDispensary: () => Promise.resolve(false),
    listStaffDispensariesForUser: () => Promise.resolve([]),
    isDriver: () => Promise.resolve(true),
    findDriverIdForUser: () => Promise.resolve(DRIVER_RECORD_ID),
    findActiveDeliveryForDriverUser: () => {
      count += 1;
      if (opts.throws === true) return Promise.reject(new Error('db down'));
      return Promise.resolve(result);
    },
  };
  return { membership, calls: () => count };
}

function makeSocket(bucketCapacity = 10): {
  socket: Socket;
  emitted: { event: string; payload: unknown }[];
} {
  const emitted: { event: string; payload: unknown }[] = [];
  const socket = {
    data: {
      driverId: DRIVER_RECORD_ID,
      driverUserId: DRIVER_USER_ID,
      locationBucket: new TokenBucket({ capacity: bucketCapacity, refillPerSecond: 0 }),
      deliveryCache: { entry: null },
    },
    emit: (event: string, payload: unknown): void => {
      emitted.push({ event, payload });
    },
  };
  return { socket: socket as unknown as Socket, emitted };
}

function makeLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  return { logger: { error } as unknown as Logger, error };
}

interface CtxOverrides {
  readonly membership: MembershipRepository;
  readonly socket: Socket;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly payload: unknown;
  readonly nowMs?: number;
  readonly ttlMs?: number;
}

function ctxOf(o: CtxOverrides): Parameters<typeof handleLocationUpdate>[0] {
  return {
    socket: o.socket,
    driverId: DRIVER_RECORD_ID,
    driverUserId: DRIVER_USER_ID,
    membership: o.membership,
    payload: o.payload,
    redis: o.redis,
    logger: o.logger,
    idGen: () => ENVELOPE_ID,
    clock: () => new Date(o.nowMs ?? FIXED_MS),
    activeDeliveryTtlMs: o.ttlMs ?? 5_000,
  };
}

const VALID_PAYLOAD = {
  lat: 44.978,
  lng: -93.265,
  accuracyMeters: 10,
  speedMps: 5,
  headingDeg: 90,
};

describe('handleLocationUpdate — server-authoritative routing identity (H6)', () => {
  it('publishes the active order/customer from the repo, ignoring spoofed payload ids', async () => {
    const { membership } = makeMembership({
      orderId: ACTIVE_ORDER_ID,
      customerId: ACTIVE_CUSTOMER_ID,
      dispensaryId: ACTIVE_DISPENSARY_ID,
    });
    const { socket } = makeSocket();
    const { redis, lastEnvelope } = makeRedis();
    const { logger } = makeLogger();

    await handleLocationUpdate(
      ctxOf({
        membership,
        socket,
        redis,
        logger,
        // Client tries to inject a victim's ids; the schema strips them and
        // the server overrides with the real delivery anyway.
        payload: {
          ...VALID_PAYLOAD,
          orderId: SPOOFED_ORDER_ID,
          customerId: SPOOFED_CUSTOMER_ID,
        },
      }),
    );

    const env = lastEnvelope();
    expect(env.event.type).toBe('driver:location');
    const payload = env.event.payload as Record<string, unknown>;
    expect(payload['customerId']).toBe(ACTIVE_CUSTOMER_ID);
    expect(payload['orderId']).toBe(ACTIVE_ORDER_ID);
    expect(payload['dispensaryId']).toBe(ACTIVE_DISPENSARY_ID);
    expect(payload['customerId']).not.toBe(SPOOFED_CUSTOMER_ID);
    expect(payload['orderId']).not.toBe(SPOOFED_ORDER_ID);
    expect(payload['driverId']).toBe(DRIVER_RECORD_ID);
    // GPS coordinates still come from the (trusted, self-reported) payload.
    expect(payload['lat']).toBe(44.978);
    expect(payload['lng']).toBe(-93.265);
  });

  it('publishes null ids when the driver has no active delivery (router then drops it)', async () => {
    const { membership } = makeMembership(null);
    const { socket } = makeSocket();
    const { redis, lastEnvelope } = makeRedis();
    const { logger } = makeLogger();

    await handleLocationUpdate(
      ctxOf({ membership, socket, redis, logger, payload: { ...VALID_PAYLOAD } }),
    );

    const payload = lastEnvelope().event.payload as Record<string, unknown>;
    expect(payload['customerId']).toBeNull();
    expect(payload['orderId']).toBeNull();
    expect(payload['dispensaryId']).toBeNull();
  });

  it('reuses the delivery lookup within the TTL window, then re-queries after it', async () => {
    const { membership, calls } = makeMembership({
      orderId: ACTIVE_ORDER_ID,
      customerId: ACTIVE_CUSTOMER_ID,
      dispensaryId: ACTIVE_DISPENSARY_ID,
    });
    const { socket } = makeSocket(10);
    const { redis } = makeRedis();
    const { logger } = makeLogger();

    // Two pings 1s apart, TTL 5s → one DB lookup.
    await handleLocationUpdate(
      ctxOf({
        membership,
        socket,
        redis,
        logger,
        payload: VALID_PAYLOAD,
        nowMs: FIXED_MS,
        ttlMs: 5_000,
      }),
    );
    await handleLocationUpdate(
      ctxOf({
        membership,
        socket,
        redis,
        logger,
        payload: VALID_PAYLOAD,
        nowMs: FIXED_MS + 1_000,
        ttlMs: 5_000,
      }),
    );
    expect(calls()).toBe(1);

    // A third ping past the TTL forces a refresh.
    await handleLocationUpdate(
      ctxOf({
        membership,
        socket,
        redis,
        logger,
        payload: VALID_PAYLOAD,
        nowMs: FIXED_MS + 6_000,
        ttlMs: 5_000,
      }),
    );
    expect(calls()).toBe(2);
  });

  it('rate-limits a burst: the second immediate ping is rejected, not published', async () => {
    const { membership } = makeMembership({
      orderId: ACTIVE_ORDER_ID,
      customerId: ACTIVE_CUSTOMER_ID,
      dispensaryId: ACTIVE_DISPENSARY_ID,
    });
    const { socket, emitted } = makeSocket(1); // capacity 1, no refill
    const { redis, calls } = makeRedis();
    const { logger } = makeLogger();

    await handleLocationUpdate(
      ctxOf({ membership, socket, redis, logger, payload: VALID_PAYLOAD }),
    );
    await handleLocationUpdate(
      ctxOf({ membership, socket, redis, logger, payload: VALID_PAYLOAD }),
    );

    expect(calls()).toBe(1);
    expect(emitted.some((e) => e.event === 'driver:location:rate_limited')).toBe(true);
  });

  it('rejects an invalid payload without publishing', async () => {
    const { membership } = makeMembership({
      orderId: ACTIVE_ORDER_ID,
      customerId: ACTIVE_CUSTOMER_ID,
      dispensaryId: ACTIVE_DISPENSARY_ID,
    });
    const { socket, emitted } = makeSocket();
    const { redis, calls } = makeRedis();
    const { logger } = makeLogger();

    await handleLocationUpdate(
      ctxOf({ membership, socket, redis, logger, payload: { lat: 999, lng: -93.265 } }),
    );

    expect(calls()).toBe(0);
    expect(emitted.some((e) => e.event === 'error')).toBe(true);
  });

  it('fails closed and logs when the delivery lookup throws — no broadcast', async () => {
    const { membership } = makeMembership(null, { throws: true });
    const { socket, emitted } = makeSocket();
    const { redis, calls } = makeRedis();
    const { logger, error } = makeLogger();

    await handleLocationUpdate(
      ctxOf({ membership, socket, redis, logger, payload: VALID_PAYLOAD }),
    );

    expect(calls()).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === 'error')).toBe(true);
  });

  it('logs and surfaces an error when the publish itself fails', async () => {
    const { membership } = makeMembership({
      orderId: ACTIVE_ORDER_ID,
      customerId: ACTIVE_CUSTOMER_ID,
      dispensaryId: ACTIVE_DISPENSARY_ID,
    });
    const { socket, emitted } = makeSocket();
    const { redis } = makeRedis({ throws: true });
    const { logger, error } = makeLogger();

    await handleLocationUpdate(
      ctxOf({ membership, socket, redis, logger, payload: VALID_PAYLOAD }),
    );

    expect(error).toHaveBeenCalledTimes(1);
    expect(emitted.some((e) => e.event === 'error')).toBe(true);
  });
});

describe('resolveActiveDelivery — TTL cache boundary', () => {
  it('serves a fresh value from cache without re-querying inside the window', async () => {
    const { membership, calls } = makeMembership({
      orderId: ACTIVE_ORDER_ID,
      customerId: ACTIVE_CUSTOMER_ID,
      dispensaryId: ACTIVE_DISPENSARY_ID,
    });
    const cache: { entry: { value: ActiveDelivery | null; resolvedAtMs: number } | null } = {
      entry: null,
    };

    const first = await resolveActiveDelivery({
      membership,
      driverUserId: DRIVER_USER_ID,
      cache,
      nowMs: FIXED_MS,
      ttlMs: 5_000,
    });
    const second = await resolveActiveDelivery({
      membership,
      driverUserId: DRIVER_USER_ID,
      cache,
      nowMs: FIXED_MS + 4_999,
      ttlMs: 5_000,
    });

    expect(first?.customerId).toBe(ACTIVE_CUSTOMER_ID);
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  it('re-queries once the entry is older than the TTL', async () => {
    const { membership, calls } = makeMembership(null);
    const cache: { entry: { value: ActiveDelivery | null; resolvedAtMs: number } | null } = {
      entry: null,
    };

    await resolveActiveDelivery({
      membership,
      driverUserId: DRIVER_USER_ID,
      cache,
      nowMs: FIXED_MS,
      ttlMs: 5_000,
    });
    await resolveActiveDelivery({
      membership,
      driverUserId: DRIVER_USER_ID,
      cache,
      nowMs: FIXED_MS + 5_000,
      ttlMs: 5_000,
    });

    expect(calls()).toBe(2);
  });
});
