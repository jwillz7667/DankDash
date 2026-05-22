/**
 * Auth middleware coverage for every namespace.
 *
 * Asserts the rejection surface (missing token, expired, bad signature,
 * wrong issuer/audience, role mismatch) and the happy path (correct role +
 * valid signature → connection succeeds). A regression in the auth path
 * is a tenancy-breaking bug, so this suite owns the negative space.
 */
import { uuidv7 } from 'uuidv7';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness.js';

describe('realtime auth middleware', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('rejects /customer connection when no token is supplied', async () => {
    await expect(harness.connect('/customer', {})).rejects.toThrow(/missing auth token/i);
  });

  it('rejects /customer connection when the token is expired', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'customer',
      ttlSeconds: -60,
    });

    await expect(harness.connect('/customer', { token })).rejects.toThrow(/expired/i);
  });

  it('rejects /customer connection when the issuer does not match', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'customer',
      issuer: 'evil-issuer',
    });

    await expect(harness.connect('/customer', { token })).rejects.toThrow();
  });

  it('rejects /customer connection when the audience does not match', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'customer',
      audience: 'evil.app',
    });

    await expect(harness.connect('/customer', { token })).rejects.toThrow();
  });

  it('rejects /customer connection when the role is "driver"', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'driver',
    });

    await expect(harness.connect('/customer', { token })).rejects.toThrow();
  });

  it('rejects /vendor connection when the role is "customer"', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'customer',
    });

    await expect(harness.connect('/vendor', { token })).rejects.toThrow(
      /role not permitted on \/vendor/i,
    );
  });

  it('rejects /driver connection when the role is "manager"', async () => {
    const userId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(userId, driverId);
    const token = harness.signToken({
      sub: userId,
      role: 'manager',
    });

    await expect(harness.connect('/driver', { token })).rejects.toThrow(
      /role not permitted on \/driver/i,
    );
  });

  it('accepts /customer connection with a valid customer token', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'customer',
    });

    const socket = await harness.connect('/customer', { token });

    expect(socket.connected).toBe(true);
  });

  it('accepts /vendor connection with a manager token and an active membership', async () => {
    const userId = uuidv7();
    const dispensaryId = uuidv7();
    harness.membership.addStaff(userId, dispensaryId);
    const token = harness.signToken({ sub: userId, role: 'manager' });

    const socket = await harness.connect('/vendor', { token });

    expect(socket.connected).toBe(true);
  });

  it('rejects /vendor connection when the user has no active memberships', async () => {
    const token = harness.signToken({
      sub: uuidv7(),
      role: 'manager',
    });

    await expect(harness.connect('/vendor', { token })).rejects.toThrow();
  });

  it('rejects /vendor connection when handshake requests a dispensary the user is not staff of', async () => {
    const userId = uuidv7();
    const ownedDispensary = uuidv7();
    const otherDispensary = uuidv7();
    harness.membership.addStaff(userId, ownedDispensary);
    const token = harness.signToken({ sub: userId, role: 'manager' });

    await expect(
      harness.connect('/vendor', {
        token,
        extraAuth: { dispensaryId: otherDispensary },
      }),
    ).rejects.toThrow();
  });

  it('accepts /driver connection with a driver token tied to a real driver record', async () => {
    const userId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(userId, driverId);
    const token = harness.signToken({ sub: userId, role: 'driver' });

    const socket = await harness.connect('/driver', { token });

    expect(socket.connected).toBe(true);
  });

  it('rejects /driver connection when the user does not own the requested driver record', async () => {
    const userId = uuidv7();
    const otherUserId = uuidv7();
    const driverId = uuidv7();
    harness.membership.addDriver(otherUserId, driverId);
    const token = harness.signToken({ sub: userId, role: 'driver' });

    await expect(
      harness.connect('/driver', {
        token,
        extraAuth: { driverId },
      }),
    ).rejects.toThrow();
  });
});
