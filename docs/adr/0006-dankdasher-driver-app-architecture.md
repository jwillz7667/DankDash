# ADR 0006 — DankDasher driver app: peer Xcode project, shared package, peer location client

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —

## Context

Phase 19 (`docs/CLAUDE-CODE-PHASES.md` §19) introduces a **second iOS binary** — the driver app, `DankDasher` — alongside the existing consumer app, `DankDash`. The two apps share a substantial amount of code (the entire auth shell, the design-system tokens, the keychain + APIClient + LiveAuthInterceptor stack, the cannabis-numeric `Decimal(string:)` decoding contract, the `Coordinate` value type, the realtime infrastructure landing in Phase 22), but diverge in non-trivial ways:

- **Background location** — the driver app needs `Always` authorization, the `location` background mode in `UIBackgroundModes`, and a long-lived `CLLocationManager` streaming coordinates during a shift. The consumer app does one-shot `requestLocation()` for the feed and that's it.
- **Bundle ID + entitlements** — `Res.DankDasher` vs `Res.DankDash`; the driver app needs APNs `development`/`production` plus the background-location capability, the consumer needs CloudKit + APNs.
- **App Store distribution** — Apple's cannabis policy (Tech Spec §10.4) routes the consumer app through an "in-app browse, checkout exits to web" workaround, while the driver app ships to a curated list of licensed drivers (B2B classification, `LSApplicationCategoryType = public.app-category.business`). Different review tracks; different release cadences.
- **Info.plist surface** — driver needs `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes = ["location", "remote-notification"]`, the `dankdasher://` URL scheme; consumer needs none of those.
- **Onboarding gate** — the driver app's post-auth path forks on a `Driver.isBackgroundCheckPassed` predicate, the consumer's doesn't.

Three architectural decisions had to land together to start Phase 19. This ADR documents all three so future phases can refer to a single rationale.

## Decisions

### Decision 1 — peer `DankDasher.xcodeproj` at the repo root (not a second target inside `DankDash.xcodeproj`)

The driver app gets its own Xcode project (`DankDasher.xcodeproj`) sibling to the consumer's `DankDash.xcodeproj`. Both consume the same local `DankDashKit` SwiftPM package via `XCLocalSwiftPackageReference`.

Rationale:

- **Distinct distribution paths.** Two different App Store records, two different review queues, two different TestFlight cohorts. The release engineer needs to be able to ship one without bumping the other.
- **Different entitlements + Info.plist keys.** A second target in the same project would force conditional build settings keyed off `${TARGET_NAME}`, doubling the configuration surface and making one-line settings audits fragile. Peer projects keep each app's `Info.plist`, `*.entitlements`, and build settings completely independent.
- **CI cost.** A single Xcode project with two targets makes `xcodebuild build -target` invocations cheap, but the cached SwiftPM checkout is shared anyway — two `xcodebuild` invocations against two projects pay the same package-resolve cost on the second run (the local-package cache is warm). The savings from co-located targets are marginal versus the cost of leaky configuration.
- **CLAUDE.md repo-layout alignment.** The project's `CLAUDE.md` already calls out `DankDasher/` as a peer to `DankDash/` ("iOS driver app (to be created)"). The peer-project decision matches the documented layout without inventing a new convention.
- **No iOS-target sharing pain.** SwiftPM lets both apps depend on the same local package via the relative path `DankDashKit/`; the package surface is the only thing that needs to stay coherent. There is no shared Storyboard / xcassets / Info.plist between the two apps, so co-locating targets would buy zero reuse and cost configuration clarity.

### Decision 2 — peer `BackgroundLocationClient` (not extension of `LocationClient`)

`DankDashFeatures/Dependencies/` gains a new `BackgroundLocationClient` rather than extending the existing `LocationClient` with start/stop semantics.

```swift
public struct BackgroundLocationClient: Sendable {
  public var authorizationStatus: @Sendable () -> LocationAuthorizationStatus
  public var requestAlwaysAuthorization: @Sendable () async -> LocationAuthorizationStatus
  public var beginUpdates: @Sendable (LocationUpdateMode) async -> Void
  public var endUpdates: @Sendable () async -> Void
  public var locationUpdates: @Sendable () -> AsyncStream<Coordinate>
  public var setUpdateMode: @Sendable (LocationUpdateMode) async -> Void
}
```

