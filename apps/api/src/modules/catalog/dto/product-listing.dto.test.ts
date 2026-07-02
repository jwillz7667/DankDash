/**
 * Unit tests for the product-listings DTOs.
 *
 * The contract protects the consumer app's "resolve a listing before
 * add-to-cart" path from silent drift:
 *
 *   - query limit/offset coerce from strings (Fastify hands them in as
 *     strings) and default to 24 / 0;
 *   - limit is clamped to 1..50 and offset to >=0;
 *   - the row shape is strict, so a future migration cannot leak an internal
 *     listing column, and prices must be positive.
 */
import { describe, expect, it } from 'vitest';
import {
  ProductListingResultSchema,
  ProductListingsQuerySchema,
  ProductListingsResponseSchema,
} from './product-listing.dto.js';

const VALID_UUID_A = '01935f3d-0000-7000-8000-0000000000c1';
const VALID_UUID_B = '01935f3d-0000-7000-8000-000000000fa1';

describe('ProductListingsQuerySchema', () => {
  it('defaults limit=24, offset=0 for an empty query', () => {
    expect(ProductListingsQuerySchema.parse({})).toEqual({ limit: 24, offset: 0 });
  });

  it('coerces numeric strings for limit and offset', () => {
    const parsed = ProductListingsQuerySchema.parse({ limit: '10', offset: '40' });
    expect(parsed).toEqual({ limit: 10, offset: 40 });
  });

  it('rejects limit above 50 and below 1', () => {
    expect(() => ProductListingsQuerySchema.parse({ limit: '51' })).toThrow();
    expect(() => ProductListingsQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('rejects a negative offset', () => {
    expect(() => ProductListingsQuerySchema.parse({ offset: '-1' })).toThrow();
  });

  it('rejects unknown query keys (strict)', () => {
    expect(() => ProductListingsQuerySchema.parse({ dispensary_id: VALID_UUID_A })).toThrow();
  });
});

describe('ProductListingResultSchema', () => {
  it('accepts a well-formed row with a nullable compareAtPriceCents', () => {
    const row = {
      listingId: VALID_UUID_A,
      dispensaryId: VALID_UUID_B,
      dispensaryName: 'The Grove',
      sku: 'SS-ST-35',
      priceCents: 4500,
      compareAtPriceCents: null,
      quantityAvailable: 7,
    };
    expect(ProductListingResultSchema.parse(row)).toEqual(row);
  });

  it('rejects a non-positive price', () => {
    expect(() =>
      ProductListingResultSchema.parse({
        listingId: VALID_UUID_A,
        dispensaryId: VALID_UUID_B,
        dispensaryName: 'The Grove',
        sku: 'SS-ST-35',
        priceCents: 0,
        compareAtPriceCents: null,
        quantityAvailable: 7,
      }),
    ).toThrow();
  });

  it('rejects extra keys (strict) so an internal listing column cannot leak', () => {
    expect(() =>
      ProductListingResultSchema.parse({
        listingId: VALID_UUID_A,
        dispensaryId: VALID_UUID_B,
        dispensaryName: 'The Grove',
        sku: 'SS-ST-35',
        priceCents: 4500,
        compareAtPriceCents: null,
        quantityAvailable: 7,
        isActive: true,
      }),
    ).toThrow();
  });
});

describe('ProductListingsResponseSchema', () => {
  it('accepts an empty listing page (live-but-uncarried product)', () => {
    const body = { listings: [], page: { limit: 24, offset: 0, total: 0 } };
    expect(ProductListingsResponseSchema.parse(body)).toEqual(body);
  });
});
