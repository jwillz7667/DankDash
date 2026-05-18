/**
 * Product detail DTOs.
 *
 *   GET /v1/products/:id — single product detail with the latest lab
 *                          results (COAs). Returned only for products
 *                          that are active and not soft-deleted; misses
 *                          and tombstones both surface as 404.
 *
 * Notes on the projection:
 *
 *   - Numeric cannabis weights/THC values flow as strings to preserve
 *     Decimal precision end-to-end. The iOS client parses them with a
 *     decimal library; never as JS `number`.
 *   - `imageKeys` are raw R2 object keys. The client composes the CDN
 *     URL with its build-time `CDN_BASE_URL`; image URL fabrication on
 *     the server lands with the upload pipeline in Phase 4.6.
 *   - `searchVector`, `isActive`, and `deletedAt` are absent — they are
 *     internal columns. A response that surfaces tsvector text or a
 *     soft-delete marker leaks implementation details to the client.
 *   - Lab results are sorted newest-first so the iOS detail screen can
 *     pluck `labResults[0]` for the headline COA without re-sorting.
 */
import { z } from 'zod';

/**
 * Decimal numeric strings — exported because every catalog/menu DTO that
 * surfaces a money or cannabis-weight field uses the same shape. Keeping a
 * single regex avoids the drift-by-copy bug where one DTO permits a leading
 * `+` and another doesn't.
 */
export const NUMERIC_STRING = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/u, 'must be a decimal numeric string');

export const ProductTypeSchema = z.enum([
  'flower',
  'preroll',
  'infused_preroll',
  'vape',
  'edible',
  'beverage',
  'concentrate',
  'tincture',
  'topical',
  'accessory',
  'seed',
  'clone',
]);
export type ProductTypeDto = z.infer<typeof ProductTypeSchema>;

export const StrainTypeSchema = z.enum(['indica', 'sativa', 'hybrid', 'cbd', 'balanced']);
export type StrainTypeDto = z.infer<typeof StrainTypeSchema>;

export const LabResultResponseSchema = z
  .object({
    id: z.string().uuid(),
    batchId: z.string(),
    labName: z.string(),
    coaDocumentKey: z.string().nullable(),
    potencyThc: NUMERIC_STRING.nullable(),
    potencyCbd: NUMERIC_STRING.nullable(),
    contaminantsPassed: z.boolean().nullable(),
    testedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be a YYYY-MM-DD date'),
  })
  .strict();

export type LabResultResponse = z.infer<typeof LabResultResponseSchema>;

export const ProductResponseSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    brand: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    productType: ProductTypeSchema,
    strainType: StrainTypeSchema.nullable(),
    thcMgPerUnit: NUMERIC_STRING,
    cbdMgPerUnit: NUMERIC_STRING,
    weightGramsPerUnit: NUMERIC_STRING,
    servingCount: z.number().int().nullable(),
    thcMgPerServing: NUMERIC_STRING.nullable(),
    imageKeys: z.array(z.string()).readonly(),
    effectsTags: z.array(z.string()).readonly(),
    flavorTags: z.array(z.string()).readonly(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    labResults: z.array(LabResultResponseSchema).readonly(),
  })
  .strict();

export type ProductResponse = z.infer<typeof ProductResponseSchema>;
