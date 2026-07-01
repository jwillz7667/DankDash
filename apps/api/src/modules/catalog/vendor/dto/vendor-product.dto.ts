/**
 * Vendor product-authoring DTOs.
 *
 *   POST  /v1/vendor/products      — CreateVendorProductDto
 *   PATCH /v1/vendor/products/:id  — PatchVendorProductDto
 *
 * The wire shape is identical to the admin catalog product DTOs — a vendor
 * authors the very same fields an admin does — so we reuse the admin Zod
 * schemas verbatim. Reusing them (rather than re-declaring) guarantees the
 * compliance refines (beverage ≤10 mg THC/serving, ≤2 servings/container,
 * Minn. Stat. § 342.46) are byte-for-byte the same on both surfaces; a third
 * copy of those caps is exactly the constant-drift the compliance header warns
 * against.
 *
 * What differs is enforced server-side, not in the body: ownership
 * (`created_by_dispensary_id` is derived from the X-Dispensary-Id header, never
 * sent), and `imageKeys` must sit under the dispensary's own R2 prefix
 * (validated in VendorProductsService, like listing images).
 */
import { createZodDto } from 'nestjs-zod';
import {
  CreateProductRequestSchema,
  PatchProductRequestSchema,
} from '../../admin/dto/create-product.dto.js';

export class CreateVendorProductDto extends createZodDto(CreateProductRequestSchema) {}

export class PatchVendorProductDto extends createZodDto(PatchProductRequestSchema) {}

export type {
  CreateProductRequest as CreateVendorProductRequest,
  PatchProductRequest as PatchVendorProductRequest,
} from '../../admin/dto/create-product.dto.js';
