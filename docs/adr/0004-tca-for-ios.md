# ADR 0004 — TCA + local Swift package for the iOS consumer app

- **Status:** Accepted
- **Date:** 2026-05-20
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —

## Context

Phase 16 (`docs/CLAUDE-CODE-PHASES.md` §16) bootstraps the DankDash consumer iOS app. The brief calls for a SwiftUI app on iOS 26 with Swift 6 strict concurrency, structured around the architecture described in `docs/spec/DankDash-Technical-Spec.md` §5.1: a small "App / Features / Core / Domain" layering, network + storage abstracted behind protocols, an age gate before any catalog surface, and a checkout path that hands off to Safari per Apple §10.4. The phase has to land before Phase 17 lights up KYC + catalog browsing.

Three open architectural choices had to be settled in this phase:

1. **State management.** SwiftUI's bare `@Observable` works for simple screens but offers no story for orchestrated multi-step flows (login → MFA → auth tokens → keychain → root state transition), no built-in testability scaffolding, no dependency injection seam, and no discipline around side-effect ordering. The spec explicitly names TCA (The Composable Architecture, `pointfreeco/swift-composable-architecture`) in §5.1.
2. **Package layout.** The Xcode project shipped from the template with a single app target and zero test bundles. Adding a host-app unit-test target requires non-trivial `project.pbxproj` surgery (PBXNativeTarget with `bundle.unit-test` product type, host-app dependency, scheme XML). The team is small; pbxproj patches are a recurring source of conflict.
3. **Apple cannabis policy.** Spec §10.4 forbids in-app checkout for the consumer app: browsing happens in-app, checkout redirects to a Safari view at `app.dankdash.com`. The architecture must accommodate this without ever exposing a checkout surface that could land in a TestFlight build by accident.

## Decision

**1. The Composable Architecture (TCA) is the state-management primitive for every feature.**

Each feature is a `@Reducer` with an `@ObservableState` State and an Action enum. Side effects are returned as `Effect`s. Dependencies (the network client, the keychain) are injected via `@Dependency` so reducers receive mocks under test. Parent–child composition uses `Scope` + `ifLet`; children expose a narrow `Delegate` enum that the parent listens for, so child state never reaches out to mutate the parent directly.

**2. Production iOS code is split across the Xcode app target and a co-located Swift package at `DankDashKit/`.**

The app target (`DankDash/`) holds only the `@main` entrypoint, the composition root (`AppEnvironment.live` — the singleton APIClient + KeychainStore + dependency wiring), and the SwiftUI view files. Everything testable — Domain value types, DesignSystem tokens + components, Storage (Keychain + biometric access-control), Network (APIClient + Auth interceptor + DTOs), and Features (every reducer) — lives in `DankDashKit` as five library products and is tested via `swift test --package-path DankDashKit` against the SwiftPM-native test discovery. The package's external dependencies are pinned to two crates: `pointfreeco/swift-composable-architecture` (TCA) and `pointfreeco/swift-snapshot-testing` (component snapshots).

This sidesteps the host-app test-target pbxproj patch entirely: tests live where the code is, and the only Xcode project edit needed is a single `XCLocalSwiftPackageReference` + one `XCSwiftPackageProductDependency` entry per library product. Reviewable in one pass.

**3. The consumer app never ships an in-process checkout surface.**

`AppEnvironment` exposes `checkoutBaseURL: URL` (default `https://app.dankdash.com/checkout`) so when Phase 18 wires the `SFSafariViewController` handoff the URL is already centralized. `RootFeature` routes age-gated → auth → home; there is no `CheckoutFeature` in the reducer graph, and the post-auth state is a placeholder until Phase 17 swaps it for the catalog flow. Any future addition of a payment surface to the consumer iOS app should be rejected at code review with reference to this ADR.

## Consequences

**Positive.**

- Reducers are deterministic and trivially unit-testable. `TestStore` exercises every state transition + the dependency-injected effect surface; the 125-test Phase-16 suite asserts each branch of the discriminated-union login response (`authenticated` vs `mfa_required`) without launching a simulator.
- The package boundary is enforced by the linker: a Features reducer cannot accidentally import UIKit, and the Domain layer cannot pull in `URLSession`. Refactors stay local.
- Swift 6 strict concurrency works cleanly with TCA's `@Reducer` + `@ObservableState` macros (Equatable + Sendable on every State, `@Sendable` closures on Effect bodies). Compilation is the contract.
- The CI lane (`.github/workflows/ios.yml`) caches SwiftPM artifacts and runs `swift test` on every PR; full TCA + swift-syntax builds happen once and amortize across runs.
- The Apple §10.4 constraint is encoded structurally — there is no checkout reducer, so a future contributor would have to deliberately introduce one to break the rule, which a `grep -r CheckoutFeature DankDashKit/` in CI could enforce later if needed.

**Negative / costs.**

- TCA is a non-trivial library (one external dependency tree, ~13 transitive SwiftPM packages including swift-syntax). Every iOS engineer joining the project has to learn its idioms (`Reducer`, `Effect`, `TestStore`, `@Dependency`, `Scope.ifLet`).
- Reducer boilerplate is heavier than `@Observable` for simple screens. The trade is paid in lines of code but recovered in testability.
- The view layer is in the app target and not unit-tested at the SwiftUI level. UI assertions land in the gallery's manual visual review (`DesignGalleryView`) plus the snapshot tests in `DankDashDesignSystemTests`; full UI testing would require a host-app test target (deliberately deferred until reducer-level coverage proves insufficient).
- The local-package layout means the IDE's package indexing is slower to warm up than a single-target project; SourceKit emits transient "no such module" diagnostics until SPM resolves. Builds are unaffected.

## Implementation references

- Reducers: `DankDashKit/Sources/DankDashFeatures/` — AgeGate, Login (with MFA branch), SignUp, ForgotPassword, Root parent.
- Dependency seam: `DankDashKit/Sources/DankDashFeatures/Dependencies/` — `AuthAPIClient` + `TokenStore` are `@Dependency` keys.
- Composition root: `DankDash/App/AppEnvironment.swift` — produces `APIClient` + `KeychainStore`, wires both into `DependencyValues` via `prepareDependencies(&_)`.
- Test surface: `DankDashKit/Tests/DankDashFeaturesTests/` — `TestStore`-based assertions for every reducer; mocks live in `DankDashFeatures/Dependencies/*+TestSupport` or are constructed inline with `withDependencies { … }`.

## Open items deferred to later phases

- `swift-openapi-generator` codegen lands when `docs/spec/openapi.yaml` is complete (today it is an excerpt). The hand-rolled DTOs in `DankDashNetwork` are the bridge.
- Persona iOS SDK integration is Phase 17 work; today the app surfaces `KYCPlaceholderView`.
- A second app target (`DankDasher`, the driver app) can be added later by consuming the same `DankDashKit` package; the package was sized so that no app-target-specific code leaks into it.
