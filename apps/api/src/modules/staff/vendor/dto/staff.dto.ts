/**
 * DTOs for the vendor-portal staff surface.
 *
 *   GET    /v1/vendor/staff        — roster (active + removed) with user details
 *   POST   /v1/vendor/staff        — invite an existing user by email
 *   PATCH  /v1/vendor/staff/:id    — change a staff member's role
 *   DELETE /v1/vendor/staff/:id    — soft-remove (set `removed_at`)
 *
 * The wire `StaffRole` enum (`budtender | manager | owner`) is the
 * *per-dispensary* role — distinct from the platform-level `UserRole` on
 * the JWT. A user can hold `owner` at one dispensary and `budtender` at
 * another; the field on this DTO is always the role at the dispensary
 * named by the X-Dispensary-Id header.
 *
 * The staff row carries timestamps for inviting (`invitedAt`) and
 * accepting (`acceptedAt`) plus the underlying user's `lastLoginAt` and
 * `mfaEnabled`. The portal renders these together as a coarse activity
 * log per row in the Phase 15.4 staff page — a full per-staff audit feed
 * lands once the `audit_log` writer wires up across the modules.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const StaffRoleSchema = z.enum(['budtender', 'manager', 'owner']);
export type VendorStaffRole = z.infer<typeof StaffRoleSchema>;

export const VendorStaffMemberSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    role: StaffRoleSchema,
    email: z.string().email(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    mfaEnabled: z.boolean(),
    /** ISO-8601 UTC timestamp the underlying user last signed in; null if never. */
    lastLoginAt: z.string().datetime({ offset: true }).nullable(),
    invitedAt: z.string().datetime({ offset: true }),
    /** Null until the invitee accepts. The portal renders "Pending" until then. */
    acceptedAt: z.string().datetime({ offset: true }).nullable(),
    /** Null while active. Set when the member is removed; the row is kept for audit. */
    removedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type VendorStaffMember = z.infer<typeof VendorStaffMemberSchema>;

export const VendorStaffListResponseSchema = z
  .object({
    staff: z.array(VendorStaffMemberSchema).readonly(),
  })
  .strict();
export type VendorStaffListResponse = z.infer<typeof VendorStaffListResponseSchema>;
export class VendorStaffListResponseDto extends createZodDto(VendorStaffListResponseSchema) {}

/**
 * Invite an existing DankDash user by email. The user must already have a
 * `users` row — the portal's staff invite flow does not create new
 * accounts. A 404 `USER_NOT_FOUND` is returned otherwise so the inviter
 * knows to ask the invitee to sign up first.
 *
 * `role` is the staff role they get at the active dispensary. The service
 * enforces an additional invariant: an `owner` invite can only be sent by
 * a principal who is themselves an `owner` (or a platform admin).
 */
export const InviteStaffRequestSchema = z
  .object({
    email: z.string().email().max(254),
    role: StaffRoleSchema,
  })
  .strict();
export type InviteStaffRequest = z.infer<typeof InviteStaffRequestSchema>;
export class InviteStaffRequestDto extends createZodDto(InviteStaffRequestSchema) {}

export const PatchStaffRequestSchema = z
  .object({
    role: StaffRoleSchema,
  })
  .strict();
export type PatchStaffRequest = z.infer<typeof PatchStaffRequestSchema>;
export class PatchStaffRequestDto extends createZodDto(PatchStaffRequestSchema) {}

export const VendorStaffResponseSchema = VendorStaffMemberSchema;
export type VendorStaffResponse = z.infer<typeof VendorStaffResponseSchema>;
export class VendorStaffResponseDto extends createZodDto(VendorStaffResponseSchema) {}
