import Foundation
import ComposableArchitecture
import DankDashDomain

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

/// `@DependencyClient`-style abstraction over map-SDK helpers. The
/// presentation layer (``LiveMapView``) talks to MapKit directly via
/// SwiftUI's `Map`; this client covers the *non*-UI math reducers
/// need — computing a bounding region for a set of pins, primarily —
/// so the bounds calculation has one canonical home and is unit-
/// testable without spinning up `MKMapView`.
public struct MapClient: Sendable {
  /// Computes a region that encloses every supplied coordinate with a
  /// small margin so pins aren't flush against the map edges. Returns
  /// `nil` if `coordinates` is empty so the caller can fall back to a
  /// default region rather than presenting an invalid one.
  public var boundingRegion: @Sendable (_ coordinates: [Coordinate]) -> MapRegion?

  public init(boundingRegion: @Sendable @escaping (_ coordinates: [Coordinate]) -> MapRegion?) {
    self.boundingRegion = boundingRegion
  }
}

public extension MapClient {
  /// Default bounding-region implementation — pure math. Mirrors the
  /// algorithm in ``LiveMapView`` (1.6x padding + a 0.01° minimum
  /// span) so the reducer-computed region matches what the view would
  /// auto-compute from the same pin set.
  static let live = MapClient(
    boundingRegion: { coordinates in
      computeBoundingRegion(for: coordinates)
    }
  )

  /// Test fixture: every call returns `nil`. Tests that need a real
  /// region substitute a custom closure or use ``live`` directly
  /// since the calculation is pure.
  static let unimplemented = MapClient(
    boundingRegion: { _ in nil }
  )
}

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
