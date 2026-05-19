/**
 * Admin DTOs for product write paths.
 *
 *   POST  /v1/admin/products      — CreateProductRequest
 *   PATCH /v1/admin/products/:id  — PatchProductRequest
 *
 * The DTO mirrors the public ProductResponse shape on the read side but with
 * the internal columns deliberately absent: `searchVector` is populated by a
 * pg trigger, `createdAt` / `updatedAt` / `deletedAt` are managed columns, and
 * `isActive` is exposed only on patch (new products default to active in the
 * DB; admins toggle it later when retiring a SKU without deletion).
 *
 * Compliance-relevant constraints enforced here so a 422 surfaces before the
 * DB CHECK fires a 500:
 *
 *   - Beverages: ≤10 mg THC per serving, ≤2 servings per container
 *     (Minn. Stat. § 342.46 subd. 6 — also a hard check in the schema).
 *   - Numeric weights/potencies are decimal strings to preserve precision
 *     end-to-end; arithmetic in JS would lose digits past 1e-15.
 *
 * Patch is the same field set minus identity-only validation; every field is
 * optional, an empty patch is rejected by the service so the error message can
 * be specific. The schema-level beverage refine fires on patches only when the
 * relevant field combination is present in the same patch — partial patches
 * (just servingCount) cross-check against the persisted row in the service.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { NUMERIC_STRING, ProductTypeSchema, StrainTypeSchema } from '../../dto/index.js';

const BEVERAGE_MAX_MG_PER_SERVING = 10;
const BEVERAGE_MAX_SERVINGS = 2;

const ImageKeys = z.array(z.string().min(1).max(500)).max(20);
const Tags = z.array(z.string().min(1).max(64)).max(20);

const ProductFields = {
  categoryId: z.string().uuid(),
  brand: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  productType: ProductTypeSchema,
  strainType: StrainTypeSchema.nullable().optional(),
  thcMgPerUnit: NUMERIC_STRING,
  cbdMgPerUnit: NUMERIC_STRING.optional(),
  weightGramsPerUnit: NUMERIC_STRING.optional(),
  servingCount: z.number().int().min(1).max(1000).nullable().optional(),
  thcMgPerServing: NUMERIC_STRING.nullable().optional(),
  imageKeys: ImageKeys.optional(),
  effectsTags: Tags.optional(),
  flavorTags: Tags.optional(),
} as const;

/**
 * Beverage CHECK constraints mirrored as a Zod refine so the failure surfaces
 * as a 422 with a specific message rather than a generic DB constraint 500.
 * Returns true on non-beverages and on missing fields (the latter so the
 * patch reuse can defer cross-checking to the service).
 */
function beveragePotencyOk(input: {
  readonly productType?: string | undefined;
  readonly thcMgPerServing?: string | null | undefined;
}): boolean {
  if (input.productType !== 'beverage') return true;
  if (input.thcMgPerServing === null || input.thcMgPerServing === undefined) return true;
  return Number.parseFloat(input.thcMgPerServing) <= BEVERAGE_MAX_MG_PER_SERVING;
}

function beverageServingsOk(input: {
  readonly productType?: string | undefined;
  readonly servingCount?: number | null | undefined;
}): boolean {
  if (input.productType !== 'beverage') return true;
  if (input.servingCount === null || input.servingCount === undefined) return true;
  return input.servingCount <= BEVERAGE_MAX_SERVINGS;
}

export const CreateProductRequestSchema = z
  .object(ProductFields)
  .strict()
  .refine(beveragePotencyOk, {
    message: `Beverages cannot exceed ${BEVERAGE_MAX_MG_PER_SERVING}mg THC per serving`,
    path: ['thcMgPerServing'],
  })
  .refine(beverageServingsOk, {
    message: `Beverages cannot exceed ${BEVERAGE_MAX_SERVINGS} servings per container`,
    path: ['servingCount'],
  });

export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export class CreateProductRequestDto extends createZodDto(CreateProductRequestSchema) {}

/**
 * Patch mirrors create with every field optional plus `isActive` for SKU
 * retirement. `productType` is allowed on patch since changing it does not
 * affect already-placed orders (the order_items snapshot freezes
 * compliance-relevant fields at checkout time).
 */
export const PatchProductRequestSchema = z
  .object({
    categoryId: ProductFields.categoryId.optional(),
    brand: ProductFields.brand.optional(),
    name: ProductFields.name.optional(),
    description: ProductFields.description,
    productType: ProductFields.productType.optional(),
    strainType: ProductFields.strainType,
    thcMgPerUnit: ProductFields.thcMgPerUnit.optional(),
    cbdMgPerUnit: ProductFields.cbdMgPerUnit,
    weightGramsPerUnit: ProductFields.weightGramsPerUnit,
    servingCount: ProductFields.servingCount,
    thcMgPerServing: ProductFields.thcMgPerServing,
    imageKeys: ProductFields.imageKeys,
    effectsTags: ProductFields.effectsTags,
    flavorTags: ProductFields.flavorTags,
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(beveragePotencyOk, {
    message: `Beverages cannot exceed ${BEVERAGE_MAX_MG_PER_SERVING}mg THC per serving`,
    path: ['thcMgPerServing'],
  })
  .refine(beverageServingsOk, {
    message: `Beverages cannot exceed ${BEVERAGE_MAX_SERVINGS} servings per container`,
    path: ['servingCount'],
  });

export type PatchProductRequest = z.infer<typeof PatchProductRequestSchema>;

export class PatchProductRequestDto extends createZodDto(PatchProductRequestSchema) {}

export const BEVERAGE_LIMITS = {
  MAX_MG_PER_SERVING: BEVERAGE_MAX_MG_PER_SERVING,
  MAX_SERVINGS: BEVERAGE_MAX_SERVINGS,
} as const;
