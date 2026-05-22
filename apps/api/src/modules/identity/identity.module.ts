/**
 * Identity feature module — composes IdentityService over the shared
 * UsersRepository (provided by AuthModule's MfaModule) and PersonaService
 * (provided by PersonaModule), and mounts both the user-facing controller
 * and the Persona webhook controller.
 *
 * IdentityModule deliberately imports AuthModule (not MfaModule directly)
 * so the global JwtAuthGuard + decorators remain the only auth surface a
 * feature module touches. AuthModule re-exports UsersRepository through
 * MfaModule, which keeps the repo a true singleton across the app.
 */
import {
  DispensariesRepository,
  DispensaryStaffRepository,
  UsersRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
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

@Module({
  imports: [AuthModule, PersonaModule],
  controllers: [IdentityController, KycWebhookController],
  providers: [
    dispensaryStaffRepositoryProvider,
    dispensariesRepositoryProvider,
    identityServiceProvider,
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
