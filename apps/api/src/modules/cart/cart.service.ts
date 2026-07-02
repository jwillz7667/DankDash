/**
 * Cart service — owns POST/GET/PATCH/DELETE for `/v1/carts` and its items.
 *
 * Two structural decisions worth flagging up-front:
 *
 *   1. Cart rows are user-owned and NOT under RLS (the migration only
 *      attaches `app_vendor` policies to vendor-side tables). Authorization
 *      is therefore an application-layer scope check on every read/write:
 *      every method that takes a `cartId` pairs it with `userId` from the
 *      JWT in the WHERE clause. Cross-user access surfaces as 404 (not
 *      403) — same response shape for "cart does not exist" and "cart
 *      belongs to someone else" — so a probing call cannot distinguish
 *      the two.
 *
 *   2. The service follows the listings module's ScopedReposFactory
 *      pattern: every multi-statement operation runs inside a tx, and
 *      tx-bound repositories are constructed via an injected factory
 *      rather than mutating singleton fields on the NestJS provider.
 *      Mutating `this.carts = ...` would race under concurrent requests;
 *      the closure-shape keeps each request's repos isolated to its own
 *      tx context and keeps the service unit-testable (production module
 *      passes real constructors; tests pass closures over in-memory
 *      fakes).
 *
 * Compliance/inventory/pricing checks are deliberately NOT on this
 * surface. The cart is a shopping list; the spec's pricing engine and
 * compliance evaluator both run at validate (Phase 5.2) and checkout
 * (Phase 5.3) time, against a snapshot of listings + products + the
 * address, inside the order-creation transaction. Doing them here would
 * either over-fail the user (e.g. "compliance limit exceeded" at
 * cart-add when they intended to remove other items next) or
 * double-charge the engine.
 *
 * What we DO enforce at cart-add:
 *   - The listing exists.
 *   - The listing is active (`is_active = true`). A soft-deleted listing
 *     in a cart would be a permanent 422 at checkout — better to reject
 *     at add-time.
 *   - The listing belongs to the cart's dispensary. Crossing dispensary
 *     boundaries via a stale listingId from another cart is a hard
 *     constraint: the cart is single-dispensary by design.
 *
 * Touch semantics: every successful write extends the cart's 4-hour TTL
 * (recomputed via the JS-side `CART_TTL_MS` so the response carries the
 * fresh `expiresAt` without a second round trip). GET also touches — a
 * customer who opens their cart is signaling active interest, and we
 * would rather over-keep than evict a cart from underneath an active
 * user. The background cleanup worker (Phase 14) hard-deletes carts
 * with `expires_at < NOW()`; until then a stale cart row is logically
 * "still the user's" and any touch reanimates it.
 */
