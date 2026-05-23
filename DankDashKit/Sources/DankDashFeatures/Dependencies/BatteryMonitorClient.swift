import Foundation
#if canImport(UIKit)
@preconcurrency import UIKit
#endif
import ComposableArchitecture

/// Snapshot of the device's battery state read at one point in time.
///
/// `level` is in `0...1`; CoreFoundation reports `-1` when the level is
/// unknown (simulator, USB powered without battery, etc.) — the client
/// translates that to `nil` so reducers don't accidentally treat
/// "unknown" as "critical."
public struct BatterySnapshot: Sendable, Equatable {
  public let level: Double?
  public let state: BatteryState
  public let isLowPowerModeEnabled: Bool

  public init(level: Double?, state: BatteryState, isLowPowerModeEnabled: Bool) {
    self.level = level
    self.state = state
    self.isLowPowerModeEnabled = isLowPowerModeEnabled
  }

  /// True when the device is in the threshold the shift reducer uses
  /// to swap to ``LocationUpdateMode.significantChange`` (≤ 20% on
  /// battery, or iOS Low Power Mode active). Kept on the snapshot so
  /// the rule lives in one place — reducers don't recompute the
  /// threshold inline.
  public var shouldThrottleForBattery: Bool {
    if isLowPowerModeEnabled { return true }
    guard let level else { return false }
    // Charging skips the throttle — driver's plugged in, no reason
    // to degrade tracking accuracy.
    if state == .charging || state == .full { return false }
    return level <= 0.20
  }
}

public enum BatteryState: Sendable, Equatable {
  case unknown
  case unplugged
  case charging
  case full
}

/// `@DependencyClient`-style abstraction over `UIDevice.batteryLevel` +
/// `batteryState` + `ProcessInfo.isLowPowerModeEnabled`. iOS only —
/// macOS test builds fall back to `.unimplemented`.
public struct BatteryMonitorClient: Sendable {
  public var snapshot: @Sendable () -> BatterySnapshot
  public var events: @Sendable () -> AsyncStream<BatterySnapshot>

  public init(
    snapshot: @Sendable @escaping () -> BatterySnapshot,
    events: @Sendable @escaping () -> AsyncStream<BatterySnapshot>
  ) {
    self.snapshot = snapshot
    self.events = events
  }
}

public extension BatteryMonitorClient {
  #if os(iOS)
  static let live: BatteryMonitorClient = {
    let coordinator = BatteryMonitorCoordinator()
    return BatteryMonitorClient(
      snapshot: { coordinator.currentSnapshot() },
      events: { coordinator.eventStream() }
    )
  }()
  #else
  static let live: BatteryMonitorClient = .unimplemented
  #endif

  static let unimplemented = BatteryMonitorClient(
    snapshot: {
      BatterySnapshot(level: nil, state: .unknown, isLowPowerModeEnabled: false)
    },
    events: { AsyncStream { $0.finish() } }
  )

  /// Convenience factory for `TestStore`: hard-codes the initial
  /// snapshot and the sequence of events the reducer should observe.
  static func test(
    initial: BatterySnapshot,
    events: [BatterySnapshot] = []
  ) -> BatteryMonitorClient {
    let buffer = LockIsolated<[BatterySnapshot]>(events)
    let current = LockIsolated<BatterySnapshot>(initial)
    return BatteryMonitorClient(
      snapshot: { current.value },
      events: {
        AsyncStream { continuation in
          for snap in buffer.value {
            current.setValue(snap)
            continuation.yield(snap)
          }
          continuation.finish()
        }
      }
    )
  }
}

private enum BatteryMonitorClientKey: DependencyKey {
  static let liveValue: BatteryMonitorClient = .live
  static let testValue: BatteryMonitorClient = .unimplemented
}

public extension DependencyValues {
  var batteryMonitorClient: BatteryMonitorClient {
    get { self[BatteryMonitorClientKey.self] }
    set { self[BatteryMonitorClientKey.self] = newValue }
  }
}

// MARK: - BatteryMonitorCoordinator (iOS-only)

