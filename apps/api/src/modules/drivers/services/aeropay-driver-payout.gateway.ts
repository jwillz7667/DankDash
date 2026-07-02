/**
 * AeropayDriverPayoutGateway implementations.
 *
 * Two implementations live here:
 *
 *   - `StubAeropayDriverPayoutGateway` — default when `AEROPAY_LIVE=false`.
 *     Logs the intent and returns `null`. The persisted `payouts` row is the
 *     durable record; ops processes the cashout manually while the live
 *     integration is dark. Returning `null` (rather than a fake ref) keeps
 *     the receiver's `aeropayPayoutRef` column honest — there is no upstream
 *     Aeropay row to point at.
 *
 *   - `LiveAeropayDriverPayoutGateway` — wraps the real
 *     `AeropayClient.createPayout`. Lit when `AEROPAY_LIVE=true`. It resolves
 *     the driver's linked bank account (`drivers.aeropay_account_ref`, keyed
 *     by `users.id`) and dispatches an ACH payout, mirroring the nightly
 *     batch job's `dispatchPayout`. A driver with no linked bank account is
 *     refused with a typed `PaymentError` the iOS layer renders as
 *     "link your bank first".
 *
 * The gateway interface itself lives in `driver-cashout.service.ts` alongside
 * the service so the service module is self-contained (interface + consumer)
 * and the implementations are the seam.
 */
import { type DriversRepository } from '@dankdash/db';
import { PaymentError } from '@dankdash/types';
import { Logger } from '@nestjs/common';
import { buildDriverCustomerRef } from '../../payments/driver-bank-link.service.js';
import { type AeropayClientLike } from '../../payments/tokens.js';
import { type AeropayDriverPayoutGateway } from './driver-cashout.service.js';

/**
 * Default when `AEROPAY_LIVE=false`. Persisted-only cashout flow: log +
 * return null.
 *
 * The driver-app UX intentionally treats `aeropayPayoutRef = null` as
 * "pending ops review" rather than "failed" — the persisted row surfaces in
 * the wallet history with status='pending' and ops (or the future
 * reconciliation job) lifts the ref + flips to 'processing' once the bank
 * push lands.
 */
export class StubAeropayDriverPayoutGateway implements AeropayDriverPayoutGateway {
  private readonly logger = new Logger(StubAeropayDriverPayoutGateway.name);

  requestPayout(input: {
    readonly payoutId: string;
    readonly driverUserId: string;
    readonly amountCents: number;
  }): Promise<string | null> {
    this.logger.log(
      {
        payoutId: input.payoutId,
        driverUserId: input.driverUserId,
        amountCents: input.amountCents,
      },
      'driver cashout requested — stub (AEROPAY_LIVE=false), persisted row awaits ops',
    );
    return Promise.resolve(null);
  }
}

/** Narrow read surface the live gateway needs to resolve a driver's bank ref. */
export type DriverBankRefReader = Pick<DriversRepository, 'findByUserId'>;

export interface LiveAeropayDriverPayoutGatewayConfig {
  readonly aeropay: AeropayClientLike;
  readonly drivers: DriverBankRefReader;
  /** Clock injection for deterministic tests. */
  readonly clock?: () => Date;
}

/**
 * Live wrapper around `AeropayClient.createPayout`. Lit when
 * `AEROPAY_LIVE=true`.
 *
 * Flow (mirrors `dispatchPayout` in the nightly payout job):
 *
 *   1. Resolve the driver's linked bank account via
 *      `DriversRepository.findByUserId(driverUserId).aeropayAccountRef`.
 *      Missing driver or missing ref → typed `PaymentError`
 *      (`PAYMENT_METHOD_INVALID`, 422, `reason: driver_bank_account_not_linked`).
 *      The cashout service leaves the persisted `payouts` row in 'pending' and
 *      re-throws; the controller renders 422 and the iOS client surfaces
 *      "link your bank first".
 *   2. `aeropay.createPayout({ bankAccountId, amountCents, recipientRef,
 *      periodStart, periodEnd, idempotencyKey })` with
 *      `recipientRef = driver:<userId>` (identical to the batch job) and
 *      `idempotencyKey = payout:<payoutId>` so a retry after a crash between
 *      the row insert and this call coalesces upstream.
 *   3. Return the upstream payout id; the cashout service flips the row to
 *      'processing' and records the ref, and the payout.paid / payout.failed
 *      webhooks (PayoutWebhookService) later flip it to completed / failed —
 *      the same terminal path dispensary payouts use, keyed on
 *      `aeropay_payout_ref`.
 *
 * The instant cashout has no meaningful period window (unlike the daily
 * batch), so `periodStart == periodEnd == now`. Aeropay treats these as
 * informational metadata on the payout; the durable audit instant is the
 * `payouts.created_at` the service already stamps.
 */
export class LiveAeropayDriverPayoutGateway implements AeropayDriverPayoutGateway {
  private readonly aeropay: AeropayClientLike;
  private readonly drivers: DriverBankRefReader;
  private readonly clock: () => Date;

  constructor(config: LiveAeropayDriverPayoutGatewayConfig) {
    this.aeropay = config.aeropay;
    this.drivers = config.drivers;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async requestPayout(input: {
    readonly payoutId: string;
    readonly driverUserId: string;
    readonly amountCents: number;
  }): Promise<string | null> {
    const driver = await this.drivers.findByUserId(input.driverUserId);
    const bankAccountId = driver?.aeropayAccountRef ?? null;
    if (bankAccountId === null) {
      throw new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'link a bank account before cashing out',
        { reason: 'driver_bank_account_not_linked', driverUserId: input.driverUserId },
        422,
      );
    }

    const now = this.clock();
    const upstream = await this.aeropay.createPayout({
      bankAccountId,
      amountCents: input.amountCents,
      recipientRef: buildDriverCustomerRef(input.driverUserId),
      periodStart: now,
      periodEnd: now,
      idempotencyKey: `payout:${input.payoutId}`,
    });
    return upstream.id;
  }
}
