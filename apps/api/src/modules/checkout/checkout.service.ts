/**
 * Checkout service — owns `POST /v1/carts/:id/checkout`, the single most
 * important transaction in the system.
 *
 * Everything below lives inside one `db.transaction(...)`. If any step
 * throws, every prior write rolls back atomically — there is no partial
 * state to clean up. The transaction's serializable surface (cart row
 * lock + listings row locks) is the primary defense against the
 * "two carts on the same listing both succeed and inventory goes
 * negative" race; the conditional inventory decrement is a defense-in-
 * depth check that surfaces the residual race as `RepositoryError`
 * (since the FOR UPDATE locks should already have prevented it).
 *
 * Step-by-step (numbered for traceability against the Phase 5.3 spec):
 *
 *   1.  Lock the cart row FOR UPDATE under the caller's userId. A cross-
 *       user id matches zero rows → 404. A missing id matches zero rows
 *       → 404. Same shape across both so a probe cannot distinguish
 *       ownership-fail from existence-fail.
 *   2.  Reject expired carts (410 Gone) before doing any further work.
 *       The cleanup worker (Phase 14) hard-deletes carts past
 *       `expires_at`, but a cart that expired between the user's last
 *       cart action and the checkout request reaches us alive but stale.
 *   3.  Reload every entity needed for compliance + pricing inside the
 *       transaction so the snapshot we persist matches what we evaluated.
 *   4.  Cross-user / soft-deleted address → 404 (same shape as the cart
 *       cross-user path).
 *   5.  Empty cart → 422 (an empty checkout is not a valid request; the
 *       client should not have called us).
 *   6.  Hydrate the cart lines (items + listings FOR UPDATE + products)
 *       in three round trips, not N+1. The listings FOR UPDATE pairs
 *       with the cart lock to make inventory consistent across racing
 *       checkouts.
 *   7.  Inventory check per line → InventoryError(409) on any shortfall.
 *       Includes the offending listing ids in `details` so the iOS
 *       client can guide the user to remove or reduce.
 *   8.  Run the compliance evaluator (server is authoritative). On a
 *       failure, throw ComplianceError(422) with the full evaluation
 *       in `details` — the same shape the validate-preview endpoint
 *       returns.
 *   9.  Compute pricing via the pure `computeOrderTotals` engine. The
 *       per-line tax breakdown is captured so `order_items` rows
 *       reconcile to the `orders` header (the `orders_total_matches`
 *       DB CHECK constraint will reject any drift).
 *   10. Generate the human-friendly short code with collision retry.
 *   11. Insert the order row carrying the full compliance snapshot and
 *       a serialized address snapshot. The snapshots are JSONB so a
 *       future address edit or rule-engine version bump does not
 *       retroactively change what this order "looks like" to auditors.
 *   12. Insert the `order_items` rows in bulk, including per-line
 *       compliance totals (THC / CBD / weight) computed via decimal.js
 *       so the books reconcile exactly.
 *   13. Append an immutable `order_events` row of type `order_placed`
 *       (the audit trail can never disagree with current state — the
 *       event log is append-only at the DB level via trigger).
 *   14. Decrement listing inventory per line. The repo's conditional
 *       decrement is race-free; a null return here means the FOR UPDATE
 *       lock failed to serialize (a bug), so we raise RepositoryError.
 *   15. Delete the cart (`cart_items` cascades).
 *   16. Resolve the user's funding source and run the real Aeropay
 *       charge. The payment_method must be `active` and carry an
 *       `aeropay_payment_method_ref` (the upstream bank-account id). A
 *       UUIDv7 for the payment_transactions row is pre-generated so we
 *       can pass it as the Aeropay idempotency key — a network retry of
 *       the same checkout reuses the same key and Aeropay coalesces to
 *       the same payment, avoiding double-charging. The row is then
 *       persisted with `provider_ref = aeropayPayment.id` and the
 *       lifecycle timestamps Aeropay returned (authorizedAt on a
 *       sync-authorized payment, settledAt on the rare sync-settle).
 *       The `payment_transactions_provider_ref_uq` UNIQUE constraint
 *       guards against duplicate persistence of the same Aeropay id.
 *   17. Record balanced double-entry ledger entries for the order
 *       placement: customer account DEBIT and `aeropay_clearing` account
 *       CREDIT, both for the order total. The repo's
 *       `recordTransaction` validates debits=credits before insert; an
 *       imbalance is a programmer error and rolls back the whole txn.
 *
 * Aeropay sync-failure semantics: a `failed` or `canceled` AeropayPayment
 * returned by `createPayment` is surfaced as a `PaymentError` so the
 * entire checkout transaction rolls back — no order, no inventory
 * decrement, no cart deletion. The customer sees a clean retryable
 * error rather than a half-committed state. The webhook handlers in
 * `PaymentMethodsService` handle the much-more-common async failure
 * path where the payment was initially accepted but later failed at
 * the bank (NSF, account closed, etc.).
 */