Rationale:

- **One-shot vs streaming is a different shape.** `LocationClient` exposes `currentLocation() async throws -> Coordinate` — pull-based, no state, no delegate retention. Overloading it with `start/stop/observe` closures would force every caller (today only the consumer feed) to be aware of a streaming surface it doesn't use, and it would force the live impl to manage a coordinator object's lifecycle for a use case that doesn't need one.
- **Independent live impls.** The `.live` for `LocationClient` is ~20 lines of closure plumbing around a one-shot `CLLocationManager.requestLocation()`. The `.live` for `BackgroundLocationClient` is a `BackgroundLocationCoordinator` `NSObject` + `CLLocationManagerDelegate` holding a long-lived `AsyncStream<Coordinate>.Continuation` and a mutable `LocationUpdateMode`. The two concerns are mechanically different; merging them would entangle their lifetimes.
- **Same precedent.** The consumer app already separates `OrderCacheClient` from `CatalogCacheClient` — two seams over the same underlying file store because the access shapes diverge. The location surface gets the same treatment.
- **Testability.** Each client gets its own `.testValue` `TestStore` substitution. A driver-shift `TestStore` injecting a custom `BackgroundLocationClient` doesn't have to stub `LocationClient` too, and vice versa.

The `.live` impls can internally route through the same `CLLocationManager` instance if a future refactor demands it; for Phase 19 they hold separate manager instances inside their respective coordinators. The protocol surfaces stay distinct.

### Decision 3 — `IdentityVerificationClient` (Veriff iOS SDK) deferred entirely from Phase 19

The Phase-19 plan in `docs/CLAUDE-CODE-PHASES.md` §19 lists "Veriff identity verification" as part of the driver onboarding flow. Phase 19 ships the onboarding flow **without** the Veriff step.

Rationale:

