/**
 * Vendor DTOs for listing write paths.
 *
 *   POST  /v1/vendor/listings           — CreateListingRequest
 *   PATCH /v1/vendor/listings/:id       — PatchListingRequest
 *
 * `dispensaryId` is intentionally absent from the body — the request's
 * dispensary context comes from the `X-Dispensary-Id` header, verified by
 * the VendorContextGuard against `dispensary_staff`. Accepting it in the
 * body would let a privileged vendor write into another vendor's row via
 * the dispensary they actually staff. The body and the header would have
 * to agree, and there is no reason a portal client knows two different
 * dispensary ids on the same request.
 *
 * Compliance-relevant constraints enforced here so a 422 surfaces before
 * the DB CHECK fires a 500:
 *
 *   - `priceCents > 0` — matches the CHECK constraint on the column. A
 *     "free" listing is not a meaningful concept on a paid catalog; a
 *     promotional override goes through `compareAtPriceCents`.
 *   - `compareAtPriceCents > priceCents` when both are present — a strike
 *     price must actually be higher than the sale price, otherwise the
 *     "was $X" UI lies to the customer.
 *   - SKU is a short opaque key from the vendor's own POS; no format we
 *     can validate here without false positives, so just length-cap it.
 *   - Metrc package tag follows the Metrc canonical 24-character format:
 *     a `1` prefix, a 7-character alphanumeric facility license code, and
 *     a 16-character hex package identifier (the API renders the tag's
 *     64-bit id as hex, so digits and A–F are both valid). Validation
 *     here keeps a typo from flowing downstream into the Metrc receipt
 *     reconciler.
 *
 * Patch is the same field set minus `productId` (changing the product a
 * listing refers to is a different operation — the vendor would delete
 * and re-create rather than rebind a SKU to a new product), and all
 * fields are optional. The service rejects an empty patch with a
 * specific message.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const METRC_TAG_REGEX = /^1[A-Z0-9]{7}[A-F0-9]{16}$/u;

/**
 * Cap on per-listing image overrides. Ten is well past what a menu card or
 * detail gallery renders and keeps the list-row payload bounded; the portal
 * uploader enforces the same limit client-side so the 422 is a backstop, not
 * the primary UX. Ownership of each key — it must sit under this dispensary's
 * own R2 prefix — is enforced in the service, the only layer that knows the
 * dispensary id; the DTO shape-validates length and count here.
 */
const MAX_LISTING_IMAGES = 10;

const ListingFields = {
  productId: z.string().uuid(),
  sku: z.string().min(1).max(120),
  priceCents: z.number().int().positive().max(1_000_000_00),
  compareAtPriceCents: z.number().int().positive().max(1_000_000_00).nullable().optional(),
  quantityAvailable: z.number().int().min(0).max(1_000_000).optional(),
  imageKeys: z.array(z.string().min(1).max(512)).max(MAX_LISTING_IMAGES).optional(),
  metrcPackageTag: z
    .string()
    .regex(METRC_TAG_REGEX, 'must be a Metrc package tag')
    .nullable()
    .optional(),
} as const;

/**
 * Cross-field invariant: when both prices are present, the strike-through
 * price must be strictly greater than the sale price. Returns true when
 * either field is absent or null — the patch reuse defers to the same
 * check after merging against the persisted row.
 */
function compareAtPriceOk(input: {
  readonly priceCents?: number | undefined;
  readonly compareAtPriceCents?: number | null | undefined;
}): boolean {
  if (input.priceCents === undefined) return true;
  if (input.compareAtPriceCents === null || input.compareAtPriceCents === undefined) return true;
  return input.compareAtPriceCents > input.priceCents;
}

export const CreateListingRequestSchema = z
  .object(ListingFields)
  .strict()
  .refine(compareAtPriceOk, {
    message: 'compareAtPriceCents must be strictly greater than priceCents',
    path: ['compareAtPriceCents'],
  });

export type CreateListingRequest = z.infer<typeof CreateListingRequestSchema>;

export class CreateListingRequestDto extends createZodDto(CreateListingRequestSchema) {}

/**
 * Patch mirrors create with every field optional and `productId` removed
 * (immutable on patch — see file header). `isActive` is exposed only on
 * patch so the vendor can reactivate a deactivated listing without
 * re-creating it (POST returns 409 on a duplicate `(dispensaryId, sku)`,
 * which would surprise the vendor who tried to "undelete").
 */
export const PatchListingRequestSchema = z
  .object({
    sku: ListingFields.sku.optional(),
    priceCents: ListingFields.priceCents.optional(),
    compareAtPriceCents: ListingFields.compareAtPriceCents,
    quantityAvailable: ListingFields.quantityAvailable,
    imageKeys: ListingFields.imageKeys,
    metrcPackageTag: ListingFields.metrcPackageTag,
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(compareAtPriceOk, {
    message: 'compareAtPriceCents must be strictly greater than priceCents',
    path: ['compareAtPriceCents'],
  });

export type PatchListingRequest = z.infer<typeof PatchListingRequestSchema>;

export class PatchListingRequestDto extends createZodDto(PatchListingRequestSchema) {}
