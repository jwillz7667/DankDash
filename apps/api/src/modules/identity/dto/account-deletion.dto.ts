/**
 * DELETE /v1/me DTO.
 *
 * Account deletion is irreversible: the server anonymizes the identity-root
 * PII, soft-deletes the user's addresses + payment methods, and revokes every
 * session — all in one transaction. The response is a thin acknowledgement
 * carrying the tombstone timestamp; the iOS client uses it only to confirm
 * success before tearing down local auth state and returning to the
 * signed-out root. No user fields are echoed back (there is nothing left to
 * show).
 */
import { z } from 'zod';

export const AccountDeletionResponseSchema = z
  .object({
    deletedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AccountDeletionResponse = z.infer<typeof AccountDeletionResponseSchema>;
