/**
 * Provider tokens + minimal interface types shared by the module wiring
 * and the controllers. Keeping them in a leaf file breaks the
 * `module.ts ↔ controller.ts` import cycle that would otherwise form
 * (the controllers inject by token; the module composes them).
 *
 * The `*Like` interfaces narrow the surface the controllers depend on so
 * tests can pass hand-rolled fakes without satisfying the full Aeropay
 * class hierarchy.
 */
import type { AeropayClient, AeropayWebhookOutcome } from '@dankdash/aeropay';

export const AEROPAY_CLIENT = Symbol.for('AEROPAY_CLIENT');
export const AEROPAY_WEBHOOK_VERIFIER = Symbol.for('AEROPAY_WEBHOOK_VERIFIER');

export interface AeropayWebhookVerifierLike {
  verify(rawBody: string, signatureHeader: string): AeropayWebhookOutcome;
}

export type AeropayClientLike = Pick<
  AeropayClient,
  | 'linkBankAccount'
  | 'getBankAccount'
  | 'createPayment'
  | 'getPayment'
  | 'cancelPayment'
  | 'refundPayment'
  | 'createPayout'
>;
