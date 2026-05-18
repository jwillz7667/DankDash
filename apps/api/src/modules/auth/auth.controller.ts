/**
 * /v1/auth/* HTTP surface.
 *
 *   POST /v1/auth/register      — Public. Creates a new customer (pending_kyc)
 *                                  and mints a session.
 *   POST /v1/auth/login         — Public. Returns either a token pair or
 *                                  `{ status: 'mfa_required' }` per the
 *                                  discriminated-union LoginResponse.
 *   POST /v1/auth/refresh       — Public. Rotates the refresh token; reuse
 *                                  detection cascades family revocation.
 *   POST /v1/auth/logout        — Authenticated. Revokes the presented
 *                                  refresh token; 204 No Content on success.
 *   POST /v1/auth/mfa/setup     — Authenticated. Begins enrollment; returns
 *                                  the secret + otpauth URL (NOT persisted
 *                                  until /confirm).
 *   POST /v1/auth/mfa/confirm   — Authenticated. Persists the encrypted
 *                                  secret + flips mfa_enabled=true.
 *   POST /v1/auth/mfa/verify    — Authenticated. Idempotent code check used
 *                                  by step-up flows.
 *   POST /v1/auth/mfa/disable   — Authenticated. Requires a current code so
 *                                  a stolen access token alone cannot strip
 *                                  the second factor.
 *
 * Public routes carry @Public; everything else inherits the global
 * JwtAuthGuard. The MFA routes do not need @Roles — any authenticated user
 * may manage their own MFA.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { AuthService, type AuthRequestContext } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import {
  LoginRequestDto,
  LogoutRequestDto,
  MfaConfirmRequestDto,
  MfaDisableRequestDto,
  MfaVerifyRequestDto,
  RefreshRequestDto,
  RegisterRequestDto,
  type LoginResponse,
  type MfaSetupResponse,
  type RefreshResponse,
  type RegisterResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from './guards/auth-types.js';
import type { FastifyRequest } from 'fastify';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit({ name: 'auth-register-ip', tracker: 'ip', limit: 3, windowMs: HOUR_MS })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(
    @Body() body: RegisterRequestDto,
    @Req() req: FastifyRequest,
  ): Promise<RegisterResponse> {
    return this.auth.register(body, requestContext(req));
  }

  @Public()
  @RateLimit(
    { name: 'auth-login-ip', tracker: 'ip', limit: 5, windowMs: MINUTE_MS },
    { name: 'auth-login-email', tracker: 'email-from-body', limit: 10, windowMs: HOUR_MS },
  )
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: LoginRequestDto, @Req() req: FastifyRequest): Promise<LoginResponse> {
    return this.auth.login(body, requestContext(req));
  }

  @Public()
  @RateLimit({
    name: 'auth-refresh',
    tracker: 'refresh-from-body',
    limit: 60,
    windowMs: MINUTE_MS,
  })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshRequestDto, @Req() req: FastifyRequest): Promise<RefreshResponse> {
    return this.auth.refreshTokens(body.refreshToken, requestContext(req));
  }

  @RateLimit({ name: 'auth-default-user', tracker: 'user', limit: 120, windowMs: MINUTE_MS })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: LogoutRequestDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @RateLimit({ name: 'auth-default-user', tracker: 'user', limit: 120, windowMs: MINUTE_MS })
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  mfaSetup(@CurrentUser() user: AuthenticatedUser): Promise<MfaSetupResponse> {
    return this.auth.startMfaEnrollment(user.userId);
  }

  @RateLimit({ name: 'auth-default-user', tracker: 'user', limit: 120, windowMs: MINUTE_MS })
  @Post('mfa/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async mfaConfirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaConfirmRequestDto,
  ): Promise<void> {
    await this.auth.confirmMfaEnrollment(user.userId, body.secretBase32, body.code);
  }

  @RateLimit({ name: 'auth-default-user', tracker: 'user', limit: 120, windowMs: MINUTE_MS })
  @Post('mfa/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  async mfaVerify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaVerifyRequestDto,
  ): Promise<void> {
    await this.auth.verifyMfaCode(user.userId, body.code);
  }

  @RateLimit({ name: 'auth-default-user', tracker: 'user', limit: 120, windowMs: MINUTE_MS })
  @Post('mfa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async mfaDisable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaDisableRequestDto,
  ): Promise<void> {
    await this.auth.disableMfa(user.userId, body.code);
  }
}

function requestContext(req: FastifyRequest): AuthRequestContext {
  const ua = req.headers['user-agent'];
  return {
    ...(typeof req.ip === 'string' && req.ip.length > 0 ? { ipAddress: req.ip } : {}),
    ...(typeof ua === 'string' && ua.length > 0 ? { userAgent: ua } : {}),
  };
}
