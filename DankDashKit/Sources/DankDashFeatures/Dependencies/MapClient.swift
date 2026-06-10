import Foundation
import ComposableArchitecture
import DankDashDomain
#if canImport(MapKit)
import MapKit
#endif

/// SDK-agnostic map region — `(center, span)` pair in the same shape
/// MapKit's `MKCoordinateRegion` uses, but expressed in Domain
/// `Coordinate` so it crosses the layer boundary without dragging
/// MapKit into the Features module.
///
/// Per ADR-0006 the live binding is MapKit-backed today; the goal of
/// keeping ``MapClient`` interface-only is so a future swap to Mapbox
/// can replace `live` without touching reducer code that consumes
/// `MapRegion`.
public struct MapRegion: Sendable, Equatable {
  public let center: Coordinate
  public let latitudeSpan: Double
  public let longitudeSpan: Double

  public init(center: Coordinate, latitudeSpan: Double, longitudeSpan: Double) {
    self.center = center
    self.latitudeSpan = latitudeSpan
    self.longitudeSpan = longitudeSpan
  }
}

/// One stop on an external Maps hand-off — a coordinate plus the label
/// shown on the dropped pin. Domain `Coordinate` keeps the type free of
/// MapKit so the reducer can build the stop list without importing it.
public struct MapDestination: Sendable, Equatable {
  public let coordinate: Coordinate
  public let name: String

  public init(coordinate: Coordinate, name: String) {
    self.coordinate = coordinate
    self.name = name
  }
}

/// `@DependencyClient`-style abstraction over map-SDK helpers. The
/// presentation layer (``LiveMapView``) talks to MapKit directly via
/// SwiftUI's `Map`; this client covers the parts reducers need that
/// would otherwise drag MapKit into the Features module: the bounding-
/// region math (one canonical home, unit-testable without `MKMapView`)
/// and the external-Maps hand-off (the live binding shells out to Apple
/// Maps; tests substitute a recorder).
public struct MapClient: Sendable {
  /// Computes a region that encloses every supplied coordinate with a
  /// small margin so pins aren't flush against the map edges. Returns
  /// `nil` if `coordinates` is empty so the caller can fall back to a
  /// default region rather than presenting an invalid one.
  public var boundingRegion: @Sendable (_ coordinates: [Coordinate]) -> MapRegion?

  /// Opens Apple Maps with driving directions to the supplied stop. Pass
  /// exactly one destination: with a single item Apple Maps routes from
  /// the user's current location, but with two or more `MKMapItem.openMaps`
  /// treats the FIRST item as the route's origin — not the user — which is
  /// never what a driver hand-off wants. A no-op when the list is empty.
  /// Fire-and-forget — there is no result to await.
  public var openInMaps: @Sendable (_ destinations: [MapDestination]) -> Void

  public init(
    boundingRegion: @Sendable @escaping (_ coordinates: [Coordinate]) -> MapRegion?,
    openInMaps: @Sendable @escaping (_ destinations: [MapDestination]) -> Void
  ) {
    self.boundingRegion = boundingRegion
    self.openInMaps = openInMaps
  }
}

public extension MapClient {
  /// Default bounding-region implementation — pure math. Mirrors the
  /// algorithm in ``LiveMapView`` (1.6x padding + a 0.01° minimum
  /// span) so the reducer-computed region matches what the view would
  /// auto-compute from the same pin set.
  static let live: MapClient = {
    #if canImport(MapKit)
    return MapClient(
      boundingRegion: { coordinates in computeBoundingRegion(for: coordinates) },
      openInMaps: { destinations in MapsLauncher.open(destinations) }
    )
    #else
    return MapClient(
      boundingRegion: { coordinates in computeBoundingRegion(for: coordinates) },
      openInMaps: { _ in }
    )
    #endif
  }()

  /// Test fixture: `boundingRegion` returns `nil` and `openInMaps` is a
  /// no-op. Tests that need a real region substitute a custom closure or
  /// use ``live`` directly (the calculation is pure); tests that assert
  /// the Maps hand-off substitute a recording `openInMaps`.
  static let unimplemented = MapClient(
    boundingRegion: { _ in nil },
    openInMaps: { _ in }
  )
}

#if canImport(MapKit)
/// Drives Apple Maps turn-by-turn to the supplied stop (callers pass one
/// destination — see ``MapClient/openInMaps`` for the multi-item origin
/// pitfall). Implementation-private to the live binding — mirrors the
/// `DirectionsLive` pattern in ``DirectionsClient`` so MapKit stays
/// contained to one binding.
private enum MapsLauncher {
  static func open(_ destinations: [MapDestination]) {
    guard !destinations.isEmpty else { return }
    // `MKMapItem` is not `Sendable`, so build the items and launch
    // entirely on the main actor — only the `Sendable` `destinations`
    // value crosses the hop.
    Task { @MainActor in
      let items = destinations.map { destination -> MKMapItem in
        let coordinate = CLLocationCoordinate2D(
          latitude: destination.coordinate.latitude,
          longitude: destination.coordinate.longitude
        )
        let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
        item.name = destination.name
        return item
      }
      MKMapItem.openMaps(
        with: items,
        launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving]
      )
    }
  }
}
#endif

/// Exposed for tests and the design-system layer so the same math
/// powers both the reducer-level region computation and the view's
/// `initialPosition` fallback.
public func computeBoundingRegion(for coordinates: [Coordinate]) -> MapRegion? {
  guard !coordinates.isEmpty else { return nil }
  let lats = coordinates.map { $0.latitude }
  let lngs = coordinates.map { $0.longitude }
  let minLat = lats.min() ?? 0
  let maxLat = lats.max() ?? 0
  let minLng = lngs.min() ?? 0
  let maxLng = lngs.max() ?? 0
  let centerLat = (minLat + maxLat) / 2
  let centerLng = (minLng + maxLng) / 2
  let latSpan = max(0.01, (maxLat - minLat) * 1.6)
  let lngSpan = max(0.01, (maxLng - minLng) * 1.6)
  return MapRegion(
    center: Coordinate(latitude: centerLat, longitude: centerLng),
    latitudeSpan: latSpan,
    longitudeSpan: lngSpan
  )
}

private enum MapClientKey: DependencyKey {
  static let liveValue: MapClient = .live
  static let testValue: MapClient = .unimplemented
}

public extension DependencyValues {
  var mapClient: MapClient {
    get { self[MapClientKey.self] }
    set { self[MapClientKey.self] = newValue }
  }
}
