/**
 * AeropayDriverPayoutGateway implementations.
 *
 * Two implementations live here:
 *
 *   - `StubAeropayDriverPayoutGateway` — Phase 20 default. Logs the
 *     intent and returns `null`. The persisted `payouts` row is the
 *     durable record; ops processes the cashout manually until the
 *     real upstream wiring lands. Returning `null` (rather than a
 *     fake ref) keeps the receiver's `aeropayPayoutRef` column
 *     honest — there is no upstream Aeropay row to point at.
 *
 *   - `LiveAeropayDriverPayoutGateway` — wraps the real
 *     `AeropayClient.createPayout`. Lit when `AEROPAY_LIVE=true`. The
 *     driver-side bank-account-link flow is a future phase, so the
 *     live branch currently raises `PAYMENT_METHOD_INVALID` because
 *     there is no `payment_methods` row to source `bankAccountId`
 *     from. The class is here as a placeholder so the eventual
 *     integration drops in without re-plumbing the module wiring.
 *
 * The gateway interface itself lives in `driver-cashout.service.ts`
 * alongside the service so the service module is self-contained
 * (interface + consumer) and the implementations are the seam.
 */
import { PaymentError } from '@dankdash/types';
import { Logger } from '@nestjs/common';
import { type AeropayClientLike } from '../../payments/tokens.js';
import { type AeropayDriverPayoutGateway } from './driver-cashout.service.js';

/**
 * Phase 20 default. Persisted-only cashout flow: log + return null.
 *
 * The driver-app UX intentionally treats `aeropayPayoutRef = null` as
 * "pending ops review" rather than "failed" — the persisted row will
 * surface in the wallet history with status='pending' and the
 * background reconciliation job (built in a future phase) will lift
 * the ref + flip to 'processing' once the bank push lands.
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

export interface LiveAeropayDriverPayoutGatewayConfig {
  readonly aeropay: AeropayClientLike;
}

/**
 * Live wrapper around `AeropayClient.createPayout`. Lit when
 * `AEROPAY_LIVE=true` is set.
 *
 * Three things have to be true before this is safe to enable:
 *
 *   1. The driver has a linked Aeropay bank account (Phase TBD —
 *      driver-side KYC + link flow).
 *   2. `AEROPAY_API_BASE_URL` points at the production endpoint
 *      (currently lives in `packages/config/src/env.ts`, defaulted
 *      to `https://api.aeropay.com`).
 *   3. The Aeropay webhook (already mounted by PaymentsModule) is
 *      enriched to handle `payout.paid` / `payout.failed` and patch
 *      the `payouts` row through `PayoutsRepository.updateStatus` —
 *      this is the reverse-write that lifts the row out of
 *      'processing'.
 *
 * Until then, `requestPayout` throws `PAYMENT_METHOD_INVALID` — the
 * persisted row stays in 'pending' and the user-visible error tells
 * the iOS layer to fall back to the stub flow.
 */
export class LiveAeropayDriverPayoutGateway implements AeropayDriverPayoutGateway {
  private readonly aeropay: AeropayClientLike;

  constructor(config: LiveAeropayDriverPayoutGatewayConfig) {
    this.aeropay = config.aeropay;
  }

  requestPayout(_input: {
    readonly payoutId: string;
    readonly driverUserId: string;
    readonly amountCents: number;
  }): Promise<string | null> {
    // Reference the field so eslint's no-unused-private + the future
    // implementation lands cleanly — `_` prefix on the param marks it
    // intentional-unused without burying the field.
    void this.aeropay;
    return Promise.reject(
      new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'driver Aeropay bank account linking is not yet implemented',
        { reason: 'driver_bank_link_phase_pending' },
        422,
      ),
    );
  }
}
