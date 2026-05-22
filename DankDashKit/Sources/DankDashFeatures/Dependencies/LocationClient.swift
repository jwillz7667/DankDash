import Foundation
@preconcurrency import CoreLocation
import ComposableArchitecture
import DankDashDomain

/// Authorization status the feature layer cares about.
///
/// The consumer app only needs `whenInUse`, so its ``LocationCoordinator``
/// collapses both authorized variants into `.authorized` (kept for
/// back-compat with existing consumer reducers). The driver app
/// distinguishes them via `.authorizedWhenInUse` vs `.authorizedAlways`
/// because background telemetry requires `Always` and a
/// `whenInUse`-only grant should surface a rationale to the driver.
public enum LocationAuthorizationStatus: Sendable, Equatable {
  case notDetermined
  case denied
  case restricted
  /// Consumer-side collapsed-authorized case (either whenInUse or always).
  /// New driver code should pattern-match the precise variants below.
  case authorized
  case authorizedWhenInUse
  case authorizedAlways

  /// True for any authorized grant — covers all three authorized variants.
  /// Used by reducers that just need "did the user say yes."
  public var isAuthorized: Bool {
    switch self {
    case .authorized, .authorizedWhenInUse, .authorizedAlways: true
    case .notDetermined, .denied, .restricted: false
    }
  }
}

/// Errors surfaced by ``LocationClient``. Keep these narrow so reducers
/// can pattern-match without depending on CoreLocation directly.
public enum LocationClientError: Error, Sendable, Equatable {
  case notAuthorized
  case unavailable
  case timeout
  case underlying(String)
}

/// `@DependencyClient`-style abstraction over CoreLocation. CoreLocation
/// is imported only inside this file so reducers and tests never carry
/// a dependency on the framework — they substitute closures and assert.
public struct LocationClient: Sendable {
  public var authorizationStatus: @Sendable () -> LocationAuthorizationStatus
  public var requestAuthorization: @Sendable () async -> LocationAuthorizationStatus
  public var currentLocation: @Sendable () async throws -> Coordinate

  public init(
    authorizationStatus: @Sendable @escaping () -> LocationAuthorizationStatus,
    requestAuthorization: @Sendable @escaping () async -> LocationAuthorizationStatus,
    currentLocation: @Sendable @escaping () async throws -> Coordinate
  ) {
    self.authorizationStatus = authorizationStatus
    self.requestAuthorization = requestAuthorization
    self.currentLocation = currentLocation
  }
}

public extension LocationClient {
  /// Production binding. `CLLocationManager` is reference-typed and not
  /// `Sendable`; we wrap it in a coordinator that funnels CoreLocation
  /// delegate callbacks into Swift-concurrency continuations.
  ///
  /// Only available on iOS — CoreLocation's `whenInUse` authorization
  /// is iOS-only, and the consumer app is iOS-only. On macOS (which we
  /// build only for `swift test` of pure-Swift surfaces) the live
  /// binding falls back to the `.unimplemented` fixture.
  #if os(iOS)
  static let live: LocationClient = {
    let coordinator = LocationCoordinator()
    return LocationClient(
      authorizationStatus: { coordinator.currentAuthorizationStatus() },
      requestAuthorization: { await coordinator.requestAuthorization() },
      currentLocation: { try await coordinator.requestCurrentLocation() }
    )
  }()
  #else
  static let live: LocationClient = .unimplemented
  #endif

  /// Test fixture that always throws / returns `.notDetermined`.
  static let unimplemented = LocationClient(
    authorizationStatus: { .notDetermined },
    requestAuthorization: { .notDetermined },
    currentLocation: { throw LocationClientError.unavailable }
  )

  /// Convenience factory for TestStore: a pre-canned authorization
  /// status + coordinate, no closures to wire.
  static func test(
    status: LocationAuthorizationStatus,
    coordinate: Coordinate = Coordinate(latitude: 44.9778, longitude: -93.2650)
  ) -> LocationClient {
    LocationClient(
      authorizationStatus: { status },
      requestAuthorization: { status },
      currentLocation: {
        if status == .authorized {
          return coordinate
        }
        throw LocationClientError.notAuthorized
      }
    )
  }
}

private enum LocationClientKey: DependencyKey {
  static let liveValue: LocationClient = .live
  static let testValue: LocationClient = .unimplemented
}

public extension DependencyValues {
  var locationClient: LocationClient {
    get { self[LocationClientKey.self] }
    set { self[LocationClientKey.self] = newValue }
  }
}

// MARK: - LocationCoordinator (CoreLocation wrapper, iOS-only)

#if os(iOS)
/// Coordinates CoreLocation callbacks behind a Swift-concurrency surface.
/// Each request hands a continuation to the delegate; the delegate fires
/// it on `didUpdateLocations` / `didFailWithError` / authorization
/// changes. We use a class with `@unchecked Sendable` because
/// `CLLocationManager` is reference-typed and the coordinator instance
/// is process-singleton-style.
private final class LocationCoordinator: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
  private let manager: CLLocationManager
  private let queue = DispatchQueue(label: "com.dankdash.location.coordinator")
  private var authorizationContinuation: CheckedContinuation<LocationAuthorizationStatus, Never>?
  private var locationContinuation: CheckedContinuation<Coordinate, Error>?

  override init() {
    self.manager = CLLocationManager()
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
  }

  func currentAuthorizationStatus() -> LocationAuthorizationStatus {
    Self.translate(manager.authorizationStatus)
  }

  func requestAuthorization() async -> LocationAuthorizationStatus {
    let current = manager.authorizationStatus
    if current != .notDetermined {
      return Self.translate(current)
    }
    return await withCheckedContinuation { continuation in
      queue.async {
        self.authorizationContinuation = continuation
        DispatchQueue.main.async {
          self.manager.requestWhenInUseAuthorization()
        }
      }
    }
  }

  func requestCurrentLocation() async throws -> Coordinate {
    let status = manager.authorizationStatus
    guard status == .authorizedWhenInUse || status == .authorizedAlways else {
      throw LocationClientError.notAuthorized
    }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        self.locationContinuation = continuation
        DispatchQueue.main.async {
          self.manager.requestLocation()
        }
      }
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    queue.async {
      guard let continuation = self.authorizationContinuation else { return }
      self.authorizationContinuation = nil
      continuation.resume(returning: Self.translate(manager.authorizationStatus))
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    queue.async {
      guard let continuation = self.locationContinuation, let last = locations.last else { return }
      self.locationContinuation = nil
      continuation.resume(
        returning: Coordinate(latitude: last.coordinate.latitude, longitude: last.coordinate.longitude)
      )
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    queue.async {
      guard let continuation = self.locationContinuation else { return }
      self.locationContinuation = nil
      continuation.resume(throwing: LocationClientError.underlying(error.localizedDescription))
    }
  }

  static func translate(_ status: CLAuthorizationStatus) -> LocationAuthorizationStatus {
    switch status {
    case .notDetermined: .notDetermined
    case .restricted: .restricted
    case .denied: .denied
    case .authorizedAlways, .authorizedWhenInUse: .authorized
    @unknown default: .notDetermined
    }
  }
}
#endif
