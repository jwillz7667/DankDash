/**
 * Unit tests for the two AeropayDriverPayoutGateway implementations.
 *
 * - `StubAeropayDriverPayoutGateway`: resolves to `null` (persisted-only
 *   flow — the row is the durable record while ops processes the cashout
 *   manually under `AEROPAY_LIVE=false`).
 * - `LiveAeropayDriverPayoutGateway`: dispatches a real Aeropay payout when
 *   the driver has a linked bank ref, and rejects with a typed
 *   `PaymentError('PAYMENT_METHOD_INVALID', …, 422)` when the driver has not
 *   linked a bank account (no driver row, or `aeropay_account_ref` null).
 */
import { type AeropayPayout, type CreatePayoutInput } from '@dankdash/aeropay';
import { type Driver } from '@dankdash/db';
import { PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  LiveAeropayDriverPayoutGateway,
  StubAeropayDriverPayoutGateway,
  type DriverBankRefReader,
} from './aeropay-driver-payout.gateway.js';
import type { AeropayClientLike } from '../../payments/tokens.js';

const PAYLOAD = {
  payoutId: '01935f3d-0000-7000-8000-000000000801',
  driverUserId: '01935f3d-0000-7000-8000-000000000802',
  amountCents: 5_000,
};

const NOW = new Date('2026-05-18T08:00:00.000Z');

function driverWithRef(aeropayAccountRef: string | null): Driver {
  return { aeropayAccountRef } as unknown as Driver;
}

function driversRepo(byUserId: Record<string, Driver | null>): DriverBankRefReader {
  return {
    findByUserId: (userId: string): Promise<Driver | null> =>
      Promise.resolve(byUserId[userId] ?? null),
  };
}

class FakeAeropay {
  createPayoutCalls: CreatePayoutInput[] = [];
  private seq = 1;

  createPayout = (input: CreatePayoutInput): Promise<AeropayPayout> => {
    this.createPayoutCalls.push(input);
    return Promise.resolve({
      id: `aeropay_payout_${this.seq++}`,
      status: 'in_transit',
      amountCents: input.amountCents,
      bankAccountId: input.bankAccountId,
      recipientRef: input.recipientRef,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: NOW,
    });
  };
}

describe('StubAeropayDriverPayoutGateway', () => {
  it('resolves to null so the persisted row stays the source of truth', async () => {
    const gateway = new StubAeropayDriverPayoutGateway();
    await expect(gateway.requestPayout(PAYLOAD)).resolves.toBeNull();
  });
});

describe('LiveAeropayDriverPayoutGateway', () => {
  it('dispatches an Aeropay payout and returns the upstream ref for a linked driver', async () => {
    const aeropay = new FakeAeropay();
    const gateway = new LiveAeropayDriverPayoutGateway({
      aeropay: aeropay as unknown as AeropayClientLike,
      drivers: driversRepo({ [PAYLOAD.driverUserId]: driverWithRef('bank_driver_ref') }),
      clock: () => NOW,
    });

    const ref = await gateway.requestPayout(PAYLOAD);

    expect(ref).toBe('aeropay_payout_1');
    expect(aeropay.createPayoutCalls).toHaveLength(1);
    const call = aeropay.createPayoutCalls[0];
    expect(call?.bankAccountId).toBe('bank_driver_ref');
    expect(call?.amountCents).toBe(5_000);
    expect(call?.recipientRef).toBe(`driver:${PAYLOAD.driverUserId}`);
    expect(call?.idempotencyKey).toBe(`payout:${PAYLOAD.payoutId}`);
    expect(call?.periodStart.toISOString()).toBe(NOW.toISOString());
    expect(call?.periodEnd.toISOString()).toBe(NOW.toISOString());
  });

  it('rejects with PAYMENT_METHOD_INVALID when the driver has no linked bank ref', async () => {
    const aeropay = new FakeAeropay();
    const gateway = new LiveAeropayDriverPayoutGateway({
      aeropay: aeropay as unknown as AeropayClientLike,
      drivers: driversRepo({ [PAYLOAD.driverUserId]: driverWithRef(null) }),
      clock: () => NOW,
    });

    const promise = gateway.requestPayout(PAYLOAD);
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 422,
      details: { reason: 'driver_bank_account_not_linked' },
    });
    expect(aeropay.createPayoutCalls).toHaveLength(0);
  });

  it('rejects with PAYMENT_METHOD_INVALID when the driver row does not exist', async () => {
    const aeropay = new FakeAeropay();
    const gateway = new LiveAeropayDriverPayoutGateway({
      aeropay: aeropay as unknown as AeropayClientLike,
      drivers: driversRepo({}),
      clock: () => NOW,
    });

    const promise = gateway.requestPayout(PAYLOAD);
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 422,
    });
    expect(aeropay.createPayoutCalls).toHaveLength(0);
  });
});
