/**
 * Catalog category DTOs.
 *
 *   GET /v1/categories — flat list of product categories ordered by
 *                        `display_order`. Parent linkage is surfaced via
 *                        `parentId` so the iOS client can render a tree
 *                        client-side without an extra round trip per node.
 *
 * The schema is `.strict()` so a future migration that adds a column does
 * not silently leak that column to the client until the response shape is
 * deliberately widened here.
 */
import { z } from 'zod';

export const CategoryResponseSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    displayName: z.string(),
    parentId: z.string().uuid().nullable(),
    displayOrder: z.number().int(),
    iconKey: z.string().nullable(),
  })
  .strict();

export type CategoryResponse = z.infer<typeof CategoryResponseSchema>;

export const CategoryListResponseSchema = z
  .object({
    categories: z.array(CategoryResponseSchema).readonly(),
  })
  .strict();

export type CategoryListResponse = z.infer<typeof CategoryListResponseSchema>;
