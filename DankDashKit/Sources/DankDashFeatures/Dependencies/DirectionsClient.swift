import Foundation
import ComposableArchitecture
import DankDashDomain
#if canImport(MapKit)
import MapKit
#endif
#if canImport(CoreLocation)
import CoreLocation
#endif

/// Errors surfaced by ``DirectionsClient``. Reducers translate these
/// into a screen-level error banner — none of them are recoverable
/// without driver action (retry the route, or accept that MapKit is
/// not available on the host platform).
public enum DirectionsClientError: Error, Sendable, Equatable {
  case noRouteFound
  case mapKitUnavailable
}

/// Thin abstraction over `MKDirections` so the reducer can run under
/// `swift test` without a live MapKit context (CI is macOS but the
/// reducer tests use the test factory; the live implementation is the
/// only call site that depends on `MKDirections.calculate()`).
///
/// Two responsibilities:
///
///   1. **calculateRoute** — request a one-shot route for a leg
///      (current → dispensary, or current → dropoff). Returns the
///      polyline + step list as pure-Swift values.
///   2. **liveSteps** — given a route and an `AsyncStream<Coordinate>`
///      of the driver's GPS samples, yield the "current" step each
///      time the driver advances past one. Yields the first step
///      immediately so the UI has something to render before the
///      first GPS sample arrives.
public struct DirectionsClient: Sendable {
  public var calculateRoute: @Sendable (Coordinate, Coordinate, RouteTransportType) async throws -> RouteDirections
  public var liveSteps: @Sendable (RouteDirections, AsyncStream<Coordinate>) -> AsyncStream<RouteStep>

  public init(
    calculateRoute: @Sendable @escaping (Coordinate, Coordinate, RouteTransportType) async throws -> RouteDirections,
    liveSteps: @Sendable @escaping (RouteDirections, AsyncStream<Coordinate>) -> AsyncStream<RouteStep>
  ) {
    self.calculateRoute = calculateRoute
    self.liveSteps = liveSteps
  }
}

public extension DirectionsClient {
  /// Live binding. MapKit is present on every supported deployment
  /// target (iOS + macOS test host) so the implementation is shared.
  static let live: DirectionsClient = {
    #if canImport(MapKit)
    return DirectionsClient(
      calculateRoute: { from, to, transport in
        try await DirectionsLive.calculateRoute(from: from, to: to, transport: transport)
      },
      liveSteps: { route, stream in
        DirectionsLive.liveSteps(route: route, stream: stream)
      }
    )
    #else
    return .unimplemented
    #endif
  }()

  /// Test fixture — both closures throw / yield-empty so a forgotten
  /// dependency override surfaces as a test failure rather than a
  /// hung effect.
  static let unimplemented = DirectionsClient(
    calculateRoute: { _, _, _ in throw DirectionsClientError.mapKitUnavailable },
    liveSteps: { _, _ in AsyncStream { $0.finish() } }
  )

  /// Convenience factory for reducer tests: returns a fixed route from
  /// `calculateRoute`, and walks the supplied step indices in order on
  /// each incoming coordinate.
  ///
  /// Yields each indexed step the first time its index appears on the
  /// `coordinateToStepIndex` lookup — so a test that wants to assert
  /// "three coordinates yielded → currentStep updates" supplies a
  /// resolver that maps each sample to a distinct step index.
  static func test(
    route: RouteDirections,
    coordinateToStepIndex: @Sendable @escaping (Coordinate) -> Int = { _ in 0 }
  ) -> DirectionsClient {
    DirectionsClient(
      calculateRoute: { _, _, _ in route },
      liveSteps: { fixedRoute, stream in
        AsyncStream { continuation in
          let task = Task {
            var lastIndex = -1
            for await coordinate in stream {
              let resolved = coordinateToStepIndex(coordinate)
              guard resolved != lastIndex, resolved >= 0, resolved < fixedRoute.steps.count else { continue }
              lastIndex = resolved
              continuation.yield(fixedRoute.steps[resolved])
            }
            continuation.finish()
          }
          continuation.onTermination = { _ in task.cancel() }
        }
      }
    )
  }
}

private enum DirectionsClientKey: DependencyKey {
  static let liveValue: DirectionsClient = .live
  static let testValue: DirectionsClient = .unimplemented
}

public extension DependencyValues {
  var directionsClient: DirectionsClient {
    get { self[DirectionsClientKey.self] }
    set { self[DirectionsClientKey.self] = newValue }
  }
}

// MARK: - Live MapKit binding

