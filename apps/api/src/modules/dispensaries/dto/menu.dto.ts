/**
 * Dispensary menu DTO.
 *
 *   GET /v1/dispensaries/:id/menu — products this dispensary actively
 *                                   carries, with per-listing pricing and
 *                                   inventory denormalized for the iOS
 *                                   menu screen.
 *
 * The line is the listing-product join. Two reasons for this shape:
 *
 *   1. The product fields are the same shape the iOS client renders on
 *      both the menu card and the product detail; surfacing them inline
 *      lets the detail screen render immediately from cached menu state,
 *      then refresh in the background from `GET /v1/products/:id`.
 *   2. The listing fields (price, sku, qty) are per-dispensary by design
 *      — the same product carried by two stores has two listings. Co-
 *      locating them with the product on the menu line keeps the response
 *      flat enough for an iOS `List`/`LazyVStack` to consume without a
 *      reduce pass.
 *
 * Lab results are NOT included here; the iOS client fetches them via
 * `GET /v1/products/:id` when the user opens detail. Including them on
 * every menu line would inflate the menu payload 5-10x for a value the
 * customer rarely reads on the list.
 */
import { z } from 'zod';
import { NUMERIC_STRING, ProductTypeSchema, StrainTypeSchema } from '../../catalog/dto/index.js';

export const MenuProductSchema = z
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
  })
  .strict();

export type MenuProductResponse = z.infer<typeof MenuProductSchema>;

export const MenuItemResponseSchema = z
  .object({
    listingId: z.string().uuid(),
    sku: z.string(),
    priceCents: z.number().int().positive(),
    compareAtPriceCents: z.number().int().positive().nullable(),
    quantityAvailable: z.number().int().nonnegative(),
    product: MenuProductSchema,
  })
  .strict();

export type MenuItemResponse = z.infer<typeof MenuItemResponseSchema>;

export const MenuResponseSchema = z
  .object({
    dispensaryId: z.string().uuid(),
    items: z.array(MenuItemResponseSchema).readonly(),
  })
  .strict();

export type MenuResponse = z.infer<typeof MenuResponseSchema>;
