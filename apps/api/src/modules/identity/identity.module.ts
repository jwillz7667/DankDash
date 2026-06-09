/**
 * Identity feature module — composes IdentityService over the shared
 * UsersRepository (provided by AuthModule's MfaModule) and PersonaService
 * (provided by PersonaModule), and mounts the user-facing controller, the
 * addresses CRUD surface, and the Persona webhook controller.
 *
 * IdentityModule deliberately imports AuthModule (not MfaModule directly)
 * so the global JwtAuthGuard + decorators remain the only auth surface a
 * feature module touches. AuthModule re-exports UsersRepository through
 * MfaModule, which keeps the repo a true singleton across the app.
 *
 * AddressesService uses the FactoryProvider + scoped-repos closure pattern
 * (CartModule + OrdersModule) — the DI container supplies the singleton
 * Database, the factory closes over the repo constructor so a future
 * transactional wrapper can hand in a tx-bound Database and get the same
 * repo keyed to the transaction. IdentityService keeps the direct-inject
 * pattern because UsersRepository is already a true singleton in this
 * module graph.
 */
import {
  DispensariesRepository,
  DispensaryStaffRepository,
  OrdersRepository,
  PasswordResetTokensRepository,
  PaymentMethodsRepository,
  SessionsRepository,
  UserAddressesRepository,
  UsersRepository,
  WebhookEventsProcessedRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  AccountDeletionService,
  type AccountDeletionScopedRepos,
} from './account-deletion.service.js';
import { AddressesController } from './addresses.controller.js';
import { AddressesService, type AddressesScopedRepos } from './addresses.service.js';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { KycWebhookController } from './kyc-webhook.controller.js';
import { PersonaModule } from './persona/persona.module.js';
import { PersonaService } from './persona/persona.service.js';

const dispensaryStaffRepositoryProvider: FactoryProvider<DispensaryStaffRepository> = {
  provide: DispensaryStaffRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensaryStaffRepository => new DispensaryStaffRepository(db),
};

const dispensariesRepositoryProvider: FactoryProvider<DispensariesRepository> = {
  provide: DispensariesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensariesRepository => new DispensariesRepository(db),
};

const webhookEventsRepositoryProvider: FactoryProvider<WebhookEventsProcessedRepository> = {
  provide: WebhookEventsProcessedRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): WebhookEventsProcessedRepository =>
    new WebhookEventsProcessedRepository(db),
};

const identityServiceProvider: FactoryProvider<IdentityService> = {
  provide: IdentityService,
  inject: [UsersRepository, PersonaService, DispensaryStaffRepository, DispensariesRepository],
  useFactory: (
    users: UsersRepository,
    persona: PersonaService,
    dispensaryStaff: DispensaryStaffRepository,
    dispensaries: DispensariesRepository,
  ): IdentityService => new IdentityService(users, persona, dispensaryStaff, dispensaries),
};

const addressesServiceProvider: FactoryProvider<AddressesService> = {
  provide: AddressesService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): AddressesService =>
    new AddressesService(
      db,
      (scopedDb): AddressesScopedRepos => ({
        userAddresses: new UserAddressesRepository(scopedDb),
      }),
    ),
};

const accountDeletionServiceProvider: FactoryProvider<AccountDeletionService> = {
  provide: AccountDeletionService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): AccountDeletionService =>
    new AccountDeletionService(
      db,
      (scopedDb): AccountDeletionScopedRepos => ({
        users: new UsersRepository(scopedDb),
        sessions: new SessionsRepository(scopedDb),
        passwordResetTokens: new PasswordResetTokensRepository(scopedDb),
        userAddresses: new UserAddressesRepository(scopedDb),
        paymentMethods: new PaymentMethodsRepository(scopedDb),
        orders: new OrdersRepository(scopedDb),
      }),
    ),
};

@Module({
  imports: [AuthModule, PersonaModule],
  controllers: [IdentityController, KycWebhookController, AddressesController],
  providers: [
    dispensaryStaffRepositoryProvider,
    dispensariesRepositoryProvider,
    webhookEventsRepositoryProvider,
    identityServiceProvider,
    addressesServiceProvider,
    accountDeletionServiceProvider,
  ],
  exports: [IdentityService, AddressesService, AccountDeletionService],
})
export class IdentityModule {}