#if canImport(MapKit)
/// MKDirections wrapper. Lives in this file (not a sibling type)
/// because every call here funnels back through `DirectionsClient` —
/// the type is implementation-private to the live binding.
private enum DirectionsLive {
  static func calculateRoute(
    from: Coordinate,
    to: Coordinate,
    transport: RouteTransportType
  ) async throws -> RouteDirections {
    let sourceCoordinate = CLLocationCoordinate2D(latitude: from.latitude, longitude: from.longitude)
    let destinationCoordinate = CLLocationCoordinate2D(latitude: to.latitude, longitude: to.longitude)
    let request = MKDirections.Request()
    request.source = MKMapItem(placemark: MKPlacemark(coordinate: sourceCoordinate))
    request.destination = MKMapItem(placemark: MKPlacemark(coordinate: destinationCoordinate))
    request.transportType = transport.mkTransportType
    request.requestsAlternateRoutes = false
    let directions = MKDirections(request: request)
    let response = try await directions.calculate()
    guard let route = response.routes.first else {
      throw DirectionsClientError.noRouteFound
    }
    return mapRoute(route)
  }

  static func liveSteps(
    route: RouteDirections,
    stream: AsyncStream<Coordinate>
  ) -> AsyncStream<RouteStep> {
    AsyncStream { continuation in
      let task = Task {
        var currentIndex = 0
        if let first = route.steps.first {
          continuation.yield(first)
        }
        for await coordinate in stream {
          let advanced = nextStepIndex(currentIndex: currentIndex, route: route, location: coordinate)
          guard advanced != currentIndex, advanced < route.steps.count else { continue }
          currentIndex = advanced
          continuation.yield(route.steps[advanced])
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  private static func mapRoute(_ route: MKRoute) -> RouteDirections {
    let polyline = polylineCoordinates(route.polyline)
    let steps: [RouteStep] = route.steps.enumerated().map { idx, step in
      RouteStep(
        id: idx,
        instruction: step.instructions,
        notice: step.notice,
        distanceMeters: step.distance,
        polyline: polylineCoordinates(step.polyline)
      )
    }
    return RouteDirections(
      polyline: polyline,
      steps: steps,
      expectedTravelTimeSeconds: route.expectedTravelTime,
      distanceMeters: route.distance
    )
  }

  private static func polylineCoordinates(_ polyline: MKPolyline) -> [Coordinate] {
    let count = polyline.pointCount
    guard count > 0 else { return [] }
    var raw = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid, count: count)
    polyline.getCoordinates(&raw, range: NSRange(location: 0, length: count))
    return raw.map { Coordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }
}

private extension RouteTransportType {
  var mkTransportType: MKDirectionsTransportType {
    switch self {
    case .automobile: return .automobile
    case .walking: return .walking
    }
  }
}
#endif

// MARK: - Step advance heuristic (pure, testable on any platform)

/// Greedy monotone advance. Returns the first step index `>= currentIndex`
/// where the driver is closer to the NEXT step's start than the current
/// step's start — i.e. they've passed the current step's threshold.
/// Never goes backwards; pegs at the last step.
///
/// `internal` so the reducer tests can exercise the heuristic directly
/// without going through an `AsyncStream`.
internal func nextStepIndex(currentIndex: Int, route: RouteDirections, location: Coordinate) -> Int {
  let last = max(route.steps.count - 1, 0)
  guard currentIndex < last else { return last }
  var idx = currentIndex
  while idx < last {
    let next = idx + 1
    guard let currentStart = route.steps[idx].polyline.first,
          let nextStart = route.steps[next].polyline.first else {
      break
    }
    let distanceToCurrent = haversineMeters(location, currentStart)
    let distanceToNext = haversineMeters(location, nextStart)
    if distanceToNext < distanceToCurrent {
      idx = next
    } else {
      break
    }
  }
  return idx
}

/// Great-circle distance in meters between two WGS84 coordinates.
/// `internal` because both `liveSteps` and the reducer tests use it.
internal func haversineMeters(_ a: Coordinate, _ b: Coordinate) -> Double {
  let earthRadius = 6_371_000.0
  let lat1 = a.latitude * .pi / 180
  let lat2 = b.latitude * .pi / 180
  let deltaLat = (b.latitude - a.latitude) * .pi / 180
  let deltaLon = (b.longitude - a.longitude) * .pi / 180
  let h = sin(deltaLat / 2) * sin(deltaLat / 2)
    + cos(lat1) * cos(lat2) * sin(deltaLon / 2) * sin(deltaLon / 2)
  let c = 2 * atan2(sqrt(h), sqrt(1 - h))
  return earthRadius * c
}
