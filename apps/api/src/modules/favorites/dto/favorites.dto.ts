/**
 * `/v1/me/favorites` DTOs.
 *
 *   GET    /v1/me/favorites                       — paginated, reverse-chron
 *                                                    feed of the caller's saved
 *                                                    dispensaries + products,
 *                                                    each hydrated into a card
 *                                                    summary.
 *   PUT    /v1/me/favorites/dispensaries/:id       — save a dispensary (204).
 *   DELETE /v1/me/favorites/dispensaries/:id       — unsave (204).
 *   PUT    /v1/me/favorites/products/:id           — save a product (204).
 *   DELETE /v1/me/favorites/products/:id           — unsave (204).
 *
 * The feed is a discriminated union keyed on `type`. Each arm reuses the
 * canonical card shape from the owning module — `DispensaryResponse` (the same
 * shape the discovery list emits) and `MenuProductResponse` (the product-card
 * shape, deliberately WITHOUT lab results so a favorites page of N products
 * costs no per-product COA fetch). `favoritedAt` is the save timestamp, so the
 * client can render "Saved 3 days ago" and trust the server's ordering.
 *
 * Hydration drops any saved target that has since gone soft-deleted / inactive
 * (same 404 semantics as the read paths), so a page may surface fewer items
 * than `page.total` — `total` counts raw saves, the array counts live ones.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MenuProductSchema, DispensaryResponseSchema } from '../../dispensaries/dto/index.js';

export const FavoritesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(24),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type FavoritesQuery = z.infer<typeof FavoritesQuerySchema>;

export class FavoritesQueryDto extends createZodDto(FavoritesQuerySchema) {}

export const FavoriteDispensaryItemSchema = z
  .object({
    type: z.literal('dispensary'),
    favoritedAt: z.string().datetime({ offset: true }),
    dispensary: DispensaryResponseSchema,
  })
  .strict();

export const FavoriteProductItemSchema = z
  .object({
    type: z.literal('product'),
    favoritedAt: z.string().datetime({ offset: true }),
    product: MenuProductSchema,
  })
  .strict();

export const FavoriteItemSchema = z.discriminatedUnion('type', [
  FavoriteDispensaryItemSchema,
  FavoriteProductItemSchema,
]);

export type FavoriteItem = z.infer<typeof FavoriteItemSchema>;

export const FavoritesPageSchema = z
  .object({
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().min(0),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const FavoritesResponseSchema = z
  .object({
    favorites: z.array(FavoriteItemSchema).readonly(),
    page: FavoritesPageSchema,
  })
  .strict();

export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>;
