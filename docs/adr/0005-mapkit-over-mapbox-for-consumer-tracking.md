# ADR 0005 — MapKit (not Mapbox) for consumer-app order tracking

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —

## Context

Phase 18 (`docs/CLAUDE-CODE-PHASES.md` §18) ships the consumer-iOS live tracking surface — `OrderTrackingFeature` + `LiveMapView` — so a customer can watch a placed order move through pickup → en-route → arriving → delivered, with the driver's location pin updating on the map at ~1 Hz over Socket.io. The Phase-18 surface renders:

- one pin for the dispensary (origin),
- one pin for the delivery address (destination),
- one moving pin for the driver,
- an optional polyline approximating the driver's route.

The Technical Spec §5.1 lists **Mapbox** as the consumer-iOS map provider, paired with a Mapbox-style driver-app map in the Phase-22 work. Phase 18 has to decide which SDK lands today, knowing the driver app is months out.

Two options were on the table.

1. **Mapbox iOS SDK (`MapboxMaps`).** Spec-aligned. Polished tile rendering, vector tiles with offline support, configurable styles. Pulls in ~25 MB of SDK + map runtime, requires a Mapbox access token in `Info.plist`, sends telemetry to Mapbox endpoints by default (opt-out via `MGLMapboxMetricsEnabled = NO`), and is a paid product past their free-tier MAU + map-load thresholds. Tile attribution and style URLs are part of the public contract.
2. **MapKit (`MKMapView`).** First-party, zero added binary weight, no token, no third-party telemetry. Apple Maps tiles are tightly integrated with the system (offline routing, ETA estimation, indoor maps in supported venues, dark-mode tile coloring without configuration). Driving-routes API (`MKDirections`) is satellite-equivalent for our use case (point-to-point delivery within MN), and `MKPolyline` + `MKMarkerAnnotationView` cover the three-pin + route layout out of the box.

The deciding inputs:

- **Phase-18 scope.** The map is one of four widgets on the tracking screen (timeline, ETA, driver card, map). It is not a navigation app — we don't need turn-by-turn voice, lane guidance, traffic overlays, or 3D building rendering.
- **TestFlight + privacy posture.** Apple's cannabis-app review path (spec §10.4) already lives at the policy edge. Adding a third-party telemetry SDK to the consumer binary is unnecessary risk: it adds an Info.plist key, an opt-out path the team has to remember to flip, and a `Privacy Manifest` entry. MapKit needs none of those.
- **Cost.** Mapbox's free tier is 25k monthly active users + 50k tile-loads. Consumer-app MAU at GA will eclipse the MAU cap within the first quarter. Per-MAU pricing past the free tier is real money for a map widget we don't need vector styles on.
- **Driver-app divergence is acceptable.** The driver app (Phase 22) does need turn-by-turn and vector tiles for routing UX; that app can take Mapbox without forcing the consumer binary into the same dependency. The two apps don't share a map surface today.
- **MN-only delivery polygon.** Every consumer-app map render is centered on a single MN dispensary and the user's MN address. Apple Maps tile quality in the Twin Cities + Greater MN is sufficient; we're not relying on Mapbox's superior coverage in regions Apple Maps lags.

## Decision

**Consumer iOS uses MapKit for the Phase-18 order-tracking map surface.** The `LiveMapView` SwiftUI wrapper sits behind a `MapClient` dependency that exposes:

- a render protocol (`@MainActor`-isolated; accepts origin + destination + optional driver coordinate + optional route polyline),
- a polyline-fetch surface (`MKDirections` under the hood; returns the encoded polyline as `[CLLocationCoordinate2D]`).

The interface is intentionally SDK-agnostic — no `MKMapView` types leak into the reducer or the dependency surface, only domain `Coordinate` value types. A future swap to Mapbox is a one-file change inside `DankDashFeatures/Dependencies/MapClient.swift` plus the SwiftUI wrapper.

The Technical Spec §5.1 will be amended (next spec rev) to reflect Mapbox on the driver app and MapKit on the consumer app.

## Consequences

**Positive.**

- Zero added binary weight on the consumer app — `MapKit` is system-resident on every iOS device. No access token, no Info.plist secrets, no telemetry opt-out paperwork.
- Privacy Manifest stays clean. No third-party SDK with a `PrivacyInfo.xcprivacy` declaration to maintain across SDK upgrades.
- No GA cost cliff — MapKit usage scales for free with the consumer base.
- Dark-mode tile coloring is automatic. The `LiveMapView` doesn't need to ship a custom style URL.
- The `MapClient` protocol boundary insulates feature code from the SDK choice. The reducer tests substitute a closure-backed mock that yields a synthetic polyline; no Mapbox or MapKit symbols leak into `swift test`.

**Negative / costs.**

- Tile rendering quality outside the U.S. is below Mapbox. Not a Phase-18 concern (MN-only delivery), but if the business expands cross-border the consumer surface may want to revisit.
- No vector tile styling. If product wants a branded map style (cream-colored land, primary-tinted roads), MapKit's overlay APIs are the only path — they're more work than Mapbox's Studio editor. Deferred to UX revision; the Phase-18 surface uses default Apple Maps.
- Driver and consumer apps will run on different map SDKs. Two SDKs to learn, two sets of quirks. Mitigated by the fact that the driver-app team doesn't share view code with consumer; both apps consume the same `MapClient` shape from `DankDashKit` but bind different live implementations.
- The Mapbox SDK has nicer offline tile caching than `MKMapView`. For consumer-app live tracking, offline isn't a feature requirement (the realtime stream is the data path; the map is decoration), so this doesn't bite us today.

## Implementation references

- `DankDashKit/Sources/DankDashFeatures/Dependencies/MapClient.swift` — SDK-agnostic interface + MapKit-backed `.live` binding.
- `DankDashKit/Sources/DankDashDesignSystem/Components/LiveMapView.swift` — SwiftUI `UIViewRepresentable` wrapping `MKMapView` with pin + polyline placement.
- `DankDashKit/Tests/DankDashFeaturesTests/OrderTracking/OrderTrackingFeatureTests.swift` — reducer tests substitute a `MapClient` mock and never touch MapKit.
- Phase-18 plan and DoD: `docs/CLAUDE-CODE-PHASES.md` §18.

## Open items deferred to later phases

- Driver-app map provider lands in Phase 22; ADR for that choice is filed separately.
- Branded MapKit overlay (cream land, primary-tinted roads) — defer until product asks; the current default-style tiles are fine for the launch surface.
- `LiveMapView` real-coordinate wiring on the consumer side — Phase 18 ships the map component with the interface complete, but `OrderTrackingFeature.State` doesn't yet carry the customer-address coordinate (the order-detail response only exposes `deliveryAddressId`). A follow-up wires `AddressAPIClient.getAddress(id:)` through the reducer; until then the map renders with the dispensary pin only on screens that have an assigned driver.
