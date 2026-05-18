/**
 * Persona KYC module. Wires PersonaService from the validated env (api key,
 * template id, webhook secret) and exports it for the identity controller
 * (Phase 2.7) to consume. The hosted-flow base URL and api base URL default
 * to Persona's production endpoints; tests inject overrides directly into
 * the service constructor.
 */
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PersonaService, type PersonaServiceConfig } from './persona.service.js';

const personaServiceProvider: FactoryProvider<PersonaService> = {
  provide: PersonaService,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PersonaService => {
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
