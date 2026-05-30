# ADR 0007 — Phase 20 driver delivery flow: ID-scan compliance gate, Veriff SDK seam, MKDirections, Aeropay stub

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** ADR 0005 (MapKit over Mapbox for consumer tracking) — same reasoning extended to the driver-side turn-by-turn surface.

## Context

Phase 20 (`docs/CLAUDE-CODE-PHASES.md` §20) lights up the driver-side delivery lifecycle: dispatched offer → accept → en-route to pickup → confirm pickup → en-route to dropoff → ID scan at handoff → delivery confirmed → earnings. Five reducer-level features land on the iOS side (`DispatchOfferFeature`, `ActiveRouteFeature`, `IDScanFeature`, `DeliveryCompleteFeature`, plus the `EarningsWalletFeature` cashout extension). On the backend, four endpoint surfaces land: driver-self order detail, pickup-/delivery-confirm with state transitions, a Veriff session/result/webhook trio for the identity-verification check, and a cashout request endpoint.

The spec carries one non-negotiable rule that drives most of Phase 20's architecture: **the driver ID scan at handoff is mandatory and non-bypassable per Minn. Stat. § 342.46 / spec §6.2.** A delivered order without a successful Veriff verification on file is a compliance violation. The system has to make that physically impossible, not merely conventionally enforced.

Four cross-cutting decisions had to land together. This ADR captures all four so future phases can refer to a single rationale.

## Decisions

### Decision 1 — ID-scan compliance gate fires inside `OrdersRepository.transitionStatus`, not at the service layer

The check that prevents an order from reaching `status = 'delivered'` without `delivery_id_scan_passed = true` lives inside the repository's `transitionStatus()`, **not** at the service layer where the user-facing 409 is rendered. The service layer also checks, but the repository check is the one we audit against.

```ts
// packages/db/src/repositories/orders.repo.ts
if (input.toStatus === 'delivered' && current.deliveryIdScanPassed !== true) {
  throw new ConflictError(
    'COMPLIANCE_ID_SCAN_REQUIRED',
    `order ${input.orderId} cannot transition to delivered without a successful ID scan`,
    { orderId: input.orderId },
  );
}
```

Rationale:

- **Defense in depth.** A future caller — a worker, an admin script, a follow-up phase's new endpoint, an LLM-authored fix — that calls `transitionStatus(orderId, { toStatus: 'delivered' })` directly without going through `DriverOrdersService.deliveryConfirm()` will still be blocked. The gate sits at the same layer as the FROM-state guard and the row-level `FOR UPDATE` lock, which means a single transaction does the read-locked check + the gate + the write atomically. There's no TOCTOU window where the scan column flips between a service-layer check and the repository write.
- **Same lock that serializes concurrent transitions.** The pre-read uses `FOR UPDATE` to serialize two drivers (or a driver + an admin) racing on the same order. The ID-scan gate piggybacks on that already-acquired row lock — no extra round trip, no extra lock contention.
- **The error code is stable and structured.** `ConflictError('COMPLIANCE_ID_SCAN_REQUIRED', …)` lands as a structured 409 envelope at the global exception filter. iOS surfaces a "Complete the ID scan to mark delivery" toast keyed on the code; ops dashboards can alert on `COMPLIANCE_ID_SCAN_REQUIRED` rate as a leading indicator of broken Veriff flow rather than a 500-noise haystack.
- **Auditors read the repository, not the service.** Compliance audits trace from the database schema upward. A gate at the repository is reachable in one hop from `schema.ts`; a gate at the service is two hops and easier to miss. The CHECK constraint approach (a `CHECK (status != 'delivered' OR delivery_id_scan_passed = true)`) was considered, but it would race with the trigger-driven `order_events` insert in the same transaction and would require a deferred constraint — a less readable path. The application-layer check inside the repository is the same guarantee with clearer prose.

The downside: the repository now carries domain-shaped logic (a compliance rule, not just an invariant on schema). Mitigated by keeping the rule's authority centralized in `@dankdash/compliance` — Phase 3's pure-function engine still owns the "is this cart legal" decision; the repository owns only the **post-evaluation persistence invariant** ("a delivered order has a scan recorded"). The two are different concerns and live in different files.

### Decision 2 — `IdentityVerificationClient` is the SDK seam; `.live` wraps the Veriff iOS SDK, `.testValue` is a deterministic mock

