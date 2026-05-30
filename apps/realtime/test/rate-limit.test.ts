/**
 * driver:location:update rate-limit + payload validation coverage.
 *
 * The driver namespace exposes one client-to-server mutation
 * (`driver:location:update`) and it is the only place an unprivileged
 * client can write into the realtime stream. A regression in either the
 * token-bucket rate limit or the zod payload guard would let a noisy
 * device flood the customer namespace, so this suite owns both surfaces.
 */
import { decodeStreamEntry, REALTIME_STREAM_KEY } from '@dankdash/realtime-events';
import { ConfigError } from '@dankdash/types';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, expectEvent, waitUntil, type TestHarness } from './harness.js';

describe('driver:location:update', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('publishes the location envelope onto the realtime stream and broadcasts to the assigned customer', async () => {
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    const customerId = uuidv7();
    const orderId = uuidv7();
    harness.membership.addDriver(driverUserId, driverId);
    // The handler resolves the broadcast's customer identity server-side from
    // the driver's active `orders` row, never the client payload (see
    // io/namespaces/driver.ts — a driver must not be able to stream GPS into
    // an arbitrary customer's socket by naming their id). Without an active
    // delivery the location publishes with a null customerId and the router
    // drops it, so the assigned-customer broadcast can only be asserted once
    // a delivery is registered for this driver.
    harness.membership.setActiveDelivery(driverUserId, { orderId, customerId });

    const driverSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: driverUserId, role: 'driver' }),
    });
    const customerSocket = await harness.connect('/customer', {
      token: harness.signToken({ sub: customerId, role: 'customer' }),
    });

    const expectation = expectEvent<{ driverId: string; lat: number; lng: number }>(
      customerSocket,
      'driver:location',
    );

    // `orderId`/`customerId` here are intentionally ignored by the handler
    // (stripped by the schema); routing uses the registered delivery above.
    driverSocket.emit('driver:location:update', {
      lat: 44.9778,
      lng: -93.265,
      accuracyMeters: 5,
      speedMps: 8,
      headingDeg: 180,
      batteryPct: 84,
      orderId: uuidv7(),
      customerId,
    });

    const payload = await expectation;
    expect(payload.driverId).toBe(driverId);
    expect(payload.lat).toBe(44.9778);
    expect(payload.lng).toBe(-93.265);
  });

  it('emits driver:location:rate_limited once the per-second bucket is empty', async () => {
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(driverUserId, driverId);

    const driverSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: driverUserId, role: 'driver' }),
    });

    let rateLimitedCount = 0;
    driverSocket.on('driver:location:rate_limited', () => {
      rateLimitedCount += 1;
    });

    // Burst capacity is 2 (harness env). Fire 6 in tight succession.
    const payload = {
      lat: 44.9,
      lng: -93.2,
      accuracyMeters: 6,
    };
    for (let i = 0; i < 6; i += 1) {
      driverSocket.emit('driver:location:update', payload);
    }

    await waitUntil(() => rateLimitedCount >= 4, {
      timeoutMs: 2_000,
      label: 'rate_limited events from driver:location:update flood',
    });
    expect(rateLimitedCount).toBeGreaterThanOrEqual(4);
  });

  it('emits a validation error when the payload fails the zod schema', async () => {
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(driverUserId, driverId);

    const driverSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: driverUserId, role: 'driver' }),
    });

    const expectation = expectEvent<{ code: string; message: string }>(driverSocket, 'error');

    driverSocket.emit('driver:location:update', {
      lat: 999, // out of range
      lng: -93.2,
    });

    const err = await expectation;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/invalid/i);
  });

  it('responds to driver:heartbeat with an ack carrying a server timestamp', async () => {
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(driverUserId, driverId);

    const driverSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: driverUserId, role: 'driver' }),
    });

    const expectation = expectEvent<{ at: string }>(driverSocket, 'driver:heartbeat:ack');
    driverSocket.emit('driver:heartbeat');
    const ack = await expectation;
    expect(typeof ack.at).toBe('string');
    expect(Number.isNaN(Date.parse(ack.at))).toBe(false);
  });

  it('writes a well-formed envelope onto the dankdash:realtime stream that the consumer can decode', async () => {
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(driverUserId, driverId);

    // Inspect the stream directly to confirm wire format.
    const reader = new Redis(harness.redisUrl, { maxRetriesPerRequest: 1 });
    try {
      const before = await reader.xlen(REALTIME_STREAM_KEY);

      const driverSocket = await harness.connect('/driver', {
        token: harness.signToken({ sub: driverUserId, role: 'driver' }),
      });
      driverSocket.emit('driver:location:update', {
        lat: 44.9,
        lng: -93.2,
        customerId: uuidv7(),
      });

      await waitUntil(async () => (await reader.xlen(REALTIME_STREAM_KEY)) > before, {
        timeoutMs: 3_000,
        label: 'XADD by driver:location:update',
      });

      const entries = (await reader.xrevrange(REALTIME_STREAM_KEY, '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >;
      expect(entries.length).toBe(1);
      const entry = entries[0];
      if (entry === undefined) {
        throw new ConfigError(
          'CONFIG_INVALID',
          'unreachable — xrevrange returned empty after length check',
        );
      }
      const decoded = decodeStreamEntry(entry[0], entry[1]);
      expect(decoded.envelope.event.type).toBe('driver:location');
    } finally {
      reader.disconnect();
    }
  });
});