- **Backend dependency missing.** Veriff's iOS SDK requires a session token minted by the backend. The Phase-8 backend exposes admin-side driver creation (`POST /v1/admin/drivers`) and the driver self-projection but not the Veriff session-token endpoint. Without the backend half, the iOS integration would be a stub against fake tokens — and Apple-review surfaces don't tolerate non-functional SDK integrations.
- **Pair with the matching backend phase.** Identity verification at handoff (Phase 20's ID-scan step) is the right surface to pair the SDK integration with: the backend session-token endpoint, the Veriff webhook handler, and the verification-failure UX all land together. Splitting the SDK across two phases buys nothing.
- **Onboarding flow stays linear.** Welcome → vehicle → documents → review → pending. Five steps. Each step writes to the on-disk draft store so a relaunch resumes from the same step. Adding a Veriff substep that doesn't have a backend would force a "skip if no backend" branch into the reducer that would have to be ripped out cleanly later.

The application-submit endpoint (`POST /v1/driver/applications`) is also backend-deferred — but unlike Veriff, the iOS code submits to it today and handles a 404 by transitioning the user to the pending screen with a "queued for admin review" message. The minute the endpoint lands the existing iOS path consumes it unchanged. The Veriff SDK doesn't have that property — without the session token, there's nothing to wire — so it stays out of the binary entirely until Phase 20's pairing.

## Consequences

**Positive.**

- Two iOS apps share one package (`DankDashKit`) and one repo (one branch, one PR per phase). The auth shell is reused verbatim; the cannabis-numeric decode contract is reused verbatim; the DesignSystem tokens are reused verbatim. Net new feature code lives only in `DankDashFeatures/Driver*/`.
- CI runs both `xcodebuild build` jobs in parallel against the same `swift test` artifact; the SwiftPM cache key is shared so the second app's build inherits the warm package.
- The two `Info.plist` files stay readable — neither has a `${TARGET_NAME}`-conditional setting; each app's entitlements file is the exact set its review path needs and nothing more.
- The `BackgroundLocationClient` is testable in isolation: the `DriverShiftFeature` `TestStore` substitutes a closure-backed mock that yields synthetic coordinates, the live `CLLocationManager` coordinator is never instantiated under `swift test`.
- Phase-20 ID-scan work can pull in Veriff cleanly when its backend dependency lands; no half-built SDK integration to migrate.

**Negative / costs.**

- Two `Info.plist` files to keep in sync where they should be in sync (e.g. `IPHONEOS_DEPLOYMENT_TARGET = 26.4`, the `DANKDASH_*` base-URL keys). Mitigation: a checklist in the Phase-19 PROGRESS entry, and the CI build-job pair will catch a deployment-target drift immediately.
- Two app icons + launch screens to maintain. Phase 19 ships both with placeholder icons; Phase 16 (rebrand commit 16) lands the production icon set + the `BrandLogo.imageset` slots that both apps consume.
- Two TestFlight builds to upload + two App Store records to maintain. Real cost, accepted explicitly.
- The driver app's `Always` location-authorization prompt is irrevocable per-install (iOS only shows the system prompt once). Mitigation: the iOS pre-prompt screen (`AuthorizationRationaleView`) explains the why before the system prompt fires, and a denial routes through a "Enable Always in Settings" banner inside `DriverShiftFeature`.
- Veriff integration is a separate phase's work (Phase 20). For Phase 19, the onboarding terminal screen explicitly tells the user "an admin will reach out" when the application-submit endpoint 404s — until backend phase 19.5 (or wherever the endpoint lands) the user can't self-promote from pending. The reducer polls `GET /v1/driver/me` every 30 s so the moment an admin record-creation lands, the app graduates without a re-login.

## Implementation references

- `DankDasher.xcodeproj/project.pbxproj` — peer Xcode project, `XCFileSystemSynchronizedRootGroup` rooted at `DankDasher/`, references local `DankDashKit` package.
- `DankDasher/Info.plist` — `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes = ["location", "remote-notification"]`, `dankdasher://` URL scheme, `LSApplicationCategoryType = public.app-category.business`.
- `DankDasher/DankDasher.entitlements` — `aps-environment = development`. Background-location is implicit via `UIBackgroundModes`.
- `DankDashKit/Sources/DankDashFeatures/Dependencies/BackgroundLocationClient.swift` — protocol + `.live` `BackgroundLocationCoordinator` + `.testValue`.
- `DankDashKit/Sources/DankDashFeatures/DriverShift/DriverShiftFeature.swift` — the reducer that owns the toggle, the shift-start/end transitions, and the location + heatmap + heartbeat side-effect graph.
- `DankDashKit/Sources/DankDashFeatures/DriverRoot/DriverRootFeature.swift` — top-level navigation reducer; reuses `AgeGateFeature` / `LoginFeature` / `SignUpFeature` / `ForgotPasswordFeature` from the consumer side verbatim.
- `.github/workflows/ios.yml` — `xcode-build-driver` job mirrors `xcode-build` against `DankDasher.xcodeproj`.

## Open items deferred to later phases

- **Veriff iOS SDK integration** — pairs with backend Phase 20's session-token endpoint + webhook handler. The onboarding flow's terminal screen explicitly accepts the missing-endpoint state today.
- **`POST /v1/driver/applications` backend endpoint** — driver-self onboarding submission. The iOS reducer handles a 404 by transitioning to the pending screen with `queuedForOps = true`; once shipped, the existing iOS code consumes it unchanged.
- **`GET /v1/driver/heatmap` backend endpoint** — iOS polls every 60 s while online; a 404 renders no overlay (state.heatmap stays empty, no error banner).
- **Presigned-URL document-upload endpoint** — documents persist to the app sandbox via `DocumentDraftStore` until the endpoint lands; upload happens on first 200 from the backend.
- **`/driver` realtime namespace** — Phase 22 lights it. Phase-19 location pings stay in the reducer state and feed `BackgroundLocationClient.locationUpdates` only; once the namespace is wired we add a `DriverRealtimeClient.publishLocation(_:)` call site without changing the reducer interface.
- **Phase 20** — offer cards, accept/decline, active route navigation, ID scan at dropoff, pickup-confirm + delivery-complete. Out of scope for Phase 19.
- **Branded MapKit overlay** on the driver shift home — the demand-heatmap overlay renders polygons today, but the underlying tiles are default Apple Maps. Branding deferred until the design pass.