```swift
public struct IdentityVerificationClient: Sendable {
  public var launchSDK: @Sendable (_ session: IDScanSession) async -> IDScanSDKOutcome
}
```

The SDK is the only thing this client exists for. The session-mint and result-poll API calls are owned by `DriverIDScanAPIClient` (a sibling `@DependencyClient` over `APIClient`); the realtime poll → webhook convergence is owned by the backend. The `IdentityVerificationClient` exists purely to keep the SDK off the test path.

Rationale:

- **`swift test --package-path DankDashKit --parallel` must stay simulator-only and deterministic.** Touching a real Veriff endpoint from CI would (a) burn sandbox API quota on every push, (b) introduce network flakiness, (c) make local-machine `swift test` runs hostile to airplane-mode work. The `.testValue` returns whatever the `TestStore` arranged.
- **`.live` instantiates `Veriff` (the SDK class) inside `launchSDK` from a hosting `UIViewController` resolved via `UIViewControllerRepresentable` in `IDScanLaunchView`.** SDK callbacks (`done`, `canceled`, `error`) map to `IDScanSDKOutcome.completed | .canceled | .error(reason)`. The reducer is unaware of which Veriff method was called or which UIKit object hosted the presentation — it just receives an outcome.
- **`.unimplemented` is the package's `testValue`; concrete tests inject their own closure-backed instance.** Per the project's `@DependencyClient` convention from Phase 0, an un-stubbed call inside a test crashes loud rather than returning a default. Phase 20 reducer tests pass an explicit closure that returns `.completed(verificationId: …)`, `.canceled`, or `.error(reason:)` as the test arranges; this is the same shape every other Phase 20 dependency uses.
- **Sandbox vs production is a config knob, not a code branch.** `VeriffConfig.current()` picks the API key at runtime from xcconfig → `Info.plist` → bundle key chain in priority order; the same `.live` instance services both. Phase 20 ships with the sandbox key in `Debug` and a production key injected at archive time via the CI secret — no `#if RELEASE` branches inside the client.

The Veriff iOS SDK adds an additional SwiftPM dependency on the `DankDashFeatures` target (Veriff package, `5.x`). The consumer app picks it up as a transitive — bundle-size cost accepted; we reassess if it ever exceeds 5 MB.

### Decision 3 — MKDirections via `DirectionsClient`; no third-party navigation SDK

Apple's `MKDirections` covers turn-by-turn for the Phase-20 MN delivery footprint. ADR 0005 documents the MapKit-over-Mapbox choice for consumer tracking; this ADR extends that decision to the driver-side navigation surface.

```swift
public struct DirectionsClient: Sendable {
  public var calculateRoute: @Sendable (_ from: Coordinate, _ to: Coordinate, _ transportType: TransportType) async throws -> RouteDirections
  public var liveSteps: @Sendable (_ route: RouteDirections, _ locations: AsyncStream<Coordinate>) -> AsyncStream<RouteStep>
}
```

`liveSteps` is a transducer over the location stream from `BackgroundLocationClient` — it watches the driver's position, identifies the current `MKRoute.Step`, and yields the next-instruction update. The view binds to the `AsyncStream` and the reducer never touches a `CLLocationCoordinate2D`.

Rationale:

- **No second nav SDK in the binary.** Mapbox nav, Google Directions, HERE — each would add 5–15 MB to the driver app, a separate API key surface, and a billing relationship. The urban MN footprint we deliver into (Twin Cities + Moorhead) doesn't need lane guidance, AR turn arrows, or traffic-optimized rerouting — MKDirections is sufficient.
- **One coordinate-system boundary.** `Coordinate` is the only location value type the reducer ever sees. `CLLocationCoordinate2D` leaks only into `BackgroundLocationClient.live`, `DirectionsClient.live`, and the `UIViewRepresentable` wrappers that touch `MKMapView` directly. This is the same boundary discipline ADR 0005 set for the consumer app.
- **Recomputing on each leg is cheap.** On Confirm Pickup the reducer flips `currentLeg = .toDropoff` and refetches directions; on Arrived it tears down the location subscription. MKDirections returns in < 200 ms in the cities we ship to. We never cache a polyline across legs or pre-fetch — the next leg's geometry is genuinely different (different endpoint), so caching would be optimization for an absent problem.
- **Test seam.** `.testValue` yields a fixed `RouteDirections` and a fixed `AsyncStream<RouteStep>`; reducer tests assert on `currentStep` after feeding synthetic coordinates. No `MKMapView` instantiated inside `swift test`.

