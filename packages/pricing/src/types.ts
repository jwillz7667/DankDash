/**
 * Pricing inputs and outputs. Every monetary value is an integer cent
 * count — floats are forbidden in this package's public surface because
 * the order-totals CHECK constraint in the DB compares cent-level
 * equality and a half-cent rounding error elsewhere would break the
 * whole checkout transaction.
 *
 * Per-line tax fields exist on the result because `order_items` carries
 * `cannabis_tax_cents` and `sales_tax_cents` per row; the order header
 * is just the sum. Computing per-line first and summing keeps both
 * representations consistent (no "where did the rounding go" between
 * the items and the header).
 */
import type { ProductType } from '@dankdash/compliance';

export interface PricingLine {
  /** Listing price per unit at the moment of pricing, in integer cents. */
  readonly unitPriceCents: number;
  /** Positive integer quantity. */
  readonly quantity: number;
  /** Drives cannabis-tax applicability via `isCannabisTaxable`. */
  readonly productType: ProductType;
}

export interface PricingLineResult {
  readonly lineSubtotalCents: number;
  readonly cannabisTaxCents: number;
  readonly salesTaxCents: number;
}

export interface PricingOptions {
  readonly deliveryFeeCents: number;
  /** Tip to the driver. Pass-through; not taxed. */
  readonly driverTipCents: number;
  /** Promotional discount applied off the post-tax total. Capped at subtotal. */
  readonly discountCents: number;
  /**
   * Municipality-specific add-on to the 6.875% state sales tax, as a
   * decimal fraction (e.g. `0.005` for a 0.5% Minneapolis surcharge).
   * Omitted or `0` means no local add-on.
   */
  readonly localSalesTaxRate?: number;
}

export interface OrderPricingTotals {
  readonly subtotalCents: number;
  readonly cannabisTaxCents: number;
  readonly salesTaxCents: number;
  readonly deliveryFeeCents: number;
  readonly driverTipCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

export interface PricingResult {
  readonly lines: readonly PricingLineResult[];
  readonly totals: OrderPricingTotals;
}
