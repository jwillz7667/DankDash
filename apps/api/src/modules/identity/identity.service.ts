/**
 * Identity orchestration.
 *
 * Owns the user-facing identity flows:
 *
 *   getMe(userId)           — returns the projected MeResponse (kycVerified,
 *                              mfaEnabled, lastLoginAt). Throws NotFoundError
 *                              if the user has been deleted between
 *                              authentication and this call.
 *
 *   updateMe(userId, patch) — narrow self-service profile update. The DTO
 *                              already forbids email/phone/DOB; this service
 *                              just persists the validated patch.
 *
 *   startKyc(userId)        — calls PersonaService.createInquiry and persists
 *                              the inquiry id on users.kyc_provider_ref so the
 *                              webhook can correlate back. Idempotent on the
 *                              caller side — re-starting just mints a new
 *                              inquiry.
 *
 *   applyKycOutcome(outcome) — invoked by the webhook controller after
 *                              PersonaService.handleWebhook returns. On
 *                              `kyc.completed` we flip status=active and stamp
 *                              kyc_verified_at + kyc_provider + provider_ref.
 *                              Failures and expirations are accepted (audit-
 *                              logged elsewhere) but do not mutate the user —
 *                              they can re-enroll.
 *
 * No DB transaction wrapper is needed here: each update is a single-row UPDATE
 * the repository already executes atomically. When Phase 3 introduces a
 * KYC-event ledger, that write will join the user UPDATE in one transaction.
 */
import {
  DispensariesRepository,
  DispensaryStaffRepository,
  UsersRepository,
  type Dispensary,
  type DispensaryStaffMember,
} from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { PersonaService, type WebhookOutcome } from './persona/persona.service.js';
import type {
  DispensaryMembership,
  DispensaryMembershipsResponse,
  KycStartResponse,
  MeResponse,
  UpdateMeRequestDto,
} from './dto/index.js';

const PROVIDER_NAME = 'persona';

@Injectable()
export class IdentityService {
  constructor(
    private readonly users: UsersRepository,
    private readonly persona: PersonaService,
    private readonly dispensaryStaff: DispensaryStaffRepository,
    private readonly dispensaries: DispensariesRepository,
  ) {}

  async getMe(userId: string): Promise<MeResponse> {
    const user = await this.users.findById(userId);
    if (user?.deletedAt !== null) {
      throw new NotFoundError('User', userId);
    }
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      kycVerified: user.kycVerifiedAt !== null,
      kycVerifiedAt: user.kycVerifiedAt?.toISOString() ?? null,
      mfaEnabled: user.mfaEnabled,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async updateMe(userId: string, patch: UpdateMeRequestDto): Promise<MeResponse> {
    const updated = await this.users.update(userId, {
      ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
    });
    if (updated === null) {
      throw new NotFoundError('User', userId);
    }
    return this.getMe(userId);
  }

  /**
   * Active staff memberships for the authenticated user, projected to
   * the wire shape the portal needs to thread `X-Dispensary-Id`.
   *
   * Returns rows where `dispensary_staff.removed_at IS NULL`; an
   * invited-but-unaccepted membership is included (acceptedAt is null
   * on the wire) so the portal can render a pending-invite affordance
   * without a second roundtrip. The DispensaryStaffRepository already
   * filters by `removedAt IS NULL`, so this method only does the
   * dispensary lookup + projection.
   *
   * The dispensary fetch is parallelised per row — for a single-store
   * staff member that is one DB call, for a five-store owner it is
   * five concurrent calls. We deliberately do not push this into a
   * SQL join inside the staff repo: the staff repo is the only
   * `dispensary_staff` accessor and the dispensaries projection
   * (geo columns) is repo-owned. Keeping the joinery here means a
   * future addition to either repo does not silently widen this API
   * surface.
   *
   * Soft-deleted or non-active dispensaries are filtered out — a staff
   * member of a dispensary that has been deactivated by the admin
   * shouldn't see it in the picker. The same is true for soft-deleted
   * dispensaries; the foreign key uses `ON DELETE RESTRICT` so a
   * `deletedAt IS NOT NULL` is the only "gone" signal.
   */
  async listDispensaries(userId: string): Promise<DispensaryMembershipsResponse> {
    const memberships = await this.dispensaryStaff.listActiveForUser(userId);
    if (memberships.length === 0) return { memberships: [] };

    const dispensaryRows = await Promise.all(
      memberships.map((m) => this.dispensaries.findById(m.dispensaryId)),
    );

    const projected: DispensaryMembership[] = [];
    for (let i = 0; i < memberships.length; i += 1) {
      const membership = memberships[i];
      const dispensary = dispensaryRows[i];
      if (membership === undefined || dispensary === null || dispensary === undefined) continue;
      if (dispensary.deletedAt !== null) continue;
      if (dispensary.status !== 'active') continue;
      projected.push(projectMembership(membership, dispensary));
    }

    // Oldest-joined first so a multi-store owner sees their primary
    // store at the top of the picker, with newer acquisitions trailing.
    projected.sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
    return { memberships: projected };
  }

  async startKyc(userId: string): Promise<KycStartResponse> {
    const user = await this.users.findById(userId);
    if (user?.deletedAt !== null) {
      throw new NotFoundError('User', userId);
    }
    const inquiry = await this.persona.createInquiry(userId);
    await this.users.update(userId, {
      kycProvider: PROVIDER_NAME,
      kycProviderRef: inquiry.inquiryId,
    });
    return { inquiryId: inquiry.inquiryId, inquiryUrl: inquiry.hostedFlowUrl };
  }

  async applyKycOutcome(outcome: WebhookOutcome): Promise<void> {
    if (outcome.type === 'kyc.completed') {
      // markKycVerified sets kyc_verified_at + provider + provider_ref +
      // status='active'. Idempotent: re-completing an already-verified user
      // just updates the timestamp, which is harmless for audit.
      await this.users.markKycVerified(outcome.userId, PROVIDER_NAME, outcome.inquiryId);
      // Persist the Persona-verified DOB over whatever the user typed at
      // registration. The DOB column has a CHECK constraint disallowing
      // pre-1900 dates; Persona's value has already passed our age gate, so
      // it is guaranteed to satisfy that.
      await this.users.update(outcome.userId, { dateOfBirth: outcome.dateOfBirth });
      return;
    }
    // kyc.failed / kyc.expired / ignored:
    //   The user row is intentionally NOT mutated. The applicant can retry,
    //   and we don't want a transient Persona issue to lock them out. The
    //   webhook controller has already acked the event (204) so Persona will
    //   not retry. The compliance audit trail captures the failed inquiry
    //   through the inbound LoggingInterceptor — once Phase 4 ships the
    //   kyc_events ledger, that becomes an explicit row here.
  }
}

function projectMembership(
  membership: DispensaryStaffMember,
  dispensary: Dispensary,
): DispensaryMembership {
  const displayName = dispensary.dba ?? dispensary.legalName;
  const acceptedAt = membership.acceptedAt;
  // joinedAt = acceptedAt when accepted, otherwise the invited_at marker.
  // Both columns are NOT NULL in the schema (invited_at has a default), so
  // the fallback is always a real date.
  const joinedAt = acceptedAt ?? membership.invitedAt;
  return {
    id: dispensary.id,
    displayName,
    staffRole: membership.role,
    acceptedAt: acceptedAt === null ? null : acceptedAt.toISOString(),
    joinedAt: joinedAt.toISOString(),
  };
}
