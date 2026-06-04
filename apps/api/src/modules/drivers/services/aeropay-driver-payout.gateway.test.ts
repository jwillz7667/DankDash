/**
 * Unit tests for the two AeropayDriverPayoutGateway implementations.
 *
 * - `StubAeropayDriverPayoutGateway`: resolves to `null` (persisted-only
 *   flow — the row is the durable record while ops processes the cashout
 *   manually).
 * - `LiveAeropayDriverPayoutGateway`: rejects with
 *   `PaymentError('PAYMENT_METHOD_INVALID', …, 422)` because the driver-
 *   side bank-account-link flow is a future phase. This test exists to
 *   catch a regression where the live branch is "fixed" to silently
 *   return null — that would lose ops visibility into the upstream gap.
 */
import { PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  LiveAeropayDriverPayoutGateway,
  StubAeropayDriverPayoutGateway,
} from './aeropay-driver-payout.gateway.js';
import type { AeropayClientLike } from '../../payments/tokens.js';

const PAYLOAD = {
  payoutId: '01935f3d-0000-7000-8000-000000000801',
  driverUserId: '01935f3d-0000-7000-8000-000000000802',
  amountCents: 5_000,
};

describe('StubAeropayDriverPayoutGateway', () => {
  it('resolves to null so the persisted row stays the source of truth', async () => {
    const gateway = new StubAeropayDriverPayoutGateway();
    await expect(gateway.requestPayout(PAYLOAD)).resolves.toBeNull();
  });
});

describe('LiveAeropayDriverPayoutGateway', () => {
  // We don't exercise any AeropayClient method in the current phase — the
  // live branch fast-rejects before reaching the client.
  const fakeAeropay = {} as AeropayClientLike;

  it('rejects with PAYMENT_METHOD_INVALID until the driver bank-link flow lands', async () => {
    const gateway = new LiveAeropayDriverPayoutGateway({ aeropay: fakeAeropay });
    const promise = gateway.requestPayout(PAYLOAD);
    await expect(promise).rejects.toBeInstanceOf(PaymentError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_INVALID',
      statusCode: 422,
      details: { reason: 'driver_bank_link_phase_pending' },
    });
  });
});
