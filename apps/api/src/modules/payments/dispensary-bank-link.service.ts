/**
 * Dispensary payout bank-account linking — the vendor-side analogue of the
 * consumer Aeropay bank-link flow in PaymentMethodsService.
 *
 * A dispensary must have a linked Aeropay bank account before the nightly
 * payout job (`apps/workers/src/jobs/payouts/payout.job.ts`) can dispatch
 * its earnings — otherwise the job marks the payout `failed` with
 * `dispensary_bank_account_not_linked`. This service is the flow that
 * populates `dispensaries.aeropay_account_ref`.
 *
 * Three responsibilities:
 *
 *   1. `startLink(ctx, returnUrl)` — mint an Aeropay hosted link session
 *      scoped to the dispensary. The portal opens the returned `hostedUrl`;
 *      Aeropay redirects back to `returnUrl` on completion.
 *   2. `getStatus(ctx)` — report whether the dispensary already has a
 *      confirmed bank account on file (boolean only; the ref itself is a
 *      Restricted value that never leaves the server).
 *   3. `applyBankLinked` / `applyBankFailed` — the webhook side effects,
 *      invoked by PaymentMethodsService.applyWebhook once Aeropay confirms
 *      (or fails) the link.
 *
 * Customer-ref namespacing — the load-bearing design decision:
 *
 *   Aeropay's link + bank-account model keys everything on an opaque
 *   `customer_ref` string that it echoes back in `getBankAccount`. The
 *   consumer flow uses the bare `userId` as `customer_ref`. If dispensaries
 *   also used a bare id, the `bank_account.linked` webhook could not tell a
 *   dispensary link from a consumer link (both are UUIDs) and would route a
 *   dispensary bank account into `findPendingForCustomer`'s consumer lookup.
 *
 *   So dispensary sessions are opened with `customer_ref = "dispensary:<id>"`
 *   — the same namespacing the payout job already uses for `recipient_ref`
 *   (`"dispensary:<id>"`). The webhook dispatcher parses the prefix to route.
 *   Bare UUIDs (no prefix) remain the consumer path, so this is backward
 *   compatible with every existing consumer link.
 *
 * Why the link ref is NOT persisted at start time: `link.id` is a hosted
 * *session* id, not a usable bank-account id. The payout job hands
 * `aeropay_account_ref` straight to `aeropay.createPayout({ bankAccountId })`,
 * so persisting a session id there would dispatch payouts against a
 * non-existent account. `aeropay_account_ref` is written only by the
 * `bank_account.linked` webhook, which carries the confirmed account id.
 */
import { type DispensariesRepository } from '@dankdash/db';
import { NotFoundError, PaymentError } from '@dankdash/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AEROPAY_CLIENT, type AeropayClientLike } from './tokens.js';
import type {
  DispensaryBankAccountStatusResponse,
  StartDispensaryBankLinkResponse,
} from './dto/index.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

const DISPENSARY_CUSTOMER_REF_PREFIX = 'dispensary:';

/** Build the namespaced Aeropay `customer_ref` for a dispensary link. */
export function buildDispensaryCustomerRef(dispensaryId: string): string {
  return `${DISPENSARY_CUSTOMER_REF_PREFIX}${dispensaryId}`;
}

/**
 * Extract the dispensary id from an Aeropay `customer_ref`, or `null` when
 * the ref is not a dispensary ref (i.e. it's a bare consumer `userId`).
 * Used by the webhook dispatcher to route `bank_account.*` events.
 */
export function parseDispensaryCustomerRef(customerRef: string): string | null {
  if (!customerRef.startsWith(DISPENSARY_CUSTOMER_REF_PREFIX)) return null;
  const dispensaryId = customerRef.slice(DISPENSARY_CUSTOMER_REF_PREFIX.length);
  return dispensaryId.length === 0 ? null : dispensaryId;
}

@Injectable()
export class DispensaryBankLinkService {
  private readonly logger = new Logger(DispensaryBankLinkService.name);

  constructor(
    private readonly dispensaries: DispensariesRepository,
    @Inject(AEROPAY_CLIENT) private readonly aeropay: AeropayClientLike,
  ) {}

  /**
   * Kick off an Aeropay hosted bank-link session for the active dispensary.
   * Unlike the consumer flow there is no `pending` row to guard against —
   * the dispensary carries a single `aeropay_account_ref` column, so a
   * fresh session is always safe to mint (a relink simply overwrites the
   * ref once the new webhook lands). Aeropay coalesces on `customer_ref`.
   */
  async startLink(ctx: VendorContext, returnUrl: string): Promise<StartDispensaryBankLinkResponse> {
    const link = await this.aeropay.linkBankAccount({
      customerRef: buildDispensaryCustomerRef(ctx.dispensaryId),
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

  async getStatus(ctx: VendorContext): Promise<DispensaryBankAccountStatusResponse> {
    const dispensary = await this.dispensaries.findById(ctx.dispensaryId);
    if (dispensary === null) {
      // The VendorContextGuard proved active staff membership, so the row
      // should exist; a null here is a hard data-integrity race, not a
      // client error we mask as 404.
      throw new NotFoundError('dispensary', ctx.dispensaryId);
    }
    return { linked: dispensary.aeropayAccountRef !== null };
  }

  /**
   * Persist the confirmed Aeropay bank-account id onto the dispensary.
   * Called from the `bank_account.linked` webhook once the customer_ref
   * prefix has identified the account as a dispensary link.
   *
   * Idempotent: a replayed webhook whose account id already matches is a
   * no-op. A missing dispensary is treated as benign (return, not throw) so
   * a stray event from another environment does not trigger Aeropay's retry
   * storm — same posture the consumer path takes for an unmatched account.
   */
  async applyBankLinked(dispensaryId: string, bankAccountId: string): Promise<void> {
    const dispensary = await this.dispensaries.findById(dispensaryId);
    if (dispensary === null) {
      this.logger.warn(`bank_account.linked for unknown dispensary ${dispensaryId} — ignoring`);
      return;
    }
    if (dispensary.aeropayAccountRef === bankAccountId) return;

    const updated = await this.dispensaries.update(dispensaryId, {
      aeropayAccountRef: bankAccountId,
    });
    if (updated === null) {
      throw new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'dispensary row vanished mid bank-link webhook',
        { dispensaryId },
        500,
      );
    }
  }

  /**
   * A dispensary bank link failed upstream. There is no per-attempt row to
   * flip — the dispensary either has a good `aeropay_account_ref` (from a
   * prior success, which we must not clobber) or none. We log for ops
   * visibility and leave the ref untouched; the portal continues to show
   * "not linked" until a future attempt succeeds.
   */
  applyBankFailed(dispensaryId: string): void {
    this.logger.warn(`bank_account.failed for dispensary ${dispensaryId} — link not established`);
  }
}
