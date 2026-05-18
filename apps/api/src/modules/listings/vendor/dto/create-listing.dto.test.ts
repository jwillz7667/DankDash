/**
 * Unit tests for the vendor listing write DTOs.
 *
 * Create DTO behaviours pinned:
 *   - Required fields present → parses cleanly; optional fields are
 *     undefined when absent so the spread in the service can omit them.
 *   - `.strict()` rejects unknown top-level fields — including
 *     `dispensaryId`, which would imply the caller is trying to write
 *     into another dispensary's row (the service takes dispensaryId
 *     from the verified header, not the body).
 *   - `priceCents` and `compareAtPriceCents` are integer cents with
 *     positive lower bound and a $1,000,000 upper bound.
 *   - `compareAtPriceCents > priceCents` enforced via cross-field refine.
 *   - `metrcPackageTag` matches the Metrc canonical format when present.
 *
 * Patch DTO behaviours pinned:
 *   - All fields optional; `productId` removed (immutable on patch).
 *   - `.strict()` rejects unknown top-level fields including `productId`.
 *   - `compareAtPriceCents > priceCents` refine fires when both appear.
 *   - Partial patches with only one side defer to the service for the
 *     cross-row check.
 *   - `isActive: false` accepted as a reactivation/deactivation toggle.
 */
import { describe, expect, it } from 'vitest';
import { CreateListingRequestSchema, PatchListingRequestSchema } from './create-listing.dto.js';

const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000001';
const VALID_METRC = '1A4060300002F62000000045';

function makeCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: PRODUCT_ID,
    sku: 'NS-PE-3.5G',
    priceCents: 4500,
    ...overrides,
  };
}

describe('CreateListingRequestSchema', () => {
  it('parses a minimal valid create body, leaves optionals undefined', () => {
    const parsed = CreateListingRequestSchema.parse(makeCreateBody());

    expect(parsed.productId).toBe(PRODUCT_ID);
    expect(parsed.sku).toBe('NS-PE-3.5G');
    expect(parsed.priceCents).toBe(4500);
    expect(parsed.compareAtPriceCents).toBeUndefined();
    expect(parsed.quantityAvailable).toBeUndefined();
    expect(parsed.metrcPackageTag).toBeUndefined();
  });

  it('accepts every optional field', () => {
    const parsed = CreateListingRequestSchema.parse(
      makeCreateBody({
        compareAtPriceCents: 5500,
        quantityAvailable: 12,
        metrcPackageTag: VALID_METRC,
      }),
    );

    expect(parsed.compareAtPriceCents).toBe(5500);
    expect(parsed.quantityAvailable).toBe(12);
    expect(parsed.metrcPackageTag).toBe(VALID_METRC);
  });

  it('accepts explicit-null nullable fields (compareAt, metrcPackageTag)', () => {
    const parsed = CreateListingRequestSchema.parse(
      makeCreateBody({ compareAtPriceCents: null, metrcPackageTag: null }),
    );

    expect(parsed.compareAtPriceCents).toBeNull();
    expect(parsed.metrcPackageTag).toBeNull();
  });

  it('rejects unknown top-level fields including dispensaryId (taken from header, not body)', () => {
    expect(() =>
      CreateListingRequestSchema.parse(
        makeCreateBody({ dispensaryId: '01935f3d-0000-7000-8000-000000000099' }),
      ),
    ).toThrow();
    expect(() => CreateListingRequestSchema.parse(makeCreateBody({ isActive: true }))).toThrow();
  });

  it('rejects a non-uuid productId', () => {
    expect(() =>
      CreateListingRequestSchema.parse(makeCreateBody({ productId: 'not-a-uuid' })),
    ).toThrow();
  });

  it('rejects priceCents at or below zero', () => {
    expect(() => CreateListingRequestSchema.parse(makeCreateBody({ priceCents: 0 }))).toThrow();
    expect(() => CreateListingRequestSchema.parse(makeCreateBody({ priceCents: -100 }))).toThrow();
  });

  it('rejects priceCents that is not an integer', () => {
    expect(() => CreateListingRequestSchema.parse(makeCreateBody({ priceCents: 12.5 }))).toThrow();
  });

  it('rejects priceCents over the $1M cap', () => {
    expect(() =>
      CreateListingRequestSchema.parse(makeCreateBody({ priceCents: 1_000_000_01 })),
    ).toThrow();
  });

  it('rejects compareAtPriceCents not strictly greater than priceCents', () => {
    expect(() =>
      CreateListingRequestSchema.parse(
        makeCreateBody({ priceCents: 4500, compareAtPriceCents: 4500 }),
      ),
    ).toThrow();
    expect(() =>
      CreateListingRequestSchema.parse(
        makeCreateBody({ priceCents: 4500, compareAtPriceCents: 4000 }),
      ),
    ).toThrow();
  });

  it('accepts compareAtPriceCents strictly greater than priceCents', () => {
    const parsed = CreateListingRequestSchema.parse(
      makeCreateBody({ priceCents: 4500, compareAtPriceCents: 4501 }),
    );
    expect(parsed.compareAtPriceCents).toBe(4501);
  });

  it('rejects sku longer than 120 chars', () => {
    expect(() =>
      CreateListingRequestSchema.parse(makeCreateBody({ sku: 'X'.repeat(121) })),
    ).toThrow();
  });

  it('rejects empty sku', () => {
    expect(() => CreateListingRequestSchema.parse(makeCreateBody({ sku: '' }))).toThrow();
  });

  it('rejects malformed metrcPackageTag', () => {
    expect(() =>
      CreateListingRequestSchema.parse(makeCreateBody({ metrcPackageTag: 'totally-bogus' })),
    ).toThrow();
    // Missing leading "1" facility marker.
    expect(() =>
      CreateListingRequestSchema.parse(
        makeCreateBody({ metrcPackageTag: '2A4060300002F62000000045' }),
      ),
    ).toThrow();
  });

  it('rejects negative quantityAvailable', () => {
    expect(() =>
      CreateListingRequestSchema.parse(makeCreateBody({ quantityAvailable: -1 })),
    ).toThrow();
  });

  it('accepts quantityAvailable of 0 (out of stock)', () => {
    const parsed = CreateListingRequestSchema.parse(makeCreateBody({ quantityAvailable: 0 }));
    expect(parsed.quantityAvailable).toBe(0);
  });
});

