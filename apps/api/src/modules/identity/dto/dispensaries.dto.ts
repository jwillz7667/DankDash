/**
 * `GET /v1/me/dispensaries` response DTO.
 *
 * The portal calls this once per session (in the Auth.js jwt callback)
 * to resolve which dispensary a staff member is acting on behalf of.
 * The response is sized for a multi-store owner — most staff have one
 * membership, owners may have several — and is intentionally narrow:
 * only the fields the portal renders in a future picker UI + the
 * `dispensaryId` it threads into `X-Dispensary-Id` on subsequent
 * vendor-scoped requests.
 *
 *   - `id` is the dispensary primary key the API uses for the header.
 *   - `displayName` falls back from `dba → legalName` so a dispensary
 *     that has not set its public DBA still surfaces under its legal
 *     entity name; never null.
 *   - `staffRole` is the per-dispensary role from `dispensary_staff` —
 *     distinct from the global role on the JWT (the picker will gate
 *     "owner-only" affordances on this).
 *   - `acceptedAt` differentiates an active-and-accepted membership
 *     from an invited-but-unaccepted one; portal hides the latter from
 *     the picker but the API still surfaces it so the eventual
 *     accept-invite UX can render the pending invitations.
 *   - `joinedAt` is `accepted_at ?? invited_at` — what the picker shows
 *     as "Member since" without forcing the consumer to coalesce.
 *
 * The list is ordered by `joinedAt` ascending so the most tenured
 * membership floats first; the portal picks the first row on a
 * single-store account and would surface a real chooser on multi-store.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const StaffRoleSchema = z.enum(['budtender', 'manager', 'owner']);

export const DispensaryMembershipSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    staffRole: StaffRoleSchema,
    acceptedAt: z.string().datetime({ offset: true }).nullable(),
    joinedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type DispensaryMembership = z.infer<typeof DispensaryMembershipSchema>;

export const DispensaryMembershipsResponseSchema = z
  .object({
    memberships: z.array(DispensaryMembershipSchema),
  })
  .strict();
export type DispensaryMembershipsResponse = z.infer<typeof DispensaryMembershipsResponseSchema>;

export class DispensaryMembershipsResponseDto extends createZodDto(
  DispensaryMembershipsResponseSchema,
) {}