If the delivery footprint expands beyond MN (e.g. into rural WI), revisit. The MapKit decision is contingent on the urban-grid coverage we have today.

### Decision 4 — Aeropay cashout shipped as a real `payouts` row + a stub Aeropay client; real Aeropay integration paired with the KYC phase

Phase 20 ships:

- A `POST /v1/driver/cashout` endpoint that validates the requested amount against the driver's earned-but-unsettled balance (against the `payments` ledger from Phase 5/6), opens a transaction, inserts a `payouts` row with `method = 'aeropay'` and `status = 'requested'`, and returns the row.
- An `AeropayDriverPayoutGateway` class with a `dispatch()` method behind `AEROPAY_LIVE = false`. When the flag is off, it logs the request and returns success without calling Aeropay. When the flag flips on (a future phase), the same method body is replaced with the actual Aeropay API call — the gateway interface stays stable.
- The persisted `payouts` row lets ops manually process cashouts via Aeropay's portal until the real integration lands. Status transitions (`requested → processing → succeeded / failed`) are written by a worker once the integration lands — the schema and the request row already exist today.

Rationale:

- **Real Aeropay needs production credentials paired with a KYC step that doesn't exist yet.** Aeropay requires the recipient to be KYC-verified on Aeropay's side (TIN, bank account verification, IRS 1099-K thresholding). That's a separate user-onboarding flow that doesn't fit in Phase 20's scope. Shipping a real Aeropay integration without the recipient-side KYC would either silently fail or, worse, succeed for some drivers and not others, with no clear UX path.
- **Persistence over passthrough.** A "Cashout" button that 200s without persisting the request would be worse than not having the button — drivers would tap it and have no record. The Phase-20 implementation persists the request the second the driver taps Cashout; ops sees it in the dashboard the same minute. The actual disbursement runs out of band.
- **`AEROPAY_LIVE` flag is the only branch.** The gateway interface is the same shape in stub and live mode (`async dispatch(request: CashoutRequest): Promise<DispatchResult>`); flipping the flag swaps the implementation without touching call sites. Phase-20 tests assert on the request-row shape and the stub gateway's call signature; the live path is unit-tested when it lands.
- **The earnings balance check is real.** The service computes available balance against the `payments` ledger (Phase 5/6 work) every request — a driver cannot cashout more than they've earned. The stub-Aeropay decision affects only the disbursement leg, not the eligibility / accounting layer.

The downside: a driver hits "Cashout" and sees "Request submitted — funds arrive in 1-2 business days," but the actual disbursement is manual until the live integration lands. Mitigated by ops processing within 1 business day and by the in-app messaging being honest about timing. Once `AEROPAY_LIVE = true`, the same UX is unchanged; the disbursement is just automatic.

## Consequences

**Positive.**

- The compliance gate is reachable from every code path that mutates order status — including ones we haven't written yet. The non-bypassable rule from spec §6.2 is enforced at the same layer as schema invariants.
- The Veriff SDK never instantiates inside `swift test`. CI stays simulator-only; local-machine tests run airplane-mode-friendly. The `IdentityVerificationClient` seam means a future swap to a different identity provider (e.g. Persona at handoff instead of signup) is a one-file change.
- The driver app stays at the same SDK footprint as the consumer (modulo Veriff). No second nav SDK; no second map SDK; one coordinate type at every reducer boundary.
- Drivers can request a cashout the day Phase 20 ships. The disbursement workflow is manual at first and automatic after the Aeropay-live phase — but the user-facing surface and the persistence path are the same in both modes.

**Negative / costs.**

- **Repository carries a domain rule.** `transitionStatus` now embeds knowledge of the ID-scan column. Future repository-layer refactors must preserve this gate. Mitigation: the rule is documented in the method's JSDoc and covered by a dedicated repository unit test; a refactor that removes the gate will fail CI.
- **`AEROPAY_LIVE = false` is a config-bound feature.** Drivers in dev/staging environments see successful cashout requests that don't actually disburse. Mitigation: the dev environment has its own `payouts` table; nothing crosses into a real Aeropay account.
- **Veriff sandbox accepts any submitted ID.** The sandbox flow is end-to-end real (SDK launches, captures, posts to Veriff, webhook fires) but the verification decision is always "approved." This is the right trade-off for dev/staging — production keys deliver real verification — but a developer must remember that a green "passed" screen in dev does not mean the Veriff decision logic is exercised. Mitigation: the `driver-id-scan.service.ts` unit tests cover both `approved` and `declined` webhook bodies against the gate, so the decision path is exercised even though the sandbox SDK doesn't.
- **MKDirections has no offline tiles or lane guidance.** A driver in a poor-signal area gets cached fallback only. Mitigation: the route is computed on accept (foreground, presumably good signal) and stored in reducer state for the duration of the leg.

