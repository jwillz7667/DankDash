/**
 * Driver payout bank-account linking — the driver-side analogue of
 * `DispensaryBankLinkService`. Populates `drivers.aeropay_account_ref`, the
 * value both driver payout paths hand to Aeropay:
 *
 *   • instant cashout  — `LiveAeropayDriverPayoutGateway.requestPayout` reads
 *                         it and refuses (422) when it is NULL.
 *   • nightly batch     — `runDriverPayouts` dispatches drivers whose column
 *                         is set and records the rest `pending`.
 *
 * Three responsibilities:
 *
 *   1. `startLink(driverUserId, returnUrl)` — mint an Aeropay hosted link
 *      session scoped to the driver. The DankDasher app opens the returned
 *      `hostedUrl`; Aeropay redirects back to `returnUrl` on completion.
 *   2. `getStatus(driverUserId)` — report whether the driver already has a
 *      confirmed bank account on file (boolean only; the ref itself is a
 *      Restricted value that never leaves the server).
 *   3. `applyBankLinked` / `applyBankFailed` — the webhook side effects,
 *      invoked by PaymentMethodsService.applyWebhook once Aeropay confirms
 *      (or fails) the link.
 *
 * Customer-ref namespacing — the same load-bearing decision the dispensary
 * flow documents:
 *
 *   Aeropay keys everything on an opaque `customer_ref` it echoes back in
 *   `getBankAccount`. The consumer flow uses a bare `userId`; the dispensary
 *   flow uses `dispensary:<id>`. Drivers use `driver:<userId>` — the same
 *   namespacing the payout job already uses for the driver `recipient_ref`
 *   (`driver:<userId>`, since `orders.driver_id` references `users.id`). The
 *   webhook dispatcher parses the prefix to route: `dispensary:` → dispensary
 *   link, `driver:` → driver link, bare UUID → consumer link. All three are
 *   disjoint, so this is backward compatible with every existing link.
 *
 * The driver id in the ref is the `users.id` (the JWT subject), NOT the
 * `drivers.id` profile row id — that keeps the ref identical to the payout
 * recipient ref and lets both payout paths key off the same value without a
 * profile lookup. Persisting the confirmed ref DOES look the profile up by
 * `user_id` because the column lives on the `drivers` row.
 *
 * Why the link ref is NOT persisted at start time: `link.id` is a hosted
 * *session* id, not a usable bank-account id. `aeropay_account_ref` is
 * handed straight to `aeropay.createPayout({ bankAccountId })`, so it is
 * written only by the `bank_account.linked` webhook, which carries the
 * confirmed account id.
 */
import { type DriversRepository } from '@dankdash/db';
import { NotFoundError, PaymentError } from '@dankdash/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AEROPAY_CLIENT, type AeropayClientLike } from './tokens.js';
import type { DriverBankAccountStatusResponse, StartDriverBankLinkResponse } from './dto/index.js';

const DRIVER_CUSTOMER_REF_PREFIX = 'driver:';

/** Build the namespaced Aeropay `customer_ref` for a driver link. */
export function buildDriverCustomerRef(driverUserId: string): string {
  return `${DRIVER_CUSTOMER_REF_PREFIX}${driverUserId}`;
}

/**
 * Extract the driver `users.id` from an Aeropay `customer_ref`, or `null`
 * when the ref is not a driver ref (a `dispensary:<id>` ref or a bare
 * consumer `userId`). Used by the webhook dispatcher to route
 * `bank_account.*` events.
 */
export function parseDriverCustomerRef(customerRef: string): string | null {
  if (!customerRef.startsWith(DRIVER_CUSTOMER_REF_PREFIX)) return null;
  const driverUserId = customerRef.slice(DRIVER_CUSTOMER_REF_PREFIX.length);
  return driverUserId.length === 0 ? null : driverUserId;
}

@Injectable()
export class DriverBankLinkService {
  private readonly logger = new Logger(DriverBankLinkService.name);

  constructor(
    private readonly drivers: DriversRepository,
    @Inject(AEROPAY_CLIENT) private readonly aeropay: AeropayClientLike,
  ) {}

  /**
   * Kick off an Aeropay hosted bank-link session for the driver. Like the
   * dispensary flow there is no `pending` row to guard against — the driver
   * carries a single `aeropay_account_ref` column, so a fresh session is
   * always safe to mint (a relink overwrites the ref once the new webhook
   * lands). Aeropay coalesces on `customer_ref`.
   */
  async startLink(driverUserId: string, returnUrl: string): Promise<StartDriverBankLinkResponse> {
    const link = await this.aeropay.linkBankAccount({
      customerRef: buildDriverCustomerRef(driverUserId),
      returnUrl,
    });
    return {
      link: {
        id: link.id,
        hostedUrl: link.hostedUrl,
        expiresAt: link.expiresAt.toISOString(),
      },
    };
  }

  async getStatus(driverUserId: string): Promise<DriverBankAccountStatusResponse> {
    const driver = await this.drivers.findByUserId(driverUserId);
    if (driver === null) {
      // RolesGuard('driver') proved the caller holds the driver role, so the
      // profile row should exist; a null here is a hard data-integrity race,
      // not a client error we mask as 404.
      throw new NotFoundError('driver', driverUserId);
    }
    return { linked: driver.aeropayAccountRef !== null };
  }

  /**
   * Persist the confirmed Aeropay bank-account id onto the driver. Called
   * from the `bank_account.linked` webhook once the customer_ref prefix has
   * identified the account as a driver link.
   *
   * Idempotent: a replayed webhook whose account id already matches is a
   * no-op. A missing driver is treated as benign (return, not throw) so a
   * stray event from another environment does not trigger Aeropay's retry
   * storm — the same posture the dispensary + consumer paths take.
   */
  async applyBankLinked(driverUserId: string, bankAccountId: string): Promise<void> {
    const driver = await this.drivers.findByUserId(driverUserId);
    if (driver === null) {
      this.logger.warn(`bank_account.linked for unknown driver ${driverUserId} — ignoring`);
      return;
    }
    if (driver.aeropayAccountRef === bankAccountId) return;

    const updated = await this.drivers.update(driver.id, {
      aeropayAccountRef: bankAccountId,
    });
    if (updated === null) {
      throw new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'driver row vanished mid bank-link webhook',
        { driverUserId },
        500,
      );
    }
  }

  /**
   * A driver bank link failed upstream. There is no per-attempt row to flip
   * — the driver either has a good `aeropay_account_ref` (from a prior
   * success, which we must not clobber) or none. We log for ops visibility
   * and leave the ref untouched; the app continues to show "not linked"
   * until a future attempt succeeds.
   */
  applyBankFailed(driverUserId: string): void {
    this.logger.warn(`bank_account.failed for driver ${driverUserId} — link not established`);
  }
}
