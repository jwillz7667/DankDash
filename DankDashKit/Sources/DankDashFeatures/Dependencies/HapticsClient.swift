import Foundation
import ComposableArchitecture
#if canImport(UIKit)
import UIKit
#endif

/// Thin TCA dependency seam over `UIImpactFeedbackGenerator` and
/// `UINotificationFeedbackGenerator`. The DankDasher offer card pings a
/// `warning` haptic when an offer is presented (the driver may be
/// looking at the map and miss a silent sheet); the active-route screen
/// uses `impact(.medium)` for milestone transitions (pickup confirmed,
/// arrived at dropoff).
///
/// The live binding is `@MainActor` because `UIFeedbackGenerator` and
/// every subclass MUST be created and invoked from the main thread.
/// The `async` boundary on each closure makes the main-actor hop
/// transparent to callers — reducers issue
/// `await haptics.notify(.warning)` from the effect runloop and the
/// hop happens inside the closure.
///
/// On macOS / Linux (test runners build the kit for the host platform)
/// the entire client compiles down to no-ops via `#if canImport(UIKit)`.
/// The `testValue` is always the same no-op closure so TCA reducer
/// tests never need to override the dependency.
public struct HapticsClient: Sendable {
  public var notify: @Sendable (NotificationType) async -> Void
  public var impact: @Sendable (ImpactStyle) async -> Void

  public init(
    notify: @Sendable @escaping (NotificationType) async -> Void,
    impact: @Sendable @escaping (ImpactStyle) async -> Void
  ) {
    self.notify = notify
    self.impact = impact
  }

  public enum NotificationType: Sendable, Equatable {
    case success
    case warning
    case error
  }

  public enum ImpactStyle: Sendable, Equatable {
    case light
    case medium
    case heavy
    case rigid
    case soft
  }
}

public extension HapticsClient {
  /// Background-thread-safe live binding. Closures hop to the main
  /// actor before instantiating the generator (a UIKit requirement).
  static let live: HapticsClient = {
    #if canImport(UIKit)
    return HapticsClient(
      notify: { type in
        await MainActor.run {
          let generator = UINotificationFeedbackGenerator()
          generator.prepare()
          switch type {
          case .success: generator.notificationOccurred(.success)
          case .warning: generator.notificationOccurred(.warning)
          case .error: generator.notificationOccurred(.error)
          }
        }
      },
      impact: { style in
        await MainActor.run {
          let mapped: UIImpactFeedbackGenerator.FeedbackStyle = switch style {
          case .light: .light
          case .medium: .medium
          case .heavy: .heavy
          case .rigid: .rigid
          case .soft: .soft
          }
          let generator = UIImpactFeedbackGenerator(style: mapped)
          generator.prepare()
          generator.impactOccurred()
        }
      }
    )
    #else
    return .noop
    #endif
  }()

  /// No-op implementation. Used as `testValue` and as the live binding
  /// on non-UIKit platforms.
  static let noop = HapticsClient(
    notify: { _ in },
    impact: { _ in }
  )
}

private enum HapticsClientKey: DependencyKey {
  static let liveValue: HapticsClient = .live
  static let testValue: HapticsClient = .noop
}

public extension DependencyValues {
  var hapticsClient: HapticsClient {
    get { self[HapticsClientKey.self] }
    set { self[HapticsClientKey.self] = newValue }
  }
}