#if os(iOS)
/// Caches the latest battery snapshot read on `MainActor` so callers
/// from any actor can pull the value synchronously without crossing
/// the UIKit isolation domain on every read. The cache is refreshed
/// on `batteryLevelDidChange`, `batteryStateDidChange`, and
/// `NSProcessInfoPowerStateDidChange` notifications, all of which we
/// subscribe to on the main queue so the refresh itself runs in a
/// `MainActor`-safe context.
///
/// This indirection exists because `UIDevice.current` and its battery
/// properties are annotated `@MainActor` in the iOS overlay; calling
/// them directly from the `@Sendable` closures backing the
/// `BatteryMonitorClient` snapshot/events API would otherwise force
/// the entire interface to be async. The obj-c implementations are
/// documented as thread-safe — caching just lets us honor the Swift
/// overlay's isolation without paying for an actor hop at call time.
private final class BatteryMonitorCoordinator: @unchecked Sendable {
  private let cached: LockIsolated<BatterySnapshot>
  nonisolated(unsafe) private let center = NotificationCenter.default

  init() {
    self.cached = LockIsolated(
      BatterySnapshot(level: nil, state: .unknown, isLowPowerModeEnabled: false)
    )
    let cache = self.cached
    Task { @MainActor in
      let device = UIDevice.current
      device.isBatteryMonitoringEnabled = true
      let raw = device.batteryLevel
      cache.setValue(BatterySnapshot(
        level: raw < 0 ? nil : Double(raw),
        state: BatteryMonitorCoordinator.translate(device.batteryState),
        isLowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled
      ))
    }
  }

  func currentSnapshot() -> BatterySnapshot {
    cached.value
  }

  func eventStream() -> AsyncStream<BatterySnapshot> {
    AsyncStream { continuation in
      let observers = LockIsolated<[NSObjectProtocol]>([])

      observers.withValue { tokens in
        tokens.append(
          self.center.addObserver(
            forName: UIDevice.batteryLevelDidChangeNotification,
            object: nil,
            queue: .main
          ) { [weak self] _ in
            self?.handleNotification(continuation: continuation)
          }
        )
        tokens.append(
          self.center.addObserver(
            forName: UIDevice.batteryStateDidChangeNotification,
            object: nil,
            queue: .main
          ) { [weak self] _ in
            self?.handleNotification(continuation: continuation)
          }
        )
        tokens.append(
          self.center.addObserver(
            forName: NSNotification.Name.NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: .main
          ) { [weak self] _ in
            self?.handleNotification(continuation: continuation)
          }
        )
      }

      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        observers.withValue { tokens in
          tokens.forEach { self.center.removeObserver($0) }
          tokens.removeAll()
        }
      }
    }
  }

  /// Observer block runs on `.main` (per `queue:` in `addObserver`) so
  /// we're already on the main thread when this fires; `assumeIsolated`
  /// is therefore safe and gives us a synchronous read of UIDevice
  /// without an actor hop. Updates the cache before yielding so
  /// consumers observe the same value as `currentSnapshot()`.
  private func handleNotification(
    continuation: AsyncStream<BatterySnapshot>.Continuation
  ) {
    let snapshot = MainActor.assumeIsolated { Self.computeSnapshotOnMain() }
    cached.setValue(snapshot)
    continuation.yield(snapshot)
  }

  /// Static so the call site doesn't bring instance isolation into the
  /// picture — caller is responsible for being on `MainActor`.
  @MainActor
  private static func computeSnapshotOnMain() -> BatterySnapshot {
    let device = UIDevice.current
    let raw = device.batteryLevel
    return BatterySnapshot(
      level: raw < 0 ? nil : Double(raw),
      state: translate(device.batteryState),
      isLowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled
    )
  }

  static func translate(_ state: UIDevice.BatteryState) -> BatteryState {
    switch state {
    case .unknown: .unknown
    case .unplugged: .unplugged
    case .charging: .charging
    case .full: .full
    @unknown default: .unknown
    }
  }
}
#endif
