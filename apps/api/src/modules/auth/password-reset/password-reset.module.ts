/**
 * Password-reset feature module.
 *
 * Stands alone rather than folding into AuthModule because it needs the
 * NotificationDispatcher to email codes, and NotificationsModule already
 * imports AuthModule — making this part of AuthModule would create an import
 * cycle. As a leaf consumer of both NotificationsModule (for the dispatcher)
 * and PasswordModule (for argon2 hashing) it avoids that entirely.
 *
 * Repositories are constructed from the global Drizzle pool via the same
 * FactoryProvider pattern the other feature modules use; repos are stateless
 * wrappers, so a per-module instance is fine.
 */
import {
  PasswordResetTokensRepository,
  SessionsRepository,
  UsersRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher.service.js';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { PasswordModule } from '../password/password.module.js';
import { PasswordService } from '../password/password.service.js';
import { PasswordResetController } from './password-reset.controller.js';
import { PasswordResetService } from './password-reset.service.js';

const TOKEN_TTL_MINUTES = 15;

const usersRepoProvider: FactoryProvider<UsersRepository> = {
  provide: UsersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): UsersRepository => new UsersRepository(db),
};

const sessionsRepoProvider: FactoryProvider<SessionsRepository> = {
  provide: SessionsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): SessionsRepository => new SessionsRepository(db),
};

const tokensRepoProvider: FactoryProvider<PasswordResetTokensRepository> = {
  provide: PasswordResetTokensRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): PasswordResetTokensRepository =>
    new PasswordResetTokensRepository(db),
};

const passwordResetServiceProvider: FactoryProvider<PasswordResetService> = {
  provide: PasswordResetService,
  inject: [
    UsersRepository,
    PasswordResetTokensRepository,
    SessionsRepository,
    PasswordService,
    NotificationDispatcher,
  ],
  useFactory: (
    users: UsersRepository,
    tokens: PasswordResetTokensRepository,
    sessions: SessionsRepository,
    password: PasswordService,
    dispatcher: NotificationDispatcher,
  ): PasswordResetService =>
    new PasswordResetService({
      users,
      tokens,
      sessions,
      password,
      dispatcher,
      config: { tokenTtlMinutes: TOKEN_TTL_MINUTES },
    }),
};

@Module({
  imports: [NotificationsModule, PasswordModule],
  controllers: [PasswordResetController],
  providers: [
    usersRepoProvider,
    sessionsRepoProvider,
    tokensRepoProvider,
    passwordResetServiceProvider,
  ],
  exports: [PasswordResetService],
})
export class PasswordResetModule {}
