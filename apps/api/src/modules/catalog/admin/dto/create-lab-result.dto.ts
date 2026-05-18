/**
 * Admin DTO for product lab-result (COA) creation.
 *
 *   POST /v1/admin/products/:id/lab-results — CreateLabResultRequest
 *
 * Lab results are append-only at the schema level (unique on
 * (product_id, batch_id) — re-uploading a corrected COA for the same batch
 * collides on purpose; corrections require a new batch id from the lab).
 *
 * `productId` comes from the route param, not the body — the body never
 * carries a foreign key the URL already pins. The service rejects unknown
 * product ids as 404 and existing (productId, batchId) pairs as 409.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { NUMERIC_STRING } from '../../dto/index.js';

/** `YYYY-MM-DD` calendar date — the column is `date` so no time component. */
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be YYYY-MM-DD');

export const CreateLabResultRequestSchema = z
  .object({
    batchId: z.string().min(1).max(120),
    labName: z.string().min(1).max(200),
    coaDocumentKey: z.string().min(1).max(500).nullable().optional(),
    potencyThc: NUMERIC_STRING.nullable().optional(),
    potencyCbd: NUMERIC_STRING.nullable().optional(),
    contaminantsPassed: z.boolean().nullable().optional(),
    testedAt: ISODate,
  })
  .strict();

export type CreateLabResultRequest = z.infer<typeof CreateLabResultRequestSchema>;

export class CreateLabResultRequestDto extends createZodDto(CreateLabResultRequestSchema) {}
