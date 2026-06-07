/**
 * /v1/auth/* password-reset surface. Kept in its own controller (rather than
 * on AuthController) so this feature can depend on the NotificationDispatcher
 * without AuthModule taking an import cycle with NotificationsModule.
 *
 *   POST /v1/auth/forgot-password — Public. Starts the email-delivered reset.
 *                                   Always 202 with no body, even for unknown
 *                                   emails (enumeration-safe).
 *   POST /v1/auth/reset-password  — Public. Redeems a code + sets a new
 *                                   password; 204 No Content on success.
 *
 * Both routes are aggressively rate-limited: forgot-password per-IP AND
 * per-email (so a rotating IP pool can't flood one mailbox), reset-password
 * per-IP (the code is the only body identifier and is high-entropy, so an
 * IP-scoped ceiling is enough to make online guessing hopeless).
 *
 * forgot-password dispatches the reset work WITHOUT awaiting it and returns 202
 * immediately. That is what makes the route constant-time: a real account does
 * DB writes + an inline email-provider call (hundreds of ms) that an unknown
 * address skips, so awaiting that work would turn response latency into an
 * account-enumeration oracle. 202 ("accepted, processing async") is the honest
 * contract — the client polls its mailbox, not the HTTP response, for the code.
 */
import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { ForgotPasswordRequestDto, ResetPasswordRequestDto } from './dto/index.js';
import { PasswordResetService } from './password-reset.service.js';
import type { FastifyRequest } from 'fastify';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

@Controller('auth')
export class PasswordResetController {
  private readonly logger = new Logger(PasswordResetController.name);

  constructor(private readonly passwordReset: PasswordResetService) {}

  @Public()
  @RateLimit(
    { name: 'auth-forgot-password-ip', tracker: 'ip', limit: 5, windowMs: MINUTE_MS },
    { name: 'auth-forgot-password-email', tracker: 'email-from-body', limit: 5, windowMs: HOUR_MS },
  )
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(@Body() body: ForgotPasswordRequestDto, @Req() req: FastifyRequest): void {
    const ipAddress = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : undefined;
    // Fire-and-forget: returning before the work runs keeps response latency
    // independent of whether the account exists (see file header). The service
    // swallows its own eligible-branch failures; this catch only covers an
    // error before the account is known (e.g. the lookup), and is logged
    // without the email so it can't become an error oracle either.
    void this.passwordReset
      .requestReset(body.email, ipAddress !== undefined ? { ipAddress } : {})
      .catch((err: unknown) => {
        this.logger.error(
          'forgot-password background processing failed',
          err instanceof Error ? err.stack : String(err),
        );
      });
  }

  @Public()
  @RateLimit({ name: 'auth-reset-password-ip', tracker: 'ip', limit: 10, windowMs: MINUTE_MS })
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() body: ResetPasswordRequestDto): Promise<void> {
    await this.passwordReset.resetPassword(body.code, body.newPassword);
  }
}