import {
  evaluateCart,
  MN_DEFAULT_TIMEZONE,
  type CartLine,
  type DispensaryHours,
  type EvaluationContext,
} from '@dankdash/compliance';
import {
  type Cart,
  type CartItem,
  type CartItemsRepository,
  type CartsRepository,
  type Database,
  type DispensariesRepository,
  type DispensaryListing,
  type DispensaryListingsRepository,
  type Product,
  type ProductsRepository,
  type PromoCodesRepository,
  type PromoRedemptionsRepository,
  type UserAddressesRepository,
  type UsersRepository,
} from '@dankdash/db';
import {
  evaluatePromo,
  normalizePromoCode,
  type PromoEvaluationContext,
} from '@dankdash/promotions';
import { NotFoundError, PromoError, RepositoryError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { promoErrorForReason, promoRowToDefinition } from '../promotions/promo.mapper.js';
import type {
  AddCartItemRequest,
  CartItemResponse,
  CartResponse,
  CreateCartRequest,
  PatchCartItemRequest,
  ValidateCartResponse,
} from './dto/index.js';
import type { Polygon } from 'geojson';

export interface CartScopedRepos {
  readonly carts: CartsRepository;
  readonly items: CartItemsRepository;
  readonly listings: DispensaryListingsRepository;
  readonly dispensaries: DispensariesRepository;
  readonly users: UsersRepository;
  readonly userAddresses: UserAddressesRepository;
  readonly products: ProductsRepository;
  readonly promoCodes: PromoCodesRepository;
  readonly promoRedemptions: PromoRedemptionsRepository;
}

/**
 * Carts carry no delivery fee — the fee is determined at dispatch and is
 * structurally 0 through checkout today. A `free_delivery` promo therefore
 * previews as a 0 discount here; the value exists so the constant is explicit
 * and moves in one place when delivery fees land.
 */
const CART_DELIVERY_FEE_CENTS = 0;

export type CartScopedReposFactory = (db: Database) => CartScopedRepos;

@Injectable()
export class CartService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: CartScopedReposFactory,
  ) {}

  /**
   * POST /v1/carts. Idempotent per (userId, dispensaryId) via the
   * `carts_user_dispensary_uq` unique index. A second call with the same
   * dispensary returns the same cart row (touched, so its TTL slides
   * forward). Pre-flights the dispensary id so a bogus UUID surfaces as a
   * 422 instead of an FK 500.
   */
  async createOrGet(userId: string, body: CreateCartRequest): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const dispensary = await scoped.dispensaries.findById(body.dispensaryId);
      if (dispensary === null) {
        throw new ValidationError('dispensaryId references a dispensary that does not exist', {
          dispensaryId: body.dispensaryId,
        });
      }
      const cart = await scoped.carts.createOrGetActive(userId, body.dispensaryId);
      const touched = await scoped.carts.touch(cart.id);
      if (touched === null) {
        throw new RepositoryError(
          `cart ${cart.id} disappeared between createOrGetActive and touch`,
        );
      }
      const items = await scoped.items.listForCart(touched.id);
      return this.buildCartResponse(scoped, touched, items);
    });
  }

  /**
   * GET /v1/carts/:id. The find is user-scoped so a cross-user id returns
   * null → 404 (never 403). A read still touches the TTL — the customer
   * is actively engaging with the cart by viewing it, so the 4h timer
   * should reflect activity, not just writes.
   */
  async findForUser(userId: string, cartId: string): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await scoped.carts.findByIdForUser(cartId, userId);
      if (cart === null) {
        throw new NotFoundError('Cart', cartId);
      }
      const touched = await scoped.carts.touch(cart.id);
      if (touched === null) {
        // A concurrent DELETE landed between find and touch. Same 404
        // shape as a missing cart — the caller cannot distinguish.
        throw new NotFoundError('Cart', cartId);
      }
      const items = await scoped.items.listForCart(touched.id);
      return this.buildCartResponse(scoped, touched, items);
    });
  }

  /**
   * POST /v1/carts/:id/items. Pre-flights the listing on three axes:
   * exists, is active, belongs to the cart's dispensary. Then upserts
   * the (cart_id, listing_id) row (incrementing quantity on conflict)
   * with the listing's current `priceCents` snapshotted onto
   * `unit_price_cents`. The snapshot means a subsequent listing price
   * edit does not silently mutate already-carted lines.
   *
   * Inventory is intentionally NOT checked here. Compliance is
   * intentionally NOT checked here. Both run at validate (5.2) and
   * checkout (5.3); doing them at cart-add would either annoy the
   * customer with limits they were about to fix or duplicate work the
   * authoritative pass already covers.
   */
  async addItem(userId: string, cartId: string, body: AddCartItemRequest): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await this.requireCart(scoped, cartId, userId);
      const listing = await scoped.listings.findById(body.listingId);
      if (listing === null) {
        throw new ValidationError('listingId references a listing that does not exist', {
          listingId: body.listingId,
        });
      }
      if (!listing.isActive) {
        throw new ValidationError('listingId references an inactive listing', {
          listingId: body.listingId,
        });
      }
      if (listing.dispensaryId !== cart.dispensaryId) {
        // The cart is single-dispensary by design (unique constraint on
        // `(user_id, dispensary_id)`). A listing from another dispensary
        // cannot legitimately enter this cart. 422 with the offending
        // ids so the client can surface a useful error.
        throw new ValidationError('listingId belongs to a different dispensary than this cart', {
          listingId: body.listingId,
          cartDispensaryId: cart.dispensaryId,
        });
      }
      await scoped.items.addOrIncrement({
        cartId,
        listingId: body.listingId,
        quantity: body.quantity,
        unitPriceCents: listing.priceCents,
      });
      const touched = await scoped.carts.touch(cartId);
      if (touched === null) throw new NotFoundError('Cart', cartId);
      const items = await scoped.items.listForCart(cartId);
      return this.buildCartResponse(scoped, touched, items);
    });
  }

  /**
   * PATCH /v1/carts/:id/items/:itemId. Quantity 0 is accepted at the
   * DTO layer as the caller-friendly "remove" — the service routes it
   * to a delete here so the DB's `quantity > 0` CHECK is never violated.
   * Item-not-in-cart returns 404 (the item id either does not exist or
   * belongs to a different cart — same response shape).
   */
  async patchItem(
    userId: string,
    cartId: string,
    itemId: string,
    body: PatchCartItemRequest,
  ): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await this.requireCart(scoped, cartId, userId);
      const itemsBefore = await scoped.items.listForCart(cart.id);
      if (!itemsBefore.some((row) => row.id === itemId)) {
        throw new NotFoundError('CartItem', itemId);
      }
      await scoped.items.setQuantity(itemId, body.quantity);
      const touched = await scoped.carts.touch(cart.id);
      if (touched === null) throw new NotFoundError('Cart', cartId);
      const items = await scoped.items.listForCart(cart.id);
      return this.buildCartResponse(scoped, touched, items);
    });
  }

  /**
   * DELETE /v1/carts/:id/items/:itemId. Idempotent at the row level —
   * removing a row that is already gone is a no-op — but we still 404
   * if the item is not currently in the cart so the response is
   * meaningful (the client cannot accidentally believe a stale id was
   * removed).
   */
  async removeItem(userId: string, cartId: string, itemId: string): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await this.requireCart(scoped, cartId, userId);
      const itemsBefore = await scoped.items.listForCart(cart.id);
      if (!itemsBefore.some((row) => row.id === itemId)) {
        throw new NotFoundError('CartItem', itemId);
      }
      await scoped.items.remove(itemId);
      const touched = await scoped.carts.touch(cart.id);
      if (touched === null) throw new NotFoundError('Cart', cartId);
      const items = await scoped.items.listForCart(cart.id);
      return this.buildCartResponse(scoped, touched, items);
    });
  }

  /**
   * DELETE /v1/carts/:id. User-scoped delete — the WHERE in the repo
   * pairs id + userId in the same statement so the cross-user path
   * matches zero rows without a separate find. When zero rows match
   * (cross-user, nonexistent, or already-deleted) we surface a 404
   * rather than a 204: the caller never owned the row, and returning
   * success would leak that the id is a valid cart belonging to someone
   * else. The 404 is identical for "not yours" and "never existed", so
   * the response still does not distinguish ownership-fail from
   * existence-fail — the IDOR-safe shape used across the cart surface.
   */
  async delete(userId: string, cartId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const deleted = await scoped.carts.deleteByIdForUser(cartId, userId);
      if (!deleted) {
        throw new NotFoundError('Cart', cartId);
      }
    });
  }

  /**
   * POST /v1/carts/:id/promo. Applies a promo code to the cart and returns the
   * cart with the live discount preview.
   *
   * This is the AUTHORITATIVE apply gate: it runs the full evaluation
   * including the global and per-user redemption caps (counted from
   * `promo_redemptions`), so `PROMO_EXHAUSTED` / `PROMO_ALREADY_USED` surface
   * here. Only a fully valid promo is persisted onto the cart. Checkout
   * re-runs the identical evaluation inside the order transaction (the promo
   * row is re-locked and counts re-read under the lock) — the cart attachment
   * is a convenience, never the source of truth.
   *
   * An unknown code is `PROMO_NOT_FOUND`; every other rejection maps 1:1 from
   * the pure evaluator's reason. Cross-user carts 404 as everywhere else.
   */
  async applyPromo(userId: string, cartId: string, rawCode: string): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await this.requireCart(scoped, cartId, userId);
      const items = await scoped.items.listForCart(cart.id);
      const subtotalCents = sumSubtotalCents(items);

      const code = normalizePromoCode(rawCode);
      const promo = await scoped.promoCodes.findByCode(code);
      if (promo === null) {
        throw new PromoError('PROMO_NOT_FOUND', 'This promo code is not valid', { code });
      }

      const [globalRedemptionCount, userRedemptionCount] = await Promise.all([
        scoped.promoRedemptions.countForPromo(promo.id),
        scoped.promoRedemptions.countForPromoAndUser(promo.id, userId),
      ]);
      const evaluation = evaluatePromo(promoRowToDefinition(promo), {
        subtotalCents,
        deliveryFeeCents: CART_DELIVERY_FEE_CENTS,
        cartDispensaryId: cart.dispensaryId,
        now: new Date(),
        globalRedemptionCount,
        userRedemptionCount,
      });
      if (!evaluation.ok) {
        throw promoErrorForReason(evaluation.reason, { code });
      }

      const updated = await scoped.carts.setPromoCode(cart.id, promo.id);
      if (updated === null) throw new NotFoundError('Cart', cartId);
      return this.buildCartResponse(scoped, updated, items);
    });
  }

  /**
   * DELETE /v1/carts/:id/promo. Removes any applied promo. Idempotent — a cart
   * with no promo returns cleanly with `promoCode: null`. Cross-user 404.
   */
  async removePromo(userId: string, cartId: string): Promise<CartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await this.requireCart(scoped, cartId, userId);
      const updated = await scoped.carts.setPromoCode(cart.id, null);
      if (updated === null) throw new NotFoundError('Cart', cartId);
      const items = await scoped.items.listForCart(cart.id);
      return this.buildCartResponse(scoped, updated, items);
    });
  }

  /**
   * Projects a cart + items to the wire shape, computing the promo discount
   * preview when a promo is attached.
   *
   * The preview is OPTIMISTIC about redemption caps: it applies the active
   * window, scope, and min-subtotal gates and computes the discount, but does
   * NOT re-count redemptions (that would add two aggregate queries to every
   * cart read/mutation). The apply endpoint already enforced the caps when the
   * promo was attached, and checkout enforces them authoritatively; a preview
   * that optimistically shows the discount is the right UX. If the attached
   * promo has since gone inactive/expired, fallen out of window, or the cart
   * dropped below its minimum, the discount previews as 0 while the code stays
   * attached — checkout will reject it and the client can prompt the user.
   */
  private async buildCartResponse(
    scoped: CartScopedRepos,
    cart: Cart,
    items: readonly CartItem[],
  ): Promise<CartResponse> {
    const projectedItems = projectItems(items);
    const subtotalCents = projectedItems.reduce((sum, row) => sum + row.lineSubtotalCents, 0);

    let promoCode: string | null = null;
    let discountCents = 0;
    if (cart.promoCodeId !== null) {
      const promo = await scoped.promoCodes.findById(cart.promoCodeId);
      if (promo !== null) {
        promoCode = promo.code;
        const ctx: PromoEvaluationContext = {
          subtotalCents,
          deliveryFeeCents: CART_DELIVERY_FEE_CENTS,
          cartDispensaryId: cart.dispensaryId,
          now: new Date(),
          // Preview skips the redemption caps — see method doc.
          globalRedemptionCount: 0,
          userRedemptionCount: 0,
        };
        const evaluation = evaluatePromo(promoRowToDefinition(promo), ctx);
        discountCents = evaluation.ok ? evaluation.discountCents : 0;
      }
    }

    return projectCart(cart, projectedItems, subtotalCents, promoCode, discountCents);
  }

  /**
   * POST /v1/carts/:id/validate. Read-only compliance preview.
   *
   * Hydrates everything the @dankdash/compliance engine needs
   * (user identity for age + KYC, dispensary licence + hours + delivery
   * polygon, every cart line projected to {productType, weight, THC,
   * servings}, and the candidate delivery address) and calls
   * `evaluateCart`. The result is the same `ComplianceEvaluation` that
   * checkout (5.3) will snapshot onto `orders.compliance_check_payload`,
   * so the wire shape here IS the audit shape — clients and auditors
   * read the same field set.
   *
   * Three deliberate non-behaviours:
   *
   *   1. No writes. No `touch`, no rate counters, no audit row. The
   *      iOS client calls this on every cart-altering interaction;
   *      mutating state per call would make the cart's last-activity
   *      timestamp meaningless ("you opened the menu" ≠ "you intend
   *      to keep this cart"). The cart's TTL slides forward on real
   *      mutations and on reads through GET /v1/carts/:id; validate
   *      is explicitly excluded from that.
   *
   *   2. No inventory check. The compliance engine speaks to statutes,
   *      not stock levels. Inventory is checked inside the checkout
   *      transaction under `SELECT ... FOR UPDATE` (5.3); doing it here
   *      would race anyway — quantityAvailable can drop between
   *      validate and checkout. The 409 belongs at checkout time.
   *
   *   3. No throw on a compliance failure. The engine returns a
   *      `passed: false` evaluation with detailed `rules[]` and that is
   *      the response body (HTTP 200). The endpoint's job is to tell
   *      the client *why* a checkout would fail, not to error out.
   *      Checkout will throw `ComplianceError` (422) when `passed` is
   *      false; the preview endpoint surfaces the same evaluation as
   *      data.
   *
   * Ownership failures still 404:
   *   - cart id does not belong to the caller → 404 (same shape as
   *     missing).
   *   - deliveryAddressId does not belong to the caller, is soft-
   *     deleted, or never existed → 404 (same shape across all three
   *     paths so a probe cannot distinguish "wrong owner" from
   *     "missing").
   *
   * Data-integrity failures 500:
   *   - The session's user row vanished (JWT outlived the DB row), or
   *   - The cart references a dispensary that no longer exists, or
   *   - A cart item references a listing/product that disappeared.
   *   All three are repository-invariant violations, not user errors.
   */
  async validate(
    userId: string,
    cartId: string,
    deliveryAddressId: string,
  ): Promise<ValidateCartResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.reposFor(tx);
      const cart = await this.requireCart(scoped, cartId, userId);
      const address = await scoped.userAddresses.findById(deliveryAddressId);
      if (address?.userId !== userId || address.deletedAt !== null) {
        // Cross-user / missing / soft-deleted addresses all share the 404
        // shape. The repo's listForUser excludes soft-deleted rows by
        // default — findById does not, so we filter here.
        throw new NotFoundError('UserAddress', deliveryAddressId);
      }
      const [user, dispensary] = await Promise.all([
        scoped.users.findById(userId),
        scoped.dispensaries.findById(cart.dispensaryId),
      ]);
      if (user === null) {
        throw new RepositoryError(`user ${userId} not found during cart validate`);
      }
      if (dispensary === null) {
        throw new RepositoryError(`dispensary ${cart.dispensaryId} not found during cart validate`);
      }
      const items = await scoped.items.listForCart(cart.id);
      const cartLines = await this.hydrateCartLines(scoped, items);
      const ctx: EvaluationContext = {
        user: {
          id: user.id,
          // `dateOfBirth` is a Postgres `date`; drizzle returns it as
          // `YYYY-MM-DD`. `new Date('YYYY-MM-DD')` parses to midnight
          // UTC of that day, which is fine for age comparison — the
          // engine compares against `now` at day granularity.
          dateOfBirth: user.dateOfBirth === null ? null : new Date(user.dateOfBirth),
          kycVerifiedAt: user.kycVerifiedAt,
        },
        dispensary: {
          id: dispensary.id,
          licenseExpiresAt: new Date(dispensary.licenseExpiresAt),
          // `hours_json` is `jsonb` in Postgres — drizzle types it as
          // `unknown`. Admission of well-formed hours into the column
          // is enforced by the dispensaries admin DTO (Phase 3); the
          // engine fails closed on a malformed payload via its
          // sale-hours rule, so the unchecked cast here is safe.
          hoursJson: dispensary.hoursJson as DispensaryHours,
          // GeoJSON Polygon shape. `parsePolygon` in the repo
          // produces a readonly variant of the same structure; the
          // unchecked cast bridges the variance — both sides are
          // structurally `{ type: 'Polygon'; coordinates: number[][][] }`
          // and the engine's `pointInPolygon` only reads coordinates.
          deliveryPolygon: dispensary.deliveryPolygon as unknown as Polygon,
          // Hard-coded for MN: every licensed dispensary is in
          // America/Chicago. When tribal jurisdictions on non-Central
          // zones come online, swap this for a per-dispensary column.
          timezone: MN_DEFAULT_TIMEZONE,
        },
        deliveryLocation: {
          latitude: address.location.coordinates[1],
          longitude: address.location.coordinates[0],
        },
        cart: cartLines,
      };
      return evaluateCart(ctx);
    });
  }

  /**
   * Joins cart items → listings → products to produce the
   * `CartLine[]` the compliance engine consumes. One round trip per
   * table — N items requires three queries total, not N+1. A missing
   * listing or product is a repository-invariant violation (the cart-
   * add path verifies the listing exists and the FK to products is
   * enforced by the schema), so we surface it as a 500 rather than a
   * 422 — the cart should never carry a dangling reference.
   *
   * Decimal conversion: numeric columns come back from postgres-js as
   * strings; the compliance engine wants `Decimal` for exact
   * arithmetic. Constructing `Decimal` from the string preserves
   * precision through to the totals snapshot, which then converts to
   * plain numbers for the JSON response.
   */
  private async hydrateCartLines(
    scoped: CartScopedRepos,
    items: readonly CartItem[],
  ): Promise<readonly CartLine[]> {
    if (items.length === 0) return [];
    const listings = await scoped.listings.findManyByIds(items.map((it) => it.listingId));
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
      return {
        id: item.id,
        productType: product.productType,
        quantity: item.quantity,
        weightGramsPerUnit: new Decimal(product.weightGramsPerUnit),
        thcMgPerUnit: new Decimal(product.thcMgPerUnit),
        thcMgPerServing:
          product.thcMgPerServing === null ? null : new Decimal(product.thcMgPerServing),
        servingCount: product.servingCount,
      } satisfies CartLine;
    });
  }

  private async requireCart(
    scoped: CartScopedRepos,
    cartId: string,
    userId: string,
  ): Promise<Cart> {
    const cart = await scoped.carts.findByIdForUser(cartId, userId);
    if (cart === null) {
      throw new NotFoundError('Cart', cartId);
    }
    return cart;
  }
}

