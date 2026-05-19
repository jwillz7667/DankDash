/**
 * Admin DTO for category creation.
 *
 *   POST /v1/admin/categories — CreateCategoryRequest
 *
 * Categories are write-once-mostly: the catalog admin adds a category during
 * merchandising and almost never removes one. The Phase 4.3 surface intentionally
 * does not include patch or delete; corrections happen by inserting a new row
 * and migrating products off the old one (preserves historical referential
 * integrity from products → category).
 *
 * `parentId` is optional; the top-level browse uses NULL parents. The service
 * pre-flights `parentId` against `productCategories` and returns 422 if it does
 * not exist so a typo cannot orphan a node.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * URL-safe slug — lowercase letters, digits, hyphen separators. Enforced here
 * so the public read endpoint (which surfaces the slug directly to the iOS
 * client and into URLs) cannot receive a value that breaks deep-linking.
 */
const Slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u, 'must be a kebab-case slug');

export const CreateCategoryRequestSchema = z
  .object({
    slug: Slug,
    displayName: z.string().min(1).max(120),
    parentId: z.string().uuid().nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
    iconKey: z.string().min(1).max(500).nullable().optional(),
  })
  .strict();

export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export class CreateCategoryRequestDto extends createZodDto(CreateCategoryRequestSchema) {}
