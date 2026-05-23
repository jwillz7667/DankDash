/**
 * Persona KYC module. Wires PersonaService from the validated env (api key,
 * template id, webhook secret) and exports it for the identity controller
 * (Phase 2.7) to consume. The hosted-flow base URL and api base URL default
 * to Persona's production endpoints; tests inject overrides directly into
 * the service constructor.
 *
 * When `ENABLE_PERSONA=false` the factory yields a disabled proxy in place
 * of the real service so the DI graph is satisfied without requiring the
 * `PERSONA_*` credentials at module construction. Any actual call on the
 * proxy throws `FeatureDisabledError`, which surfaces to the client as
 * `503 FEATURE_DISABLED`.
 */
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDisabledFeatureProxy } from '../../../common/disabled-feature.proxy.js';
import { PersonaService, type PersonaServiceConfig } from './persona.service.js';

const personaServiceProvider: FactoryProvider<PersonaService> = {
  provide: PersonaService,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PersonaService => {
    if (!config.getOrThrow<boolean>('ENABLE_PERSONA')) {
      return createDisabledFeatureProxy<PersonaService>('persona');
    }
    const cfg: PersonaServiceConfig = {
      apiKey: config.getOrThrow<string>('PERSONA_API_KEY'),
      templateId: config.getOrThrow<string>('PERSONA_TEMPLATE_ID'),
      webhookSecret: config.getOrThrow<string>('PERSONA_WEBHOOK_SECRET'),
    };
    return new PersonaService(cfg);
  },
};

@Module({
  providers: [personaServiceProvider],
  exports: [PersonaService],
})
export class PersonaModule {}