describe('PatchListingRequestSchema', () => {
  it('accepts an empty object at the schema layer (service rejects)', () => {
    expect(PatchListingRequestSchema.parse({})).toEqual({});
  });

  it('accepts a single-field patch', () => {
    const parsed = PatchListingRequestSchema.parse({ priceCents: 5000 });
    expect(parsed.priceCents).toBe(5000);
    expect(parsed.sku).toBeUndefined();
  });

  it('accepts isActive toggle for reactivation', () => {
    expect(PatchListingRequestSchema.parse({ isActive: true })).toEqual({ isActive: true });
    expect(PatchListingRequestSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it('rejects unknown top-level fields including productId (immutable on patch)', () => {
    expect(() => PatchListingRequestSchema.parse({ productId: PRODUCT_ID })).toThrow();
    expect(() =>
      PatchListingRequestSchema.parse({
        dispensaryId: '01935f3d-0000-7000-8000-000000000099',
      }),
    ).toThrow();
    expect(() => PatchListingRequestSchema.parse({ nonsense: true })).toThrow();
  });

  it('rejects compareAtPriceCents <= priceCents when both are present', () => {
    expect(() =>
      PatchListingRequestSchema.parse({ priceCents: 4500, compareAtPriceCents: 4500 }),
    ).toThrow();
  });

  it('defers compareAt check when only one side is in the patch (service cross-checks)', () => {
    expect(() => PatchListingRequestSchema.parse({ compareAtPriceCents: 100 })).not.toThrow();
    expect(() => PatchListingRequestSchema.parse({ priceCents: 9000 })).not.toThrow();
  });

  it('accepts explicit-null compareAtPriceCents (clear the strike price)', () => {
    expect(PatchListingRequestSchema.parse({ compareAtPriceCents: null })).toEqual({
      compareAtPriceCents: null,
    });
  });

  it('accepts explicit-null metrcPackageTag (clear the tag)', () => {
    expect(PatchListingRequestSchema.parse({ metrcPackageTag: null })).toEqual({
      metrcPackageTag: null,
    });
  });

  it('rejects malformed metrcPackageTag on patch', () => {
    expect(() => PatchListingRequestSchema.parse({ metrcPackageTag: 'X' })).toThrow();
  });
});
