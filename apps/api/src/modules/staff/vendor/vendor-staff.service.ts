/**
 * Vendor staff service (Phase 15.4).
 *
 *   list(ctx)                       — full roster (active + removed) joined
 *                                     with the underlying users row.
 *   invite(ctx, body)               — invite an existing user by email.
 *                                     `acceptedAt` stays null until they hit
 *                                     /v1/me/dispensaries/:id/accept.
 *   patchRole(ctx, id, body)        — change the role on a staff row.
 *   remove(ctx, id)                 — soft-remove (set removed_at = now).
 *
 * Write paths enforce three invariants on top of the role gate the
 * controller already applies:
 *
 *   1. **The caller cannot mutate themselves.** Removing or demoting your
 *      own staff row would lock you out mid-session. The portal's "delete
 *      me" or "transfer ownership" flows go elsewhere.
 *   2. **Inviting `owner` is owner-only.** A manager who could promote
 *      a budtender to owner would gain ownership-equivalent power by proxy.
 *      Platform admin/superadmin retain the privilege for support.
 *   3. **The last active owner cannot be demoted or removed.** A
 *      zero-owner dispensary cannot ever invite a new owner or perform
 *      owner-only writes, so the system would be locked out. The service
 *      checks `countActiveByRole === 1` before applying the mutation.
 *
 * Invite re-use: if the invitee was previously removed (a row exists with
 * `removed_at IS NOT NULL`), the existing row is *resurrected* — its role
 * is updated, `removed_at` cleared, `invited_at` and `invited_by`
 * refreshed, and `accepted_at` reset to null so they re-confirm. Creating
 * a second row would collide with the unique
 * `(dispensary_id, user_id)` index.
 *
 * Cross-tenant access (PATCH/DELETE against a staff row that belongs to
 * another dispensary) surfaces as 404 so a probing call cannot distinguish
 * "this row does not exist" from "this row belongs to another vendor".
 */
import {
  DispensaryStaffRepository,
  UsersRepository,
  type DispensaryStaffMember,
  type StaffRole,
  type StaffWithUserRow,
  type User,
} from '@dankdash/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type {
  InviteStaffRequest,
  PatchStaffRequest,
  VendorStaffListResponse,
  VendorStaffMember,
  VendorStaffResponse,
} from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

export interface StaffRepos {
  readonly staff: DispensaryStaffRepository;
  readonly users: UsersRepository;
}

/** Pre-bound repos accessor — production closes over the pooled DB token,
 *  tests return an in-memory bundle. */
export type StaffRepoFactory = () => StaffRepos;

@Injectable()
export class VendorStaffService {
  constructor(private readonly repoFor: StaffRepoFactory) {}

  async list(ctx: VendorContext): Promise<VendorStaffListResponse> {
    const { staff } = this.repoFor();
    const rows = await staff.listWithUserForDispensary(ctx.dispensaryId);
    return { staff: rows.map(toMember) };
  }

  async invite(ctx: VendorContext, body: InviteStaffRequest): Promise<VendorStaffResponse> {
    this.assertCanAssignRole(ctx, body.role);

    const { staff, users } = this.repoFor();
    const user = await users.findByEmail(body.email);
    if (user?.deletedAt !== null) {
      throw new NotFoundError('User', body.email);
    }
    if (user.id === ctx.userId) {
      throw new ValidationError('Cannot invite yourself', { email: body.email });
    }

    const existing = await staff.findByDispensaryAndUser(ctx.dispensaryId, user.id);
    if (existing !== null && existing.removedAt === null) {
      throw new ConflictError(
        'STAFF_ALREADY_MEMBER',
        'This user is already a staff member of this dispensary',
        { dispensaryId: ctx.dispensaryId, userId: user.id },
      );
    }

    // Re-invite a previously removed member by resurrecting the row. The
    // alternative — soft-deleting the row and creating a fresh one — would
    // collide with `dispensary_staff_dispensary_user_uq`.
    if (existing !== null && existing.removedAt !== null) {
      const restored = await staff.invite({
        id: existing.id,
        dispensaryId: ctx.dispensaryId,
        userId: user.id,
        role: body.role,
        invitedBy: ctx.userId,
        invitedAt: new Date(),
        acceptedAt: null,
        removedAt: null,
      });
      return this.hydrate(restored, user);
    }

    const created = await staff.invite({
      dispensaryId: ctx.dispensaryId,
      userId: user.id,
      role: body.role,
      invitedBy: ctx.userId,
    });
    return this.hydrate(created, user);
  }