function projectItems(items: readonly CartItem[]): CartItemResponse[] {
  return items.map((row) => ({
    id: row.id,
    listingId: row.listingId,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    lineSubtotalCents: row.unitPriceCents * row.quantity,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function sumSubtotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, row) => sum + row.unitPriceCents * row.quantity, 0);
}

/**
 * Snapshots the cart row + its items into the response shape. The subtotal is
 * a plain `sum(unit_price_cents * quantity)` — no tax, no fees, no compliance.
 * Those belong on the validate/checkout responses which carry the full pricing
 * engine output. `promoCode`/`discountCents` are the applied-promo preview
 * (see {@link CartService.buildCartResponse}); both are absent (null / 0) when
 * no promo is attached.
 *
 * Touched cart's `expiresAt` is `updated_at + CART_TTL_MS` modulo a <1ms write
 * skew — we project the row's persisted `expires_at` rather than recomputing
 * in JS so the customer's countdown UI matches what the cleanup job will use
 * as the deletion predicate.
 */
function projectCart(
  cart: Cart,
  items: readonly CartItemResponse[],
  subtotalCents: number,
  promoCode: string | null,
  discountCents: number,
): CartResponse {
  return {
    id: cart.id,
    userId: cart.userId,
    dispensaryId: cart.dispensaryId,
    items: [...items],
    subtotalCents,
    promoCode,
    discountCents,
    expiresAt: cart.expiresAt.toISOString(),
    createdAt: cart.createdAt.toISOString(),
    updatedAt: cart.updatedAt.toISOString(),
  };
}
