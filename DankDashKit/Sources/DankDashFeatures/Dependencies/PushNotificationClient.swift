import Foundation
import ComposableArchitecture
#if canImport(UIKit)
import UIKit
import UserNotifications
#endif

/// One delivery from the APNs registration pipeline. `registered` carries
/// the raw device-token bytes (NOT yet hex-encoded — the caller does that
/// before posting to the server). `failed` carries the localized
/// description so the reducer can route to telemetry / retry without
/// reaching back into `UIKit`.
public enum PushNotificationToken: Sendable, Equatable {
  case registered(Data)
  case failed(String)
}

/// `@DependencyClient`-style abstraction over ``UNUserNotificationCenter``
/// + APNs registration. Reducers depend on this struct so reducer tests
/// substitute closures rather than touching the system notification
/// center.
///
/// The token round-trip is split: the app delegate forwards the
/// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` /
/// `didFailToRegisterForRemoteNotificationsWithError` callbacks into
/// ``submitDeviceToken`` / ``submitRegistrationFailure``, and the
/// reducer subscribes to ``tokenUpdates`` to receive them.
public struct PushNotificationClient: Sendable {
  /// Triggers the system authorization sheet (alert + badge + sound).
  /// Returns `true` if the user granted, `false` if denied or in error.
  /// Subsequent calls after a decision return the existing decision
  /// without re-prompting.
  public var requestAuthorization: @Sendable () async -> Bool

  /// Calls `UIApplication.shared.registerForRemoteNotifications()`. The
  /// system asynchronously fires the delegate methods; the app delegate
  /// is responsible for forwarding the result via ``submitDeviceToken``
  /// or ``submitRegistrationFailure``.
  public var registerForRemoteNotifications: @Sendable () async -> Void

  /// Forwards an APNs device-token from the UIApplicationDelegate
  /// callback into the token stream.
  public var submitDeviceToken: @Sendable (Data) -> Void

  /// Forwards an APNs registration failure into the token stream.
  public var submitRegistrationFailure: @Sendable (Error) -> Void

  /// Stream of every delivery — registration success or failure. The
  /// live binding shares a single underlying stream across subscribers;
  /// reducers should iterate exactly once and store the latest value
  /// in state.
  public var tokenUpdates: @Sendable () -> AsyncStream<PushNotificationToken>

  public init(
    requestAuthorization: @Sendable @escaping () async -> Bool,
    registerForRemoteNotifications: @Sendable @escaping () async -> Void,
    submitDeviceToken: @Sendable @escaping (Data) -> Void,
    submitRegistrationFailure: @Sendable @escaping (Error) -> Void,
    tokenUpdates: @Sendable @escaping () -> AsyncStream<PushNotificationToken>
  ) {
    self.requestAuthorization = requestAuthorization
    self.registerForRemoteNotifications = registerForRemoteNotifications
    self.submitDeviceToken = submitDeviceToken
    self.submitRegistrationFailure = submitRegistrationFailure
    self.tokenUpdates = tokenUpdates
  }
}

public extension PushNotificationClient {
  /// Production binding. Only available on iOS — `UIApplication` and
  /// `UNUserNotificationCenter` register-for-remote APIs are iOS-only,
  /// and the consumer app is iOS-only. On macOS (which we build only
  /// for `swift test` of pure-Swift surfaces) the live binding falls
  /// back to the `.unimplemented` fixture.
  #if canImport(UIKit)
  static let live: PushNotificationClient = {
    let coordinator = PushNotificationCoordinator()
    return PushNotificationClient(
      requestAuthorization: { await coordinator.requestAuthorization() },
      registerForRemoteNotifications: { await coordinator.registerForRemoteNotifications() },
      submitDeviceToken: { token in coordinator.submitDeviceToken(token) },
      submitRegistrationFailure: { error in coordinator.submitRegistrationFailure(error) },
      tokenUpdates: { coordinator.tokenUpdates }
    )
  }()
  #else
  static let live: PushNotificationClient = .unimplemented
  #endif

  /// Test fixture that denies authorization and never yields tokens.
  /// Tests that need a successful registration path substitute the
  /// `submitDeviceToken` closure backed by a shared continuation.
  static let unimplemented: PushNotificationClient = {
    let (stream, _) = AsyncStream<PushNotificationToken>.makeStream()
    return PushNotificationClient(
      requestAuthorization: { false },
      registerForRemoteNotifications: { },
      submitDeviceToken: { _ in },
      submitRegistrationFailure: { _ in },
      tokenUpdates: { stream }
    )
  }()
}

private enum PushNotificationClientKey: DependencyKey {
  static let liveValue: PushNotificationClient = .live
  static let testValue: PushNotificationClient = .unimplemented
}

public extension DependencyValues {
  var pushNotificationClient: PushNotificationClient {
    get { self[PushNotificationClientKey.self] }
    set { self[PushNotificationClientKey.self] = newValue }
  }
}

// MARK: - PushNotificationCoordinator (UIKit + UserNotifications, iOS-only)

#if canImport(UIKit)
/// Owns the single APNs token stream and routes UIApplicationDelegate
/// callbacks into it. Reference-typed because the app delegate forwards
/// callbacks via a shared instance, and `@unchecked Sendable` because
/// `UNUserNotificationCenter` and `UIApplication` are reference types
/// the wrapper hands off without exposing.
private final class PushNotificationCoordinator: @unchecked Sendable {
  let tokenUpdates: AsyncStream<PushNotificationToken>
  private let continuation: AsyncStream<PushNotificationToken>.Continuation

  init() {
    let (stream, continuation) = AsyncStream<PushNotificationToken>.makeStream(
      bufferingPolicy: .bufferingNewest(8)
    )
    self.tokenUpdates = stream
    self.continuation = continuation
  }

  func requestAuthorization() async -> Bool {
    let center = UNUserNotificationCenter.current()
    do {
      return try await center.requestAuthorization(options: [.alert, .badge, .sound])
    } catch {
      return false
    }
  }

  @MainActor
  func registerForRemoteNotifications() async {
    UIApplication.shared.registerForRemoteNotifications()
  }

  func submitDeviceToken(_ token: Data) {
    continuation.yield(.registered(token))
  }

  func submitRegistrationFailure(_ error: Error) {
    continuation.yield(.failed(error.localizedDescription))
  }
}
#endif