import { type AeropayPayment, type AeropayPaymentStatus } from '@dankdash/aeropay';
import {
  evaluateCart,
  MN_DEFAULT_TIMEZONE,
  type CartLine,
  type ComplianceEvaluation,
  type DispensaryHours,
  type EvaluationContext,
} from '@dankdash/compliance';
import {
  newId,
  type CartItem,
  type CartItemsRepository,
  type CartsRepository,
  type Database,
  type DispensariesRepository,
  type DispensaryListing,
  type DispensaryListingsRepository,
  type LedgerEntriesRepository,
  type Order,
  type OrderEventsRepository,
  type OrderItem,
  type OrderItemsRepository,
  type OrdersRepository,
  type PaymentMethod,
  type PaymentMethodsRepository,
  type PaymentStatus,
  type PaymentTransaction,
  type PaymentTransactionsRepository,
  type Product,
  type ProductsRepository,
  type User,
  type UserAddress,
  type UserAddressesRepository,
  type UsersRepository,
} from '@dankdash/db';
import { computeOrderTotals, type PricingLine } from '@dankdash/pricing';
import {
  ComplianceError,
  DomainError,
  ExternalServiceError,
  InventoryError,
  NotFoundError,
  PaymentError,
  RepositoryError,
  ValidationError,
} from '@dankdash/types';
import { generateShortCode, withCollisionRetry } from '@dankdash/utils';
import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../payments/tokens.js';
import type {
  CheckoutRequest,
  CheckoutResponse,
  OrderItemResponse,
  OrderResponse,
  PaymentIntentResponse,
} from './dto/index.js';
import type { Polygon } from 'geojson';

export interface CheckoutScopedRepos {
  readonly carts: CartsRepository;
  readonly items: CartItemsRepository;
  readonly listings: DispensaryListingsRepository;
  readonly dispensaries: DispensariesRepository;
  readonly users: UsersRepository;
  readonly userAddresses: UserAddressesRepository;
  readonly products: ProductsRepository;
  readonly orders: OrdersRepository;
  readonly orderItems: OrderItemsRepository;
  readonly orderEvents: OrderEventsRepository;
  readonly paymentTransactions: PaymentTransactionsRepository;
  readonly paymentMethods: PaymentMethodsRepository;
  readonly ledgerEntries: LedgerEntriesRepository;
}

export type CheckoutScopedReposFactory = (db: Database) => CheckoutScopedRepos;

/**
 * Short-code collisions are checked against the live 30-day window. A
 * code that recycled from a 31-day-old delivered order is fine — the
 * customer-facing "your order #3F9A2K" stays unambiguous for the order's
 * lifetime, and the next order with that code shows up well after the
 * receipt is filed.
 */
