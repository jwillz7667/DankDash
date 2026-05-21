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
private final class BatteryMonitorCoordinator: @unchecked Sendable {
  private let device = UIDevice.current
  private let center = NotificationCenter.default
  private let queue = DispatchQueue(label: "com.dankdash.battery-monitor.coordinator")

  init() {
    // `isBatteryMonitoringEnabled` defaults to false — without flipping
    // it on, `batteryLevel` returns `-1` and notifications never fire.
    DispatchQueue.main.async {
      self.device.isBatteryMonitoringEnabled = true
    }
  }

  func currentSnapshot() -> BatterySnapshot {
    let raw = device.batteryLevel
    let level: Double? = raw < 0 ? nil : Double(raw)
    return BatterySnapshot(
      level: level,
      state: Self.translate(device.batteryState),
      isLowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled
    )
  }

  func eventStream() -> AsyncStream<BatterySnapshot> {
    AsyncStream { continuation in
      let level = self.center.addObserver(
        forName: UIDevice.batteryLevelDidChangeNotification,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        guard let self else { return }
        continuation.yield(self.currentSnapshot())
      }
      let state = self.center.addObserver(
        forName: UIDevice.batteryStateDidChangeNotification,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        guard let self else { return }
        continuation.yield(self.currentSnapshot())
      }
      let lowPower = self.center.addObserver(
        forName: NSNotification.Name.NSProcessInfoPowerStateDidChange,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        guard let self else { return }
        continuation.yield(self.currentSnapshot())
      }
      continuation.onTermination = { [weak self] _ in
        self?.center.removeObserver(level)
        self?.center.removeObserver(state)
        self?.center.removeObserver(lowPower)
      }
    }
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
