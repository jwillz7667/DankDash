/**
 * Vendor listing image-upload DTOs.
 *
 *   POST /v1/vendor/listings/image-uploads — mint a presigned R2 POST so the
 *   portal can upload a product photo directly to object storage, then PATCH
 *   the listing's `imageKeys` with the returned `objectKey`.
 *
 * Direct-to-R2 (rather than proxying bytes through the API) keeps large image
 * payloads off the Node event loop and the API's request-size limits, and the
 * presigned policy locks both the content type and a size ceiling so the
 * browser cannot upload anything other than the image it declared.
 *
 * The accepted content types are deliberately a closed enum — the policy pins
 * `Content-Type`, and the service maps each to a fixed extension so the stored
 * key is predictable. SVG is excluded on purpose (it is an XSS vector when
 * served from a content domain).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UPLOADABLE_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const ImageUploadRequestSchema = z
  .object({
    contentType: z.enum(UPLOADABLE_IMAGE_CONTENT_TYPES),
  })
  .strict();

export type ImageUploadRequest = z.infer<typeof ImageUploadRequestSchema>;

export class ImageUploadRequestDto extends createZodDto(ImageUploadRequestSchema) {}

/**
 * The presigned PUT the client issues to upload directly to R2:
 *   - `uploadUrl`  — the signed R2 URL to PUT the raw file bytes to
 *   - `method`     — always `PUT` (R2 does not support presigned POST)
 *   - `headers`    — headers that must be sent verbatim on the PUT; at minimum
 *                    `Content-Type`, which is part of the signature
 *   - `objectKey`  — the key to persist in the listing's `imageKeys` once the
 *                    upload succeeds
 *   - `expiresAt`  — when the signed URL lapses; the UI re-requests if it stalls
 */
export const ImageUploadResponseSchema = z
  .object({
    uploadUrl: z.string().url(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    objectKey: z.string(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ImageUploadResponse = z.infer<typeof ImageUploadResponseSchema>;
