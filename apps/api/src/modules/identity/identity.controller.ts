/**
 * /v1/me + /v1/identity/kyc/start HTTP surface.
 *
 *   GET   /v1/me                       — Authenticated. Returns MeResponse
 *                                         (profile + derived flags).
 *   PATCH /v1/me                       — Authenticated. Narrow self-service
 *                                         profile update (firstName, lastName).
 *   POST  /v1/identity/kyc/start       — Authenticated. Creates a Persona
 *                                         inquiry; returns the hosted-flow URL
 *                                         the iOS client opens in
 *                                         SFSafariViewController.
 *
 * The webhook lives on a separate controller because the body shape is raw
 * (HMAC verification requires the exact incoming bytes) and the route is
 * @Public — keeping the surfaces split avoids accidental cross-routing of
 * auth requirements.
 */
import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  UpdateMeRequestDto,
  type DispensaryMembershipsResponse,
  type KycStartResponse,
  type MeResponse,
} from './dto/index.js';
import { IdentityService } from './identity.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.identity.getMe(user.userId);
  }

  /**
   * Active staff memberships for the authenticated user — the portal
   * calls this once after login to resolve which `X-Dispensary-Id` to
   * thread on subsequent vendor-scoped requests. Empty array for users
   * with no memberships (e.g. global admin) — the portal handles that
   * as "no dispensary context yet, surface the multi-store picker".
   */
  @Get('me/dispensaries')
  listDispensaries(@CurrentUser() user: AuthenticatedUser): Promise<DispensaryMembershipsResponse> {
    return this.identity.listDispensaries(user.userId);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateMeRequestDto,
  ): Promise<MeResponse> {
    return this.identity.updateMe(user.userId, body);
  }

  @Post('identity/kyc/start')
  startKyc(@CurrentUser() user: AuthenticatedUser): Promise<KycStartResponse> {
    return this.identity.startKyc(user.userId);
  }
}