const SHORT_CODE_COLLISION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: CheckoutScopedReposFactory,
    @Inject(AEROPAY_CLIENT) private readonly aeropay: AeropayClientLike,
    /**
     * Test-only payment bypass (env `PAYMENTS_BYPASS_ENABLED`, default
     * `false`). When on, step 16 skips the real Aeropay charge and the
     * linked-bank-account requirement. Never relaxes compliance.
     */
    private readonly paymentsBypassEnabled: boolean,
  ) {}

  async checkout(userId: string, cartId: string, body: CheckoutRequest): Promise<CheckoutResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);

      // Step 1: lock the cart row FOR UPDATE under the caller's userId.
      const cart = await scoped.carts.findByIdForUserForUpdate(cartId, userId);
      if (cart === null) {
        throw new NotFoundError('Cart', cartId);
      }

      // Step 2: reject expired carts (410 Gone). `ConflictError` with
      // statusCode override would be wrong — Gone has its own semantics.
      // We use the dedicated `CartExpiredError` shape (a ConflictError
      // subclass) so the global filter maps it to 410 via its own code.
      // For Phase 5 we surface this as a `ConflictError('CART_EXPIRED', ...)`
      // and override the statusCode at the throw site; the global filter
      // honours `DomainError.statusCode` directly.
      const now = new Date();
      if (cart.expiresAt.getTime() <= now.getTime()) {
        throw new CartExpiredError(cartId, cart.expiresAt);
      }

      // Step 3 + 4: reload entities. Address scope-check is the same 404
      // shape as cross-user / missing / soft-deleted.
      const address = await scoped.userAddresses.findById(body.deliveryAddressId);
      if (address?.userId !== userId || address.deletedAt !== null) {
        throw new NotFoundError('UserAddress', body.deliveryAddressId);
      }

      const [user, dispensary] = await Promise.all([
        scoped.users.findById(userId),
        scoped.dispensaries.findById(cart.dispensaryId),
      ]);
      if (user === null) {
        // The session principal vanished between auth and checkout. JWT
        // outlived the row — a 500-class invariant violation, not a user
        // error.
        throw new RepositoryError(`user ${userId} not found during checkout`);
      }
      if (dispensary === null) {
        throw new RepositoryError(`dispensary ${cart.dispensaryId} not found during checkout`);
      }

      // Step 5: empty cart guard. Pricing throws on zero lines and the
      // 500 from that would be misleading — surface the actual issue.
      const items = await scoped.items.listForCart(cart.id);
      if (items.length === 0) {
        throw new ValidationError('Cart is empty; cannot checkout an empty cart', {
          cartId,
        });
      }

      // Step 6: hydrate cart lines (items + listings FOR UPDATE + products).
      const hydrated = await this.hydrateLines(scoped, items);

      // Step 7: inventory check. Surface every short line at once so the
      // client can render a useful "these items are out of stock" view
      // rather than playing whack-a-mole.
      const shortages = hydrated.filter(
        (line) => line.listing.quantityAvailable < line.item.quantity,
      );
      if (shortages.length > 0) {
        throw new InventoryError('One or more cart lines have insufficient inventory', {
          shortages: shortages.map((s) => ({
            listingId: s.listing.id,
            requested: s.item.quantity,
            available: s.listing.quantityAvailable,
          })),
        });
      }

      // Step 8: compliance — server-authoritative.
      const evaluation = evaluateCart(
        this.buildEvaluationContext({
          user,
          dispensary,
          address,
          lines: hydrated.map((h) => h.cartLine),
        }),
      );
      if (!evaluation.passed) {
        throw new ComplianceError(
          'COMPLIANCE_EVALUATION_FAILED',
          'Cart fails one or more compliance checks',
          { evaluation: serializeEvaluation(evaluation) },
        );
      }

      // Step 9: pricing. Per-line breakdown survives so order_items rows
      // are exact, then summed into the header.
      const pricing = computeOrderTotals(
        hydrated.map(
          (line): PricingLine => ({
            unitPriceCents: line.item.unitPriceCents,
            quantity: line.item.quantity,
            productType: line.product.productType,
          }),
        ),
        {
          deliveryFeeCents: 0,
          driverTipCents: body.driverTipCents,
          discountCents: 0,
        },
      );

      // Step 10: short code with collision retry. The predicate is
      // bound to the same tx so the existence check sees uncommitted
      // codes from any sibling transaction that committed before us.
      const since = new Date(now.getTime() - SHORT_CODE_COLLISION_WINDOW_MS);
      const shortCode = await withCollisionRetry(generateShortCode, (candidate: string) =>
        scoped.orders.shortCodeExistsSince(candidate, since),
      );

      // Step 11: insert the order. The compliance snapshot and address
      // snapshot are JSONB; the engine output and address row are both
      // plain-JSON-friendly after serialization.
      const order = await scoped.orders.create({
        shortCode,
        userId,
        dispensaryId: cart.dispensaryId,
        deliveryAddressId: address.id,
        status: 'placed',
        statusChangedAt: now,
        subtotalCents: pricing.totals.subtotalCents,
        cannabisTaxCents: pricing.totals.cannabisTaxCents,
        salesTaxCents: pricing.totals.salesTaxCents,
        deliveryFeeCents: pricing.totals.deliveryFeeCents,
        driverTipCents: pricing.totals.driverTipCents,
        discountCents: pricing.totals.discountCents,
        totalCents: pricing.totals.totalCents,
        complianceCheckPayload: serializeEvaluation(evaluation),
        deliveryAddressSnapshot: serializeAddress(address, body.deliveryInstructions),
        placedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Step 12: bulk-insert order_items. The per-line numeric totals
      // are decimal.js strings so the NUMERIC(12,3) columns ingest them
      // losslessly.
      const orderItems = await scoped.orderItems.createMany(
        hydrated.map((line, idx) => {
          const lineResult = pricing.lines[idx];
          if (lineResult === undefined) {
            // The pricing engine returns one result per input line in
            // order. A length mismatch is a programmer error in
            // `computeOrderTotals`, not a user error.
            throw new RepositoryError(
              `pricing.lines[${String(idx)}] missing for order item; check computeOrderTotals`,
            );
          }
          const weightTotal = new Decimal(line.product.weightGramsPerUnit).times(
            line.item.quantity,
          );
          const thcTotal = new Decimal(line.product.thcMgPerUnit).times(line.item.quantity);
          const cbdTotal = new Decimal(line.product.cbdMgPerUnit).times(line.item.quantity);
          return {
            orderId: order.id,
            listingId: line.listing.id,
            productSnapshot: serializeProductSnapshot(line.product, line.listing),
            quantity: line.item.quantity,
            unitPriceCents: line.item.unitPriceCents,
            lineSubtotalCents: lineResult.lineSubtotalCents,
            thcMgTotal: thcTotal.toString(),
            cbdMgTotal: cbdTotal.toString(),
            weightGramsTotal: weightTotal.toString(),
            cannabisTaxCents: lineResult.cannabisTaxCents,
            salesTaxCents: lineResult.salesTaxCents,
            createdAt: now,
          };
        }),
      );

      // Step 13: append the `order_placed` event.
      await scoped.orderEvents.record({
        orderId: order.id,
        eventType: 'order_placed',
        actorUserId: userId,
        actorRole: 'customer',
        payload: {
          subtotalCents: pricing.totals.subtotalCents,
          totalCents: pricing.totals.totalCents,
          itemCount: orderItems.length,
        },
        occurredAt: now,
      });

      // Step 14: decrement inventory per line. The repo's conditional
      // decrement is race-free; a null return here means the FOR UPDATE
      // lock did not serialize (a Postgres / driver bug), so we raise.
      for (const line of hydrated) {
        const decremented = await scoped.listings.decrementInventory(
          line.listing.id,
          line.item.quantity,
        );
        if (decremented === null) {
          throw new RepositoryError(
            `listing ${line.listing.id} inventory decrement failed despite FOR UPDATE lock`,
            { listingId: line.listing.id, quantity: line.item.quantity },
          );
        }
      }

      // Step 15: delete the cart (cart_items cascades).
      await scoped.carts.deleteById(cart.id);

      // Step 16: payment. The normal path resolves the user's funding
      // source and runs the real Aeropay charge (the method must be
      // `active` and carry a linked bank account). The test-only bypass
      // path (env `PAYMENTS_BYPASS_ENABLED`, default OFF) skips both the
      // charge and the linked-method requirement and records a synthetic
      // `bypass` payment so an order still reaches the vendor queue for
      // cross-app flow testing. The payment_transactions id is generated
      // up front so the Aeropay path can pass it as the idempotency key —
      // retries coalesce to the same charge.
      const paymentTransactionId = newId();
      const paymentIntent = this.paymentsBypassEnabled
        ? await this.recordBypassPayment(scoped, {
            paymentTransactionId,
            orderId: order.id,
            amountCents: pricing.totals.totalCents,
            now,
          })
        : await this.recordAeropayPayment(scoped, {
            paymentTransactionId,
            userId,
            body,
            orderId: order.id,
            amountCents: pricing.totals.totalCents,
            now,
          });

      // Step 17: balanced ledger entries. Customer DR + aeropay_clearing
      // CR for the total — both sides equal to `totalCents`, so the
      // recordTransaction balance check passes.
      await scoped.ledgerEntries.recordTransaction([
        {
          orderId: order.id,
          accountType: 'customer',
          accountRef: userId,
          debitCents: pricing.totals.totalCents,
          creditCents: 0,
          description: `Order ${order.shortCode} placed`,
          occurredAt: now,
          createdAt: now,
        },
        {
          orderId: order.id,
          accountType: 'aeropay_clearing',
          accountRef: null,
          debitCents: 0,
          creditCents: pricing.totals.totalCents,
          description: `Order ${order.shortCode} clearing`,
          occurredAt: now,
          createdAt: now,
        },
      ]);

      return {
        order: projectOrder(order, orderItems),
        paymentIntent: projectPaymentIntent(paymentIntent),
        complianceCheck: serializeEvaluation(evaluation),
      };
    });
  }

  /**
   * Hydrates `(item, listing, product)` triples in three round trips
   * (items already in hand, then listings FOR UPDATE, then products).
   * Dangling references are RepositoryError, not user errors — every
   * cart-add path verifies the listing exists and FK constraints
   * guarantee the product is present.
   */
  private async hydrateLines(
    scoped: CheckoutScopedRepos,
    items: readonly CartItem[],
  ): Promise<readonly HydratedLine[]> {
    const listingIds = items.map((it) => it.listingId);
    const listings = await scoped.listings.findManyByIdsForUpdate(listingIds);
    const listingsById = new Map<string, DispensaryListing>(listings.map((l) => [l.id, l]));
    const productIds = listings.map((l) => l.productId);
    const products = productIds.length === 0 ? [] : await scoped.products.findManyByIds(productIds);
    const productsById = new Map<string, Product>(products.map((p) => [p.id, p]));

    return items.map((item) => {
      const listing = listingsById.get(item.listingId);
      if (listing === undefined) {
        throw new RepositoryError(
          `cart item ${item.id} references missing listing ${item.listingId}`,
        );
      }
      const product = productsById.get(listing.productId);
      if (product === undefined) {
        throw new RepositoryError(
          `listing ${listing.id} references missing product ${listing.productId}`,
        );
      }
      const cartLine: CartLine = {
        id: item.id,
        productType: product.productType,
        quantity: item.quantity,
        weightGramsPerUnit: new Decimal(product.weightGramsPerUnit),
        thcMgPerUnit: new Decimal(product.thcMgPerUnit),
        thcMgPerServing:
          product.thcMgPerServing === null ? null : new Decimal(product.thcMgPerServing),
        servingCount: product.servingCount,
      };
      return { item, listing, product, cartLine };
    });
  }

  private buildEvaluationContext(input: {
    readonly user: User;
    readonly dispensary: {
      readonly id: string;
      readonly licenseExpiresAt: string;
      readonly hoursJson: unknown;
      readonly deliveryPolygon: unknown;
    };
    readonly address: UserAddress;
    readonly lines: readonly CartLine[];
  }): EvaluationContext {
    return {
      user: {
        id: input.user.id,
        // Postgres `date` arrives as `YYYY-MM-DD`; `new Date(...)` parses
        // to midnight UTC of that day, which is fine for age comparison
        // (the engine compares at day granularity).
        dateOfBirth: input.user.dateOfBirth === null ? null : new Date(input.user.dateOfBirth),
        kycVerifiedAt: input.user.kycVerifiedAt,
      },
      dispensary: {
        id: input.dispensary.id,
        licenseExpiresAt: new Date(input.dispensary.licenseExpiresAt),
        // `hours_json` is `jsonb` typed as `unknown` from drizzle. The
        // dispensaries admin DTO enforces well-formedness at write time;
        // a malformed payload fails closed in the engine's hours rule.
        hoursJson: input.dispensary.hoursJson as DispensaryHours,
        // GeoJSON polygon — readonly variant in the repo, structurally
        // identical to the engine's Polygon type. The unchecked cast
        // bridges the variance; `pointInPolygon` only reads coordinates.
        deliveryPolygon: input.dispensary.deliveryPolygon as Polygon,
        // Hard-coded for MN: every licensed dispensary is in
        // America/Chicago. When tribal jurisdictions on non-Central
        // zones come online, swap this for a per-dispensary column.
        timezone: MN_DEFAULT_TIMEZONE,
      },
      deliveryLocation: {
        latitude: input.address.location.coordinates[1],
        longitude: input.address.location.coordinates[0],
      },
      cart: input.lines,
    };
  }

  /**
   * Resolve the funding source for this checkout. Returns the full
   * PaymentMethod row (not just the id) so the caller has the Aeropay
   * bank-account ref needed for `createPayment`.
   *
   *   - Caller supplied a `paymentMethodId`: verify it exists, belongs
   *     to the user, is not soft-deleted, is `active`, and carries an
   *     `aeropayPaymentMethodRef`. Cross-user / missing / soft-deleted
   *     surfaces as ValidationError(422) — the iOS client should have
   *     shown only valid methods, so this is a client bug. A method
   *     that is `pending` or `failed` (link still in flight or failed)
   *     surfaces as PaymentError(`PAYMENT_METHOD_INVALID`, 402).
   *   - Not supplied: look up the user's default method and apply the
   *     same active+linked checks. No default → PaymentError
   *     (`PAYMENT_METHOD_INVALID`, 402) — the user has no way to pay.
   */
  private async resolveActiveAeropayMethod(
    scoped: CheckoutScopedRepos,
    userId: string,
    body: CheckoutRequest,
  ): Promise<PaymentMethod & { readonly aeropayPaymentMethodRef: string }> {
    let method: PaymentMethod | null = null;
    if (body.paymentMethodId !== undefined) {
      const candidate = await scoped.paymentMethods.findById(body.paymentMethodId);
      if (candidate?.userId !== userId || candidate.deletedAt !== null) {
        throw new ValidationError(
          'paymentMethodId references a payment method that does not exist for this user',
          { paymentMethodId: body.paymentMethodId },
        );
      }
      method = candidate;
    } else {
      method = await scoped.paymentMethods.findDefaultForUser(userId);
      if (method === null) {
        throw new PaymentError(
          'PAYMENT_METHOD_INVALID',
          'No default payment method on file; link a bank account before checking out',
          { userId },
        );
      }
    }
    if (method.status !== 'active' || method.aeropayPaymentMethodRef === null) {
      throw new PaymentError(
        'PAYMENT_METHOD_INVALID',
        'Payment method is not linked to an active bank account',
        { paymentMethodId: method.id, status: method.status },
      );
    }
    return { ...method, aeropayPaymentMethodRef: method.aeropayPaymentMethodRef };
  }

  /**
   * Run the Aeropay charge for the order. Wraps `createPayment` to map
   * upstream sync failures into `PaymentError` so the surrounding DB
   * transaction rolls back cleanly, and to mask non-domain throws
   * (network errors, response-validation errors) as
   * `ExternalServiceError(502)`.
   *
   * Idempotency: `paymentTransactionId` is the local row id (UUIDv7),
   * pre-generated by the caller. We forward it as Aeropay's
   * idempotency key so a network-retry of the same checkout coalesces
   * to the same upstream payment instead of double-charging.
   */
  private async chargeAeropay(input: {
    readonly paymentTransactionId: string;
    readonly paymentMethod: PaymentMethod & { readonly aeropayPaymentMethodRef: string };
    readonly userId: string;
    readonly orderId: string;
    readonly amountCents: number;
  }): Promise<AeropayPayment> {
    let payment: AeropayPayment;
    try {
      payment = await this.aeropay.createPayment({
        bankAccountId: input.paymentMethod.aeropayPaymentMethodRef,
        amountCents: input.amountCents,
        customerRef: input.userId,
        orderRef: input.orderId,
        idempotencyKey: input.paymentTransactionId,
      });
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new ExternalServiceError(
        'aeropay',
        'Aeropay createPayment call failed',
        { paymentMethodId: input.paymentMethod.id, orderId: input.orderId },
        e,
      );
    }
    if (payment.status === 'failed' || payment.status === 'canceled') {
      throw new PaymentError(
        'PAYMENT_DECLINED',
        `Aeropay declined the payment (status=${payment.status})`,
        {
          paymentMethodId: input.paymentMethod.id,
          orderId: input.orderId,
          aeropayPaymentId: payment.id,
          aeropayStatus: payment.status,
        },
      );
    }
    if (payment.status === 'refunded') {
      // Refunded on creation is impossible per Aeropay's lifecycle; if
      // we see one we treat it as an upstream contract violation.
      throw new ExternalServiceError(
        'aeropay',
        'Aeropay returned an unexpected `refunded` status on createPayment',
        { paymentMethodId: input.paymentMethod.id, aeropayPaymentId: payment.id },
      );
    }
    return payment;
  }

  /**
   * Normal payment path: resolve the user's active, bank-linked Aeropay
   * method, run the real charge, and persist the `payment_transactions`
   * row with the lifecycle timestamps Aeropay returned. Upstream declines
   * surface as PaymentError (via `chargeAeropay`) so the whole checkout
   * transaction rolls back. Extracted from the inline step-16 body so the
   * bypass path can stand beside it without duplicating the ledger step.
   */
  private async recordAeropayPayment(
    scoped: CheckoutScopedRepos,
    input: {
      readonly paymentTransactionId: string;
      readonly userId: string;
      readonly body: CheckoutRequest;
      readonly orderId: string;
      readonly amountCents: number;
      readonly now: Date;
    },
  ): Promise<PaymentTransaction> {
    const paymentMethod = await this.resolveActiveAeropayMethod(scoped, input.userId, input.body);
    const aeropayPayment = await this.chargeAeropay({
      paymentTransactionId: input.paymentTransactionId,
      paymentMethod,
      userId: input.userId,
      orderId: input.orderId,
      amountCents: input.amountCents,
    });
    return scoped.paymentTransactions.create({
      id: input.paymentTransactionId,
      orderId: input.orderId,
      paymentMethodId: paymentMethod.id,
      provider: 'aeropay',
      providerRef: aeropayPayment.id,
      amountCents: input.amountCents,
      status: aeropayPaymentStatusToLocal(aeropayPayment.status),
      initiatedAt: input.now,
      authorizedAt:
        aeropayPayment.status === 'authorized' || aeropayPayment.status === 'settled'
          ? input.now
          : null,
      settledAt: aeropayPayment.status === 'settled' ? input.now : null,
      rawResponse: {
        aeropayPaymentId: aeropayPayment.id,
        aeropayStatus: aeropayPayment.status,
        bankAccountId: aeropayPayment.bankAccountId,
      },
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /**
   * Test-only bypass path (env `PAYMENTS_BYPASS_ENABLED`, default OFF).
   * Records a synthetic `provider: 'bypass'` payment marked `authorized`
   * without contacting Aeropay and without requiring a linked bank
   * account — the bypass exists precisely so a tester with no funding
   * source can place an order. `providerRef` is the (globally-unique)
   * payment_transactions id, which satisfies the `(provider, provider_ref)`
   * UNIQUE constraint and keeps every bypassed row trivially queryable.
   * No payment method is attached (the bypass is not tied to any real
   * funding source) and no settlement webhook will ever arrive for it, so
   * the order keeps only the placement ledger entry written in step 17.
   */
  private async recordBypassPayment(
    scoped: CheckoutScopedRepos,
    input: {
      readonly paymentTransactionId: string;
      readonly orderId: string;
      readonly amountCents: number;
      readonly now: Date;
    },
  ): Promise<PaymentTransaction> {
    return scoped.paymentTransactions.create({
      id: input.paymentTransactionId,
      orderId: input.orderId,
      paymentMethodId: null,
      provider: 'bypass',
      providerRef: input.paymentTransactionId,
      amountCents: input.amountCents,
      status: 'authorized',
      initiatedAt: input.now,
      authorizedAt: input.now,
      settledAt: null,
      rawResponse: {
        bypass: true,
        reason: 'PAYMENTS_BYPASS_ENABLED',
      },
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
}

interface HydratedLine {
  readonly item: CartItem;
  readonly listing: DispensaryListing;
  readonly product: Product;
  readonly cartLine: CartLine;
}

/**
 * Maps `ComplianceEvaluation` (engine output, `Date` + `string` mix) to
 * the wire/JSONB shape with `Date` rendered as ISO 8601 and rules
 * carrying their per-rule details verbatim. The persisted JSONB and the
 * HTTP response body share this exact shape so a future auditor reading
 * `orders.compliance_check_payload` sees the same field set the iOS
 * client originally received.
 */
function serializeEvaluation(
  evaluation: ComplianceEvaluation,
): CheckoutResponse['complianceCheck'] {
  return {
    passed: evaluation.passed,
    rules: evaluation.rules.map((r) => ({
      rule: r.rule,
      passed: r.passed,
      details: r.details,
    })),
    cartTotals: {
      flowerGrams: evaluation.cartTotals.flowerGrams,
      concentrateGrams: evaluation.cartTotals.concentrateGrams,
      edibleThcMg: evaluation.cartTotals.edibleThcMg,
    },
    limits: {
      flowerGramsMax: evaluation.limits.flowerGramsMax,
      concentrateGramsMax: evaluation.limits.concentrateGramsMax,
      edibleThcMgMax: evaluation.limits.edibleThcMgMax,
    },
    evaluatedAt: evaluation.evaluatedAt,
    evaluationVersion: evaluation.evaluationVersion,
  };
}

/**
 * Snapshots the address row at checkout time. The driver app reads from
 * the snapshot — not from `user_addresses` — so a customer editing their
 * address after the order is placed does not retroactively change where
 * the driver is supposed to deliver. `deliveryInstructions` from the
 * request body lives in the snapshot too so the driver sees the
 * customer's per-order note even if the saved address has a different
 * default note.
 */
function serializeAddress(
  address: UserAddress,
  deliveryInstructions: string | undefined,
): Record<string, unknown> {
  return {
    id: address.id,
    label: address.label,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    location: address.location,
    deliveryInstructions: deliveryInstructions ?? address.deliveryInstructions,
  };
}

/**
 * Snapshots the product (and its listing-side price/SKU) for the
 * `order_items.product_snapshot` JSONB. Driver app + receipt rendering
 * read from here, not from `products`, so a future product rename
 * cannot change historic receipts.
 */
function serializeProductSnapshot(
  product: Product,
  listing: DispensaryListing,
): Record<string, unknown> {
  return {
    productId: product.id,
    brand: product.brand,
    name: product.name,
    productType: product.productType,
    strainType: product.strainType,
    weightGramsPerUnit: product.weightGramsPerUnit,
    thcMgPerUnit: product.thcMgPerUnit,
    cbdMgPerUnit: product.cbdMgPerUnit,
    thcMgPerServing: product.thcMgPerServing,
    servingCount: product.servingCount,
    listingId: listing.id,
    sku: listing.sku,
    priceCentsAtCheckout: listing.priceCents,
  };
}

function projectOrder(order: Order, items: readonly OrderItem[]): OrderResponse {
  return {
    id: order.id,
    shortCode: order.shortCode,
    userId: order.userId,
    dispensaryId: order.dispensaryId,
    deliveryAddressId: order.deliveryAddressId,
    status: order.status,
    subtotalCents: order.subtotalCents,
    cannabisTaxCents: order.cannabisTaxCents,
    salesTaxCents: order.salesTaxCents,
    deliveryFeeCents: order.deliveryFeeCents,
    driverTipCents: order.driverTipCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    items: items.map(projectOrderItem),
    placedAt: order.placedAt.toISOString(),
    statusChangedAt: order.statusChangedAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function projectOrderItem(item: OrderItem): OrderItemResponse {
  // `productSnapshot` was inserted as `Record<string, unknown>`; drizzle
  // round-trips it through JSONB. The Zod schema accepts a record; the
  // unknown cast is the narrow boundary between "we know it's a JSON
  // object" and "we don't make claims about its shape".
  return {
    id: item.id,
    listingId: item.listingId,
    productSnapshot: item.productSnapshot as Record<string, unknown>,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    lineSubtotalCents: item.lineSubtotalCents,
    thcMgTotal: item.thcMgTotal,
    cbdMgTotal: item.cbdMgTotal,
    weightGramsTotal: item.weightGramsTotal,
    cannabisTaxCents: item.cannabisTaxCents,
    salesTaxCents: item.salesTaxCents,
    createdAt: item.createdAt.toISOString(),
  };
}

function projectPaymentIntent(intent: PaymentTransaction): PaymentIntentResponse {
  // `provider` is free-form `text` in the DB, but this service only ever
  // writes `'aeropay'` (normal) or `'bypass'` (test-mode) rows in the same
  // transaction it projects from — narrow to the response discriminator.
  const provider = intent.provider === 'bypass' ? 'bypass' : 'aeropay';
  return {
    id: intent.id,
    orderId: intent.orderId,
    provider,
    providerRef: intent.providerRef,
    status: intent.status,
    amountCents: intent.amountCents,
    // Aeropay's bank-account flow does not return a client-secret —
    // the bank account was linked in the prior /v1/payment-methods
    // session, so there is no in-iframe step at checkout. The field
    // stays in the schema (nullable) so a future card-on-file flow
    // that uses an iframe token can populate it without a wire change.
    clientSecret: null,
  };
}

/**
 * Map Aeropay's payment lifecycle status to our local `payment_status`
 * enum. The lifecycles match value-for-value for the states we expect
 * on `createPayment` success (`initiated`, `authorized`, `settled`);
 * `failed` / `canceled` / `refunded` are pre-screened by the caller and
 * never reach this mapper.
 */
function aeropayPaymentStatusToLocal(status: AeropayPaymentStatus): PaymentStatus {
  switch (status) {
    case 'initiated':
      return 'initiated';
    case 'authorized':
      return 'authorized';
    case 'settled':
      return 'settled';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'refunded':
      return 'refunded';
  }
}

/**
 * Specialised error for expired carts. Extends DomainError directly
 * (not ConflictError, whose statusCode is literally typed as 409) so it
 * can surface as HTTP 410 Gone — the semantic for "this resource was
 * here and no longer is". The global filter still recognizes it via the
 * DomainError base.
 */
export class CartExpiredError extends DomainError {
  public readonly code = 'CART_EXPIRED';
  public readonly statusCode = 410;
  constructor(cartId: string, expiresAt: Date) {
    super(`Cart ${cartId} expired at ${expiresAt.toISOString()}`, {
      cartId,
      expiresAt: expiresAt.toISOString(),
    });
  }
}
