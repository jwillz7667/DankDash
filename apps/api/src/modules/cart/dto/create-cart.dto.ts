/**
 * Cart-creation request body.
 *
 *   POST /v1/carts                       — { dispensaryId }
 *
 * The principal comes from the JWT (carts are user-owned), so only the
 * dispensary context is in the body. The endpoint is idempotent per
 * (userId, dispensaryId) — calling it twice returns the same cart row
 * because `carts_user_dispensary_uq` makes a second insert impossible.
 *
 * Validation here keeps a malformed dispensaryId out of a Postgres FK
 * round-trip; the service still pre-flights existence so a typed 422
 * surfaces for a well-formed UUID that does not match any dispensary
 * row.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateCartRequestSchema = z
  .object({
    dispensaryId: z.string().uuid(),
  })
  .strict();

export type CreateCartRequest = z.infer<typeof CreateCartRequestSchema>;

export class CreateCartRequestDto extends createZodDto(CreateCartRequestSchema) {}