  async patchRole(
    ctx: VendorContext,
    id: string,
    body: PatchStaffRequest,
  ): Promise<VendorStaffResponse> {
    this.assertCanAssignRole(ctx, body.role);

    const { staff, users } = this.repoFor();
    const target = await staff.findById(id);
    if (target?.dispensaryId !== ctx.dispensaryId || target.removedAt !== null) {
      throw new NotFoundError('StaffMember', id);
    }
    if (target.userId === ctx.userId) {
      throw new ValidationError('Cannot change your own role', { staffId: id });
    }

    // Last-owner invariant: demoting the only active owner leaves the
    // dispensary with no one who can grant ownership ever again.
    if (target.role === 'owner' && body.role !== 'owner') {
      const owners = await staff.countActiveByRole(ctx.dispensaryId, 'owner');
      if (owners <= 1) {
        throw new ConflictError('STAFF_LAST_OWNER', 'Cannot demote the last remaining owner', {
          dispensaryId: ctx.dispensaryId,
          staffId: id,
        });
      }
    }

    if (target.role === body.role) {
      // No-op patch — return the current hydrated row rather than touching
      // the DB. Matches the menu service's empty-patch guard.
      const user = await users.findById(target.userId);
      if (user === null) throw new NotFoundError('User', target.userId);
      return this.hydrate(target, user);
    }

    const updated = await staff.updateRole(id, body.role);
    if (updated === null) throw new NotFoundError('StaffMember', id);
    const user = await users.findById(updated.userId);
    if (user === null) throw new NotFoundError('User', updated.userId);
    return this.hydrate(updated, user);
  }

  async remove(ctx: VendorContext, id: string): Promise<void> {
    const { staff } = this.repoFor();
    const target = await staff.findById(id);
    if (target?.dispensaryId !== ctx.dispensaryId || target.removedAt !== null) {
      throw new NotFoundError('StaffMember', id);
    }
    if (target.userId === ctx.userId) {
      throw new ValidationError('Cannot remove yourself', { staffId: id });
    }
    if (target.role === 'owner') {
      const owners = await staff.countActiveByRole(ctx.dispensaryId, 'owner');
      if (owners <= 1) {
        throw new ConflictError('STAFF_LAST_OWNER', 'Cannot remove the last remaining owner', {
          dispensaryId: ctx.dispensaryId,
          staffId: id,
        });
      }
    }
    await staff.remove(id, new Date());
  }

  /**
   * Promoting / inviting to `owner` requires an owner principal at the
   * dispensary level. Platform-level admins (`admin`/`superadmin` on the
   * JWT) retain the privilege for ops/support work. `manager` cannot
   * confer ownership; `budtender` is blocked at the @Roles gate upstream.
   */
  private assertCanAssignRole(ctx: VendorContext, role: StaffRole): void {
    if (role !== 'owner') return;
    if (ctx.staffRole === 'owner') return;
    throw new ForbiddenError('Only an owner can assign the owner role', {
      callerStaffRole: ctx.staffRole,
      requestedRole: role,
    });
  }

  private hydrate(member: DispensaryStaffMember, user: User): VendorStaffResponse {
    return toMember({
      id: member.id,
      dispensaryId: member.dispensaryId,
      userId: member.userId,
      role: member.role,
      invitedAt: member.invitedAt,
      invitedBy: member.invitedBy,
      acceptedAt: member.acceptedAt,
      removedAt: member.removedAt,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      mfaEnabled: user.mfaEnabled,
      lastLoginAt: user.lastLoginAt,
    });
  }
}

function toMember(row: StaffWithUserRow): VendorStaffMember {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    mfaEnabled: row.mfaEnabled,
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    invitedAt: row.invitedAt.toISOString(),
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
    removedAt: row.removedAt === null ? null : row.removedAt.toISOString(),
  };
}
