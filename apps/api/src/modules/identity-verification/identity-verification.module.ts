/**
 * Identity verification module — owns the Veriff API client.
 *
 * Veriff is the driver-handoff ID-scan provider (Phase 20 §20.3 / spec
 * §6.2). The consumer-side onboarding KYC uses Persona via
 * `IdentityModule` — separate provider, separate trust policy: Persona
 * is a one-shot at signup, Veriff fires every delivery, and the
 * compliance gate at handoff is mandatory and non-bypassable.
 *
 * Only the I/O surface lives here. The orchestration that mutates an
 * order's id-scan state on a successful decision (`age_verifications`
 * insert + orders patch + status transition) lives in
 * `DriverIdScanService` inside `DriversModule` — that's the module
 * that owns the order-row writes. Splitting the client from the
 * orchestration keeps the dependency graph one-way (drivers →
 * identity-verification) and avoids a forwardRef cycle.
 *
 * The webhook controller is also in DriversModule for the same reason
 * — see `apps/api/src/modules/drivers/controllers/veriff-webhook.controller.ts`.
 */
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VeriffClient, type VeriffClientConfig } from './veriff.client.js';

const veriffClientProvider: FactoryProvider<VeriffClient> = {
  provide: VeriffClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService): VeriffClient => {
    // exactOptionalPropertyTypes: build the object then attach apiBaseUrl
    // only when actually present, so we never assign `undefined` to an
    // optional readonly slot.
    const cfg: { -readonly [K in keyof VeriffClientConfig]: VeriffClientConfig[K] } = {
      apiKey: config.getOrThrow<string>('VERIFF_API_KEY'),
      secret: config.getOrThrow<string>('VERIFF_WEBHOOK_SECRET'),
    };
    const baseUrl = config.get<string>('VERIFF_API_BASE_URL');
    if (baseUrl !== undefined) cfg.apiBaseUrl = baseUrl;
    return new VeriffClient(cfg);
  },
};

@Module({
  providers: [veriffClientProvider],
  exports: [VeriffClient],
})
export class IdentityVerificationModule {}
