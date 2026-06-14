/**
 * End-to-end coverage for the stream → broadcast pipeline.
 *
 * Each test publishes a RealtimeEnvelope onto the Redis Stream the same
 * way the API and worker pods do in production, then asserts that the
 * server's StreamConsumer routes it to the correct namespace + room.
 * The negative assertions (sibling tenant should NOT receive the event)
 * are as important as the positive ones — a room-isolation regression
 * is a cross-tenant data leak.
 */
import { uuidv7 } from 'uuidv7';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, expectEvent, type TestHarness } from './harness.js';

describe('realtime stream → broadcast routing', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('order:created → /vendor[dispensary] reaches only the matching dispensary room', async () => {
    const dispensaryA = uuidv7();
    const dispensaryB = uuidv7();
    const userA = uuidv7();
    const userB = uuidv7();
    harness.membership.addStaff(userA, dispensaryA);
    harness.membership.addStaff(userB, dispensaryB);

    const tokenA = harness.signToken({ sub: userA, role: 'manager' });
    const tokenB = harness.signToken({ sub: userB, role: 'manager' });
    const socketA = await harness.connect('/vendor', { token: tokenA });
    const socketB = await harness.connect('/vendor', { token: tokenB });

    let receivedByB = false;
    socketB.on('order:created', () => {
      receivedByB = true;
    });

    const expectation = expectEvent<{ orderId: string; dispensaryId: string }>(
      socketA,
      'order:created',
    );

    await harness.publishEnvelope({
      type: 'order:created',
      payload: {
        orderId: uuidv7(),
        customerId: uuidv7(),
        dispensaryId: dispensaryA,
        shortCode: 'ABC-123',
        totalCents: 4200,
        status: 'pending_acceptance',
        placedAt: new Date().toISOString(),
      },
    });

    const payload = await expectation;
    expect(payload.dispensaryId).toBe(dispensaryA);
    // Give the wire a beat to confirm the sibling did NOT receive a copy.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(receivedByB).toBe(false);
  });

  it('order:status_changed reaches the customer, the vendor, and the assigned driver', async () => {
    const customerId = uuidv7();
    const dispensaryId = uuidv7();
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    const vendorUserId = uuidv7();
    harness.membership.addStaff(vendorUserId, dispensaryId);
    harness.membership.addDriver(driverUserId, driverId);

    const customerSocket = await harness.connect('/customer', {
      token: harness.signToken({ sub: customerId, role: 'customer' }),
    });
    const vendorSocket = await harness.connect('/vendor', {
      token: harness.signToken({ sub: vendorUserId, role: 'manager' }),
    });
    const driverSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: driverUserId, role: 'driver' }),
    });

    const customerAwait = expectEvent<{ toStatus: string }>(customerSocket, 'order:status_changed');
    const vendorAwait = expectEvent<{ toStatus: string }>(vendorSocket, 'order:status_changed');
    const driverAwait = expectEvent<{ toStatus: string }>(driverSocket, 'order:status_changed');

    await harness.publishEnvelope({
      type: 'order:status_changed',
      payload: {
        orderId: uuidv7(),
        customerId,
        dispensaryId,
        driverId,
        fromStatus: 'accepted',
        toStatus: 'en_route_dropoff',
        changedAt: new Date().toISOString(),
      },
    });

    const [c, v, d] = await Promise.all([customerAwait, vendorAwait, driverAwait]);
    expect(c.toStatus).toBe('en_route_dropoff');
    expect(v.toStatus).toBe('en_route_dropoff');
    expect(d.toStatus).toBe('en_route_dropoff');
  });

  it('driver:location is delivered to the assigned customer only (not random customers)', async () => {
    const assignedCustomer = uuidv7();
    const otherCustomer = uuidv7();
    const driverUserId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(driverUserId, driverId);

    const assignedSocket = await harness.connect('/customer', {
      token: harness.signToken({ sub: assignedCustomer, role: 'customer' }),
    });
    const otherSocket = await harness.connect('/customer', {
      token: harness.signToken({ sub: otherCustomer, role: 'customer' }),
    });

    let receivedByOther = false;
    otherSocket.on('driver:location', () => {
      receivedByOther = true;
    });

    const expectation = expectEvent<{ driverId: string; lat: number }>(
      assignedSocket,
      'driver:location',
    );

    await harness.publishEnvelope({
      type: 'driver:location',
      payload: {
        driverId,
        orderId: uuidv7(),
        customerId: assignedCustomer,
        dispensaryId: null,
        lat: 44.9778,
        lng: -93.265,
        accuracyMeters: 6,
        speedMps: 12,
        headingDeg: 90,
        recordedAt: new Date().toISOString(),
      },
    });

    const payload = await expectation;
    expect(payload.driverId).toBe(driverId);
    expect(payload.lat).toBe(44.9778);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(receivedByOther).toBe(false);
  });

  it('offer:new is delivered to the targeted driver only', async () => {
    const targetUserId = uuidv7();
    const targetDriverId = uuidv7();
    const otherUserId = uuidv7();
    const otherDriverId = uuidv7();
    harness.membership.addDriver(targetUserId, targetDriverId);
    harness.membership.addDriver(otherUserId, otherDriverId);

    const targetSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: targetUserId, role: 'driver' }),
    });
    const otherSocket = await harness.connect('/driver', {
      token: harness.signToken({ sub: otherUserId, role: 'driver' }),
    });

    let receivedByOther = false;
    otherSocket.on('offer:new', () => {
      receivedByOther = true;
    });

    const expectation = expectEvent<{ driverId: string; offerId: string }>(
      targetSocket,
      'offer:new',
    );

    const offerId = uuidv7();
    await harness.publishEnvelope({
      type: 'offer:new',
      payload: {
        offerId,
        orderId: uuidv7(),
        driverId: targetDriverId,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        payoutEstimateCents: 1200,
        distanceMiles: 2.3,
      },
    });

    const payload = await expectation;
    expect(payload.driverId).toBe(targetDriverId);
    expect(payload.offerId).toBe(offerId);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(receivedByOther).toBe(false);
  });
});
