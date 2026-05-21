import Foundation
@preconcurrency import CoreLocation
import ComposableArchitecture
import DankDashDomain

/// How the driver app wants the device to deliver location samples.
///
/// `.standard` calls `CLLocationManager.startUpdatingLocation` with the
/// requested accuracy — used when battery is healthy and we want
/// frequent samples so the heatmap pin tracks the driver. `.significantChange`
/// switches to `startMonitoringSignificantLocationChanges`, which is
/// dramatically more battery-efficient (~500m / ~5min cadence) and is
/// what the shift reducer flips to under low-power conditions.
public enum LocationUpdateMode: Sendable, Equatable {
  case standard(accuracy: LocationAccuracy)
  case significantChange
}

/// Accuracy intent passed to `.standard` mode. Maps to CoreLocation's
/// `kCLLocationAccuracy*` constants inside the coordinator so reducers
/// don't import CoreLocation.
public enum LocationAccuracy: Sendable, Equatable {
  /// `kCLLocationAccuracyBest` — meters-level, GPS-on. The default for
  /// a healthy battery while online.
  case best
  /// `kCLLocationAccuracyNearestTenMeters` — used during active pickup
  /// / dropoff navigation.
  case nearestTenMeters
  /// `kCLLocationAccuracyHundredMeters` — battery-conservative default
  /// for "online but idle, waiting for a dispatch offer."
  case balanced
}

/// Errors surfaced by ``BackgroundLocationClient``. Reducers pattern
/// match these — no CoreLocation types leak past the client boundary.
public enum BackgroundLocationClientError: Error, Sendable, Equatable {
  case notAuthorized
  case unavailable
  case underlying(String)
}

/// `@DependencyClient`-style abstraction over the driver app's
/// long-lived CoreLocation stream. Peer of ``LocationClient`` (which is
/// for the consumer's one-shot lookups); separate seam because the
/// state machines and CoreLocation surfaces are different enough that
/// overloading one client with start/stop closures hurts readability.
public struct BackgroundLocationClient: Sendable {
  public var authorizationStatus: @Sendable () -> LocationAuthorizationStatus
  public var requestAlwaysAuthorization: @Sendable () async -> LocationAuthorizationStatus
  public var beginUpdates: @Sendable (LocationUpdateMode) async -> Void
  public var endUpdates: @Sendable () async -> Void
  public var setUpdateMode: @Sendable (LocationUpdateMode) async -> Void
  public var locationUpdates: @Sendable () -> AsyncStream<Coordinate>

  public init(
    authorizationStatus: @Sendable @escaping () -> LocationAuthorizationStatus,
    requestAlwaysAuthorization: @Sendable @escaping () async -> LocationAuthorizationStatus,
    beginUpdates: @Sendable @escaping (LocationUpdateMode) async -> Void,
    endUpdates: @Sendable @escaping () async -> Void,
    setUpdateMode: @Sendable @escaping (LocationUpdateMode) async -> Void,
    locationUpdates: @Sendable @escaping () -> AsyncStream<Coordinate>
  ) {
    self.authorizationStatus = authorizationStatus
    self.requestAlwaysAuthorization = requestAlwaysAuthorization
    self.beginUpdates = beginUpdates
    self.endUpdates = endUpdates
    self.setUpdateMode = setUpdateMode
    self.locationUpdates = locationUpdates
  }
}

public extension BackgroundLocationClient {
  /// Production binding — backed by a single ``BackgroundLocationCoordinator``
  /// that owns the long-lived `CLLocationManager` + the shared
  /// `AsyncStream<Coordinate>.Continuation`. iOS-only because CoreLocation's
  /// background-location features don't apply on macOS test builds.
  #if os(iOS)
  static let live: BackgroundLocationClient = {
    let coordinator = BackgroundLocationCoordinator()
    return BackgroundLocationClient(
      authorizationStatus: { coordinator.currentAuthorizationStatus() },
      requestAlwaysAuthorization: { await coordinator.requestAlwaysAuthorization() },
      beginUpdates: { mode in await coordinator.beginUpdates(mode: mode) },
      endUpdates: { await coordinator.endUpdates() },
      setUpdateMode: { mode in await coordinator.setUpdateMode(mode) },
      locationUpdates: { coordinator.locationStream() }
    )
  }()
  #else
  static let live: BackgroundLocationClient = .unimplemented
  #endif

