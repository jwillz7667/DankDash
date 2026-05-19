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
import { UsersRepository } from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { PersonaService, type WebhookOutcome } from './persona/persona.service.js';
import type { KycStartResponse, MeResponse, UpdateMeRequestDto } from './dto/index.js';

const PROVIDER_NAME = 'persona';

@Injectable()
export class IdentityService {
  constructor(
    private readonly users: UsersRepository,
    private readonly persona: PersonaService,
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