## Implementation references

- `packages/db/src/repositories/orders.repo.ts` — `transitionStatus()`; ID-scan gate at the `FOR UPDATE` block.
- `packages/db/src/migrations/0005_phase20_id_scan_idempotency.sql` — `age_verifications (provider, provider_session_id)` uniqueness + partial index on `orders.delivery_id_scan_ref`.
- `apps/api/src/modules/identity-verification/veriff.client.ts` — HMAC-SHA256 signed Veriff API client + webhook signature verification with constant-time compare.
- `apps/api/src/modules/drivers/controllers/veriff-webhook.controller.ts` — `POST /v1/webhooks/veriff` — raw-body HMAC verification + dispatch to `DriverIdScanService.applyWebhookDecision()`.
- `apps/api/src/modules/drivers/services/driver-id-scan.service.ts` — session lifecycle, polled-result write, webhook-driven write; idempotent on `(provider, provider_session_id)`.
- `apps/api/src/modules/drivers/services/driver-orders.service.ts` — `pickupConfirm` / `deliveryConfirm`; the latter catches `COMPLIANCE_ID_SCAN_REQUIRED` and returns a structured 409.
- `apps/api/src/modules/drivers/services/aeropay-driver-payout.gateway.ts` — Aeropay-stub gateway behind `AEROPAY_LIVE` env flag.
- `DankDashKit/Sources/DankDashFeatures/Dependencies/IdentityVerificationClient.swift` — SDK seam (one closure: `launchSDK`).
- `DankDashKit/Sources/DankDashFeatures/Dependencies/DirectionsClient.swift` — `MKDirections` wrapper, `liveSteps` AsyncStream transducer.
- `DankDashKit/Sources/DankDashFeatures/IDScan/IDScanFeature.swift` — three-state reducer (`.notStarted | .sdkInProgress | .awaitingResult | .passed | .failed(reason)`); orchestrates session-start → SDK launch → result-poll → gate.
- `DankDashKit/Sources/DankDashFeatures/ActiveRoute/ActiveRouteFeature.swift` — route fetch + leg flipping + `currentStep` derivation from the live location stream.
- `DankDashKit/Sources/DankDashFeatures/DispatchOffer/DispatchOfferFeature.swift` — countdown ring, accept/decline POST, `unavailable` 409 handling for "offer taken by another driver."

## Open items deferred to later phases

- **`AEROPAY_LIVE = true` + driver-side Aeropay KYC** — pairs with a future KYC phase. The gateway interface and the `payouts` row shape stay unchanged.
- **`/driver` Socket.io namespace activation** — Phase 22 lights it; the `OfferSubscriptionClient` polling fallback in Phase 20 is the bridge until then. The reducer interface is unchanged when the socket lights up — `subscribe()` swaps the polling stream for a socket stream behind the same `AsyncStream<DispatchOffer>` boundary.
- **APNs critical-alert offer delivery on locked device** — Phase 21. Phase 20 offers are foreground-only; APNs receive-side wiring is in `DankDasher/App/AppDelegate.swift` but the critical-alert entitlement and the lockscreen offer card UX land in Phase 21.
- **Veriff production keys** — sandbox-only in Phase 20. The `.live` config picks the production key when an xcconfig-injected `VERIFF_PRODUCTION_API_KEY` is present, otherwise falls back to sandbox. Production cutover is a build-config swap; no code change needed.
- **Driver chat with customer** — out of spec scope for Phase 20. The driver card on the consumer side carries a tap-to-call masked-phone, which is the Phase-18 surface; Phase 20 doesn't add anything to the chat surface.
- **Background offer presentation polish** — current foreground UX is the offer card + haptic + 30-second countdown ring. Larger UX work (e.g., persistent floating bubble across other screens) deferred until product validation in real driver testing.