  /// Test fixture — every closure returns the "denied / no-op / empty
  /// stream" branch so a forgotten dependency override surfaces as a
  /// test failure rather than a hung process.
  static let unimplemented = BackgroundLocationClient(
    authorizationStatus: { .notDetermined },
    requestAlwaysAuthorization: { .notDetermined },
    beginUpdates: { _ in },
    endUpdates: { },
    setUpdateMode: { _ in },
    locationUpdates: { AsyncStream { $0.finish() } }
  )

  /// Convenience factory for `TestStore`: hard-codes the auth status
  /// and replays the given coordinates through the stream in order.
  /// The stream finishes after the last coordinate so reducers using
  /// `for await` exit cleanly at end-of-shift.
  static func test(
    status: LocationAuthorizationStatus,
    coordinates: [Coordinate] = []
  ) -> BackgroundLocationClient {
    let buffer = LockIsolated<[Coordinate]>(coordinates)
    return BackgroundLocationClient(
      authorizationStatus: { status },
      requestAlwaysAuthorization: { status },
      beginUpdates: { _ in },
      endUpdates: { },
      setUpdateMode: { _ in },
      locationUpdates: {
        AsyncStream { continuation in
          for coord in buffer.value {
            continuation.yield(coord)
          }
          continuation.finish()
        }
      }
    )
  }
}

private enum BackgroundLocationClientKey: DependencyKey {
  static let liveValue: BackgroundLocationClient = .live
  static let testValue: BackgroundLocationClient = .unimplemented
}

public extension DependencyValues {
  var backgroundLocationClient: BackgroundLocationClient {
    get { self[BackgroundLocationClientKey.self] }
    set { self[BackgroundLocationClientKey.self] = newValue }
  }
}

// MARK: - BackgroundLocationCoordinator (CoreLocation wrapper, iOS-only)

