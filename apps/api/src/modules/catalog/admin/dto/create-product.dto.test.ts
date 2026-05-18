/**
 * Unit tests for admin product write DTOs.
 *
 * Create DTO behaviours pinned:
 *   - All required fields present → parses cleanly.
 *   - .strict() — unknown top-level fields rejected.
 *   - Numeric fields are decimal strings (precision preservation).
 *   - Beverage CHECK constraints mirrored at the schema with specific
 *     messages so the API surfaces 422 instead of falling through to a
 *     DB CHECK 500.
 *   - imageKeys / effectsTags / flavorTags arrays bounded.
 *
 * Patch DTO behaviours pinned:
 *   - All fields optional.
 *   - .strict() — unknown top-level fields rejected.
 *   - Beverage refines fire only when the relevant fields appear in the
 *     same patch; partial patches defer to the service.
 *   - isActive toggle accepted.
 */
import { describe, expect, it } from 'vitest';
import {
  BEVERAGE_LIMITS,
  CreateProductRequestSchema,
  PatchProductRequestSchema,
} from './create-product.dto.js';

function makeCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categoryId: '01935f3d-0000-7000-8000-000000000001',
    brand: 'North Star',
    name: 'Pineapple Express 3.5g',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    weightGramsPerUnit: '3.500',
    ...overrides,
  };
}

describe('CreateProductRequestSchema', () => {
  it('parses a minimal valid create body', () => {
    const parsed = CreateProductRequestSchema.parse(makeCreateBody());
    expect(parsed.brand).toBe('North Star');
    expect(parsed.thcMgPerUnit).toBe('875.000');
    expect(parsed.cbdMgPerUnit).toBeUndefined();
    expect(parsed.imageKeys).toBeUndefined();
  });

  it('accepts optional fields', () => {
    const parsed = CreateProductRequestSchema.parse(
      makeCreateBody({
        description: 'A sativa-dominant strain.',
        cbdMgPerUnit: '12.000',
        servingCount: 1,
        thcMgPerServing: '875.000',
        imageKeys: ['products/pe1.jpg', 'products/pe2.jpg'],
        effectsTags: ['energetic', 'creative'],
        flavorTags: ['pineapple', 'citrus'],
      }),
    );
    expect(parsed.imageKeys).toEqual(['products/pe1.jpg', 'products/pe2.jpg']);
    expect(parsed.effectsTags).toEqual(['energetic', 'creative']);
  });

  it('rejects unknown top-level fields (typo guard via .strict)', () => {
    expect(() => CreateProductRequestSchema.parse(makeCreateBody({ isActive: true }))).toThrow();
  });

  it('rejects missing required field (thcMgPerUnit)', () => {
    const body = makeCreateBody();
    delete body['thcMgPerUnit'];
    expect(() => CreateProductRequestSchema.parse(body)).toThrow();
  });

  it('rejects a non-uuid categoryId', () => {
    expect(() =>
      CreateProductRequestSchema.parse(makeCreateBody({ categoryId: 'not-a-uuid' })),
    ).toThrow();
  });

  it('rejects a non-numeric thcMgPerUnit', () => {
    expect(() =>
      CreateProductRequestSchema.parse(makeCreateBody({ thcMgPerUnit: 'abc' })),
    ).toThrow();
  });

  it('rejects an unknown productType enum value', () => {
    expect(() =>
      CreateProductRequestSchema.parse(makeCreateBody({ productType: 'gummies' })),
    ).toThrow();
  });

  it('rejects an unknown strainType enum value', () => {
    expect(() =>
      CreateProductRequestSchema.parse(makeCreateBody({ strainType: 'super-sativa' })),
    ).toThrow();
  });

  it('rejects a beverage exceeding the per-serving THC cap', () => {
    expect(() =>
      CreateProductRequestSchema.parse(
        makeCreateBody({
          productType: 'beverage',
          servingCount: 2,
          thcMgPerServing: String(BEVERAGE_LIMITS.MAX_MG_PER_SERVING + 1),
          thcMgPerUnit: '20.000',
        }),
      ),
    ).toThrow();
  });

  it('rejects a beverage exceeding the servings-per-container cap', () => {
    expect(() =>
      CreateProductRequestSchema.parse(
        makeCreateBody({
          productType: 'beverage',
          servingCount: BEVERAGE_LIMITS.MAX_SERVINGS + 1,
          thcMgPerServing: '10.000',
          thcMgPerUnit: '30.000',
        }),
      ),
    ).toThrow();
  });

  it('accepts a beverage at the cap (≤10mg/serving, ≤2 servings)', () => {
    const parsed = CreateProductRequestSchema.parse(
      makeCreateBody({
        productType: 'beverage',
        servingCount: BEVERAGE_LIMITS.MAX_SERVINGS,
        thcMgPerServing: String(BEVERAGE_LIMITS.MAX_MG_PER_SERVING),
        thcMgPerUnit: '20.000',
      }),
    );
    expect(parsed.servingCount).toBe(BEVERAGE_LIMITS.MAX_SERVINGS);
  });

  it('does not apply the beverage cap to non-beverage product types', () => {
    const parsed = CreateProductRequestSchema.parse(
      makeCreateBody({
        productType: 'edible',
        servingCount: 10,
        thcMgPerServing: '50.000',
      }),
    );
    expect(parsed.productType).toBe('edible');
  });

  it('rejects imageKeys over the array length cap', () => {
    expect(() =>
      CreateProductRequestSchema.parse(
        makeCreateBody({ imageKeys: Array.from({ length: 21 }, (_, i) => `img${String(i)}.jpg`) }),
      ),
    ).toThrow();
  });
});

describe('PatchProductRequestSchema', () => {
  it('accepts an empty object at the schema layer (service rejects)', () => {
    expect(PatchProductRequestSchema.parse({})).toEqual({});
  });

  it('accepts a single field patch', () => {
    const parsed = PatchProductRequestSchema.parse({ brand: 'New Brand' });
    expect(parsed.brand).toBe('New Brand');
    expect(parsed.name).toBeUndefined();
  });

  it('accepts isActive toggle for SKU retirement', () => {
    expect(PatchProductRequestSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it('rejects unknown top-level fields (typo guard via .strict)', () => {
    expect(() => PatchProductRequestSchema.parse({ nonsense: true })).toThrow();
  });

  it('rejects a beverage cap violation when both relevant fields are in the patch', () => {
    expect(() =>
      PatchProductRequestSchema.parse({
        productType: 'beverage',
        thcMgPerServing: String(BEVERAGE_LIMITS.MAX_MG_PER_SERVING + 1),
      }),
    ).toThrow();
  });

  it('defers cap enforcement when only one of {productType, servingCount} is in the patch', () => {
    // Just `servingCount: 5` with no productType — schema can't decide if this is a beverage.
    expect(() => PatchProductRequestSchema.parse({ servingCount: 5 })).not.toThrow();
  });

  it('accepts explicit-null nullable fields (description, strainType, etc)', () => {
    const parsed = PatchProductRequestSchema.parse({
      description: null,
      strainType: null,
      servingCount: null,
      thcMgPerServing: null,
    });
    expect(parsed.description).toBeNull();
    expect(parsed.strainType).toBeNull();
    expect(parsed.servingCount).toBeNull();
  });
});
