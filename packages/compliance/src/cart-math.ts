/**
 * Cart aggregation for compliance evaluation.
 *
 * Per Minn. Stat. § 342.27, subd. (c), every product type in the catalog
 * rolls into one of three per-transaction caps:
 *
 *   - flower (oz cap): flower, pre-rolls, infused pre-rolls
 *   - concentrate (g cap): concentrates, vape carts
 *   - edibleThc (mg cap): edibles, beverages, tinctures
 *
 * Topicals, accessories, seeds, and clones are exempt from these caps.
 * Cap categorization is centralized in `PRODUCT_CAP` so the rules layer
 * never has to know which product type rolls into which cap.
 *
 * All arithmetic uses Decimal — JS float math is unsafe at the cap
 * boundary (e.g. `0.1 + 0.2` is `0.30000000000000004`, and 56 sums of
 * 0.1 g would silently drift away from 5.6 g). The CLAUDE.md
 * non-negotiable: "never use JavaScript `number` for cannabis weights".
 *
 * Totals are rounded to 3 decimal places — finer than any catalog product
 * potency (typically reported to 1 decimal) and identical to the
 * MN OCM reporting precision.
 */
import { Decimal } from 'decimal.js';
import type { CartLine, CartTotals, ComplianceTotalsSnapshot, ProductType } from './types.js';

const ZERO = new Decimal(0);
const TOTALS_DECIMAL_PLACES = 3;

type CapCategory = 'flower' | 'concentrate' | 'edibleThc' | 'exempt';

const PRODUCT_CAP: Readonly<Record<ProductType, CapCategory>> = {
  flower: 'flower',
  preroll: 'flower',
  infused_preroll: 'flower',
  vape: 'concentrate',
  concentrate: 'concentrate',
  edible: 'edibleThc',
  beverage: 'edibleThc',
  tincture: 'edibleThc',
  topical: 'exempt',
  accessory: 'exempt',
  seed: 'exempt',
  clone: 'exempt',
};

export function computeCartTotals(cart: readonly CartLine[]): CartTotals {
  let flowerGrams = ZERO;
  let concentrateGrams = ZERO;
  let edibleThcMg = ZERO;

  for (const line of cart) {
    const category = PRODUCT_CAP[line.productType];
    switch (category) {
      case 'flower':
        flowerGrams = flowerGrams.plus(line.weightGramsPerUnit.times(line.quantity));
        break;
      case 'concentrate':
        concentrateGrams = concentrateGrams.plus(line.weightGramsPerUnit.times(line.quantity));
        break;
      case 'edibleThc':
        edibleThcMg = edibleThcMg.plus(line.thcMgPerUnit.times(line.quantity));
        break;
      case 'exempt':
        break;
    }
  }

  return {
    flowerGrams: flowerGrams.toDecimalPlaces(TOTALS_DECIMAL_PLACES),
    concentrateGrams: concentrateGrams.toDecimalPlaces(TOTALS_DECIMAL_PLACES),
    edibleThcMg: edibleThcMg.toDecimalPlaces(TOTALS_DECIMAL_PLACES),
  };
}

/**
 * Convert internal Decimal totals into the JSON-serializable shape that
 * gets persisted on `orders.compliance_check_payload`. Downstream readers
 * never re-aggregate, so float64 representation is acceptable; the
 * Decimal-precise values that drove the cap comparisons stay inside the
 * engine.
 */
export function totalsToSnapshot(totals: CartTotals): ComplianceTotalsSnapshot {
  return {
    flowerGrams: totals.flowerGrams.toNumber(),
    concentrateGrams: totals.concentrateGrams.toNumber(),
    edibleThcMg: totals.edibleThcMg.toNumber(),
  };
}