#if os(iOS)
/// Owns the process-wide `CLLocationManager` for the driver app's
/// long-lived telemetry. Multiplexes the single CoreLocation delegate
/// stream into an `AsyncStream<Coordinate>` so reducers can `for await`
/// samples without touching CoreLocation. `@unchecked Sendable` follows
/// the ``LocationCoordinator`` precedent — `CLLocationManager` is
/// reference-typed and not `Sendable`, but the coordinator is a
/// process-singleton whose mutations all funnel through a serial queue.
private final class BackgroundLocationCoordinator: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
  private let manager: CLLocationManager
  private let queue = DispatchQueue(label: "com.dankdash.background-location.coordinator")
  /// The active stream's continuation, if any. Re-created on each
  /// `locationStream()` call so a reducer restart gets a fresh stream
  /// instead of replaying the previous shift's samples.
  private var continuation: AsyncStream<Coordinate>.Continuation?
  private var authorizationContinuation: CheckedContinuation<LocationAuthorizationStatus, Never>?
  private var activeMode: LocationUpdateMode?
  private var isUpdating: Bool = false

  override init() {
    self.manager = CLLocationManager()
    super.init()
    manager.delegate = self
    // `allowsBackgroundLocationUpdates` is the iOS toggle that lets the
    // app continue receiving samples while suspended; requires the
    // `location` UIBackgroundMode key in Info.plist + an `Always`
    // authorization grant from the user.
    manager.allowsBackgroundLocationUpdates = true
    // Default-on auto-pause undermines a shift telemetry stream — if
    // iOS decides the driver's "stationary" it stops updating, then
    // resumes silently later. We pause manually instead via shift end.
    manager.pausesLocationUpdatesAutomatically = false
    manager.showsBackgroundLocationIndicator = true
  }

  // MARK: Auth

  func currentAuthorizationStatus() -> LocationAuthorizationStatus {
    Self.translate(manager.authorizationStatus)
  }

  func requestAlwaysAuthorization() async -> LocationAuthorizationStatus {
    let current = manager.authorizationStatus
    switch current {
    case .authorizedAlways:
      return .authorizedAlways
    case .denied, .restricted:
      return Self.translate(current)
    case .notDetermined, .authorizedWhenInUse:
      return await withCheckedContinuation { continuation in
        queue.async {
          self.authorizationContinuation = continuation
          DispatchQueue.main.async {
            // From `whenInUse` this becomes a one-shot Always prompt;
            // from `notDetermined` it's the initial whenInUse → Always
            // two-step that iOS dictates. Either way the next delegate
            // callback resolves the continuation.
            self.manager.requestAlwaysAuthorization()
          }
        }
      }
    @unknown default:
      return .notDetermined
    }
  }

  // MARK: Updates

  func beginUpdates(mode: LocationUpdateMode) {
    queue.async {
      guard self.continuation != nil else {
        // No active stream — `locationStream()` must be called first.
        // Cache the mode so a subsequent `locationStream()` + immediate
        // begin reuses it consistently.
        self.activeMode = mode
        return
      }
      self.applyMode(mode)
    }
  }

  func endUpdates() {
    queue.async {
      self.isUpdating = false
      let manager = self.manager
      let previousMode = self.activeMode
      self.activeMode = nil
      DispatchQueue.main.async {
        switch previousMode {
        case .significantChange:
          manager.stopMonitoringSignificantLocationChanges()
        case .standard, nil:
          manager.stopUpdatingLocation()
        }
      }
    }
  }

  func setUpdateMode(_ mode: LocationUpdateMode) {
    queue.async {
      self.applyMode(mode)
    }
  }

  /// Returns a fresh AsyncStream — each call replaces the previous
  /// continuation so a stream torn down by reducer cancellation can be
  /// re-subscribed cleanly on the next shift start.
  func locationStream() -> AsyncStream<Coordinate> {
    AsyncStream { newContinuation in
      queue.async {
        self.continuation?.finish()
        self.continuation = newContinuation
        if let mode = self.activeMode {
          self.applyMode(mode)
        }
      }
      newContinuation.onTermination = { [weak self] _ in
        self?.queue.async {
          if self?.continuation != nil {
            self?.continuation = nil
          }
        }
      }
    }
  }

  // MARK: CLLocationManagerDelegate

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    queue.async {
      guard let continuation = self.authorizationContinuation else { return }
      self.authorizationContinuation = nil
      continuation.resume(returning: Self.translate(manager.authorizationStatus))
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    queue.async {
      guard let last = locations.last else { return }
      let coord = Coordinate(latitude: last.coordinate.latitude, longitude: last.coordinate.longitude)
      self.continuation?.yield(coord)
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // CoreLocation surfaces transient errors on every device (network
    // route changes, momentary GPS denial, etc.). Failing the entire
    // stream on the first hiccup would tank the shift; we swallow and
    // wait for the next successful sample.
  }

  // MARK: Mode application

  private func applyMode(_ mode: LocationUpdateMode) {
    let manager = self.manager
    let previousMode = self.activeMode
    self.activeMode = mode
    self.isUpdating = true
    DispatchQueue.main.async {
      // Stop whatever was active so a swap from .standard → .significantChange
      // doesn't leave us subscribed to both APIs simultaneously.
      switch previousMode {
      case .significantChange:
        manager.stopMonitoringSignificantLocationChanges()
      case .standard:
        manager.stopUpdatingLocation()
      case .none:
        break
      }
      switch mode {
      case .standard(let accuracy):
        manager.desiredAccuracy = Self.translate(accuracy: accuracy)
        manager.startUpdatingLocation()
      case .significantChange:
        manager.startMonitoringSignificantLocationChanges()
      }
    }
  }

  // MARK: Translators

  static func translate(_ status: CLAuthorizationStatus) -> LocationAuthorizationStatus {
    switch status {
    case .notDetermined: .notDetermined
    case .restricted: .restricted
    case .denied: .denied
    case .authorizedAlways: .authorizedAlways
    case .authorizedWhenInUse: .authorizedWhenInUse
    @unknown default: .notDetermined
    }
  }

  static func translate(accuracy: LocationAccuracy) -> CLLocationAccuracy {
    switch accuracy {
    case .best: kCLLocationAccuracyBest
    case .nearestTenMeters: kCLLocationAccuracyNearestTenMeters
    case .balanced: kCLLocationAccuracyHundredMeters
    }
  }
}
#endif
