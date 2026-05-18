/**
 * Order totals computation.
 *
 * Math model — applied per line, then summed for the order header so the
 * `orders` row and its `order_items` reconcile exactly:
 *
 *   line_subtotal     = unit_price * quantity                     (integer cents)
 *   cannabis_tax      = round(line_subtotal * 0.10)               iff taxable
 *   sales_tax_base    = line_subtotal + cannabis_tax              ← critical
 *   sales_tax         = round(sales_tax_base * (0.06875 + local))
 *
 * Why sales tax includes the cannabis tax in its base: per MN DOR Sales
 * Tax Fact Sheet 144 (Cannabis Products), "The sales price of taxable
 * cannabis products subject to sales tax includes the Cannabis Tax." So
 * the 6.875% is applied to subtotal-plus-excise, not just to subtotal.
 * Getting this wrong understates collected sales tax by ~0.7% of every
 * cannabis order — a real audit finding.
 *
 * Rounding: banker's rounding (round-half-to-even, `ROUND_HALF_EVEN`).
 * On a million half-cent ties this is unbiased; `Math.round` would
 * bias the entire books toward over-collection. Decimal.js exposes
 * this directly so the rule is enforced by the library, not by us.
 *
 * Validation: integer cents in, integer cents out. Any non-integer or
 * negative input throws `RangeError` — a callsite that hands us
 * `4500.5` cents is broken and there is no safe coercion. Callers
 * (cart service, checkout service) already work in integer cents so
 * this only fires on programmer error or a corrupt persistence layer.
 */
import { Decimal } from 'decimal.js';
import { CANNABIS_TAX_RATE, STATE_SALES_TAX_RATE, isCannabisTaxable } from './constants.js';
import type {
  OrderPricingTotals,
  PricingLine,
  PricingLineResult,
  PricingOptions,
  PricingResult,
} from './types.js';

const CANNABIS_RATE = new Decimal(CANNABIS_TAX_RATE);
const STATE_SALES_RATE = new Decimal(STATE_SALES_TAX_RATE);

function requireNonNegativeInt(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`pricing: ${label} must be a non-negative integer (got ${String(value)})`);
  }
}

function requirePositiveInt(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`pricing: ${label} must be a positive integer (got ${String(value)})`);
  }
}

function bankerRoundToInt(d: Decimal): number {
  // Decimal.ROUND_HALF_EVEN === 6 — banker's rounding.
  return d.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

export function computeOrderTotals(
  lines: readonly PricingLine[],
  options: PricingOptions,
): PricingResult {
  if (lines.length === 0) {
    throw new RangeError('pricing: lines must contain at least one entry');
  }
  requireNonNegativeInt(options.deliveryFeeCents, 'deliveryFeeCents');
  requireNonNegativeInt(options.driverTipCents, 'driverTipCents');
  requireNonNegativeInt(options.discountCents, 'discountCents');

  const localRate = options.localSalesTaxRate ?? 0;
  if (!Number.isFinite(localRate) || localRate < 0) {
    throw new RangeError(
      `pricing: localSalesTaxRate must be a non-negative finite number (got ${String(localRate)})`,
    );
  }
  const salesRate = STATE_SALES_RATE.plus(new Decimal(localRate));

  const lineResults: PricingLineResult[] = [];
  let subtotalCents = 0;
  let cannabisTaxCents = 0;
  let salesTaxCents = 0;

  let i = 0;
  for (const line of lines) {
    requireNonNegativeInt(line.unitPriceCents, `line[${String(i)}].unitPriceCents`);
    requirePositiveInt(line.quantity, `line[${String(i)}].quantity`);
    i += 1;

    const lineSubtotal = line.unitPriceCents * line.quantity;
    // Multiplying two safe-integer cents counts; the catalog admission
    // caps unit price at 100_000_000 cents and quantity at 999 so the
    // product is well under Number.MAX_SAFE_INTEGER (2^53-1).
    const subDecimal = new Decimal(lineSubtotal);

    const lineCannabisTax = isCannabisTaxable(line.productType)
      ? bankerRoundToInt(subDecimal.times(CANNABIS_RATE))
      : 0;

    const salesTaxBase = subDecimal.plus(new Decimal(lineCannabisTax));
    const lineSalesTax = bankerRoundToInt(salesTaxBase.times(salesRate));

    lineResults.push({
      lineSubtotalCents: lineSubtotal,
      cannabisTaxCents: lineCannabisTax,
      salesTaxCents: lineSalesTax,
    });

    subtotalCents += lineSubtotal;
    cannabisTaxCents += lineCannabisTax;
    salesTaxCents += lineSalesTax;
  }

  if (options.discountCents > subtotalCents) {
    throw new RangeError(
      `pricing: discountCents (${String(options.discountCents)}) exceeds subtotal (${String(subtotalCents)})`,
    );
  }

  const totalCents =
    subtotalCents +
    cannabisTaxCents +
    salesTaxCents +
    options.deliveryFeeCents +
    options.driverTipCents -
    options.discountCents;

  const totals: OrderPricingTotals = {
    subtotalCents,
    cannabisTaxCents,
    salesTaxCents,
    deliveryFeeCents: options.deliveryFeeCents,
    driverTipCents: options.driverTipCents,
    discountCents: options.discountCents,
    totalCents,
  };

  return { lines: lineResults, totals };
}
