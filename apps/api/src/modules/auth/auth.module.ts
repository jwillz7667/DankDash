/**
 * Auth feature module — wires the orchestrating AuthService and AuthController,
 * and exports the JwtAuthGuard so the root composition can bind it globally.
 *
 * Imports composition:
 *   - PasswordModule  → PasswordService (argon2id + HMAC pepper)
 *   - AuthJwtModule   → JwtService + RefreshTokenService + SessionsRepository
 *   - MfaModule       → MfaService + UsersRepository
 *
 * MfaModule re-exports UsersRepository (it provides the singleton); AuthService
 * pulls the same instance through DI so register / login share the row with
 * MFA reads instead of constructing a parallel repo from the pool.
 */
import { UsersRepository } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthController } from './auth.controller.js';
import { AuthService, type AuthServiceConfig } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { CheckoutHandoffModule } from './handoff/checkout-handoff.module.js';
import { AuthJwtModule } from './jwt/jwt.module.js';
import { JwtService } from './jwt/jwt.service.js';
import { RefreshTokenService } from './jwt/refresh-token.service.js';
import { MfaModule } from './mfa/mfa.module.js';
import { MfaService } from './mfa/mfa.service.js';
import { PasswordModule } from './password/password.module.js';
import { PasswordService } from './password/password.service.js';

const authServiceProvider: FactoryProvider<AuthService> = {
  provide: AuthService,
  inject: [
    UsersRepository,
    PasswordService,
    JwtService,
    RefreshTokenService,
    MfaService,
    EventEmitter2,
    ConfigService,
  ],
  useFactory: (
    users: UsersRepository,
    password: PasswordService,
    jwt: JwtService,
    refresh: RefreshTokenService,
    mfa: MfaService,
    events: EventEmitter2,
    config: ConfigService,
  ): AuthService => {
    const cfg: AuthServiceConfig = {
      accessTtlSeconds: Number(config.getOrThrow<string | number>('JWT_ACCESS_TTL_SECONDS')),
    };
    return new AuthService(users, password, jwt, refresh, mfa, events, cfg);
  },
};

@Module({
  imports: [PasswordModule, AuthJwtModule, MfaModule, CheckoutHandoffModule],
  controllers: [AuthController],
  providers: [authServiceProvider, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtAuthGuard, RolesGuard, MfaModule, AuthJwtModule, CheckoutHandoffModule],
})
export class AuthModule {}
