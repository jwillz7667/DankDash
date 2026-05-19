/**
 * Cart compliance-preview DTOs.
 *
 *   POST /v1/carts/:id/validate?deliveryAddressId=...   — ValidateCartResponse
 *
 * The validate endpoint exposes the @dankdash/compliance engine's pure
 * `evaluateCart` result over HTTP. It exists for the iOS client to render
 * a precise pre-checkout preview — "you can still add 12g of flower",
 * "this address is outside our delivery zone", "the store is closed
 * until 8 AM" — without speculatively building an order. The endpoint is
 * read-only and idempotent; clients call it on every cart-altering
 * interaction, so it must be cheap.
 *
 * Query (not body) carries the address selection because validate is a
 * GET-shaped operation conceptually — it's a "what would happen if I
 * tried this?" question. POST is used only because Nest's Fastify
 * adapter does not surface query params on GETs cleanly when the route
 * already takes a path id. Future revisions can move to GET freely
 * without a wire-shape change: the same query schema applies.
 *
 * The response schema mirrors `ComplianceEvaluation` from the engine
 * one-for-one (rule list, cart totals, statutory limits, evaluation
 * stamp). It carries plain primitives — no `Decimal`, no `Date`, no
 * class instances — because the same shape is what the checkout
 * transaction snapshots onto `orders.compliance_check_payload` as JSONB
 * (Phase 5.3); the persisted snapshot must round-trip through JSON
 * without information loss so a future auditor replaying an old order
 * sees what the engine actually decided.
 *
 * Rule details are typed as `z.record(z.unknown())` because the engine
 * intentionally varies the per-rule details payload by rule id (the
 * geofence rule carries `{ latitude, longitude, polygon }`, the
 * per-transaction-limit rule carries `{ flowerGramsOver, ... }`, etc.).
 * The wire contract is "JSON-serializable map"; the iOS client
 * discriminates on `rule` and reads the keys it knows about for that
 * rule, ignoring the rest.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Mirrors `RuleId` from @dankdash/compliance — the union of all rule
 * names plus the `evaluation` sentinel emitted when the engine itself
 * fails closed (an exception escapes a rule). Kept in sync manually: a
 * new rule in the engine requires adding it here and shipping a
 * coordinated client release. The compliance unit tests assert the
 * engine produces every member of this union across the test corpus.
 */
export const RuleIdSchema = z.enum([
  'age',
  'kyc',
  'dispensary_license',
  'hours',
  'delivery_geofence',
  'per_transaction_limit',
  'product_provenance',
  'evaluation',
]);

export const RuleResultSchema = z
  .object({
    rule: RuleIdSchema,
    passed: z.boolean(),
    details: z.record(z.unknown()),
  })
  .strict();

export const ComplianceTotalsSnapshotSchema = z
  .object({
    flowerGrams: z.number().nonnegative(),
    concentrateGrams: z.number().nonnegative(),
    edibleThcMg: z.number().nonnegative(),
  })
  .strict();

export const ComplianceLimitsSnapshotSchema = z
  .object({
    flowerGramsMax: z.number().positive(),
    concentrateGramsMax: z.number().positive(),
    edibleThcMgMax: z.number().positive(),
  })
  .strict();

export const ValidateCartQuerySchema = z
  .object({
    deliveryAddressId: z.string().uuid(),
  })
  .strict();

export type ValidateCartQuery = z.infer<typeof ValidateCartQuerySchema>;

export class ValidateCartQueryDto extends createZodDto(ValidateCartQuerySchema) {}

export const ValidateCartResponseSchema = z
  .object({
    passed: z.boolean(),
    rules: z.array(RuleResultSchema).readonly(),
    cartTotals: ComplianceTotalsSnapshotSchema,
    limits: ComplianceLimitsSnapshotSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
    evaluationVersion: z.string().min(1),
  })
  .strict();

export type ValidateCartResponse = z.infer<typeof ValidateCartResponseSchema>;
