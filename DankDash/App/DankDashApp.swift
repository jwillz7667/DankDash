import SwiftUI
import UIKit
import UserNotifications
import ComposableArchitecture
import DankDashFeatures
import DankDashNetwork

@main
struct DankDashApp: App {
  /// The UIApplicationDelegateAdaptor is required so iOS routes APNs
  /// registration callbacks (`didRegisterForRemoteNotificationsWithDeviceToken`
  /// + `didFailToRegisterForRemoteNotificationsWithError`) through a
  /// concrete delegate. SwiftUI's scene lifecycle has no equivalent
  /// hook today.
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  @MainActor
  static let store = Store(initialState: RootFeature.State()) {
    RootFeature()
  } withDependencies: { dependencies in
    AppEnvironment.live.prepareDependencies(&dependencies)
  }

  var body: some Scene {
    WindowGroup {
      RootView(store: Self.store)
        .preferredColorScheme(.dark)
        .onOpenURL { url in
          // Phase-18 deep-link surface. `RootFeature` parses via
          // `DeepLinkRouter.route(_:)`; unknown URLs are silently
          // ignored, so it's safe to forward every URL that lands here.
          Self.store.send(.deepLinkReceived(url))
        }
    }
  }
}

/// UIApplicationDelegate shim with two responsibilities:
///
/// 1. Bridge APNs delegate callbacks into the shared
///    ``PushNotificationClient/live`` coordinator so reducers / the
///    forwarder below observe tokens via ``PushNotificationClient/tokenUpdates``.
/// 2. Drive the registration pipeline on first launch — request
///    `UNUserNotificationCenter` authorization, call
///    `UIApplication.shared.registerForRemoteNotifications`, then drain
///    the resulting token stream into `POST /v1/notifications/register-device`.
///    The server endpoint is a Phase-18 stub (200 without persisting);
///    Phase 19 turns it into a `push_tokens` upsert without changing
///    the iOS call site.
final class AppDelegate: NSObject, UIApplicationDelegate {
  /// Long-lived forwarder task. Held so it isn't auto-cancelled by ARC;
  /// not explicitly cancelled because the underlying APNs stream is
  /// bounded by the app process lifetime.
  private var tokenForwardingTask: Task<Void, Never>?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Kick off the authorization + registration sequence. The
    // notification-center prompt only appears the first time; subsequent
    // launches read the cached decision without re-prompting per Apple's
    // `requestAuthorization` contract.
    Task { @MainActor in
      let client = PushNotificationClient.live
      let granted = await client.requestAuthorization()
      guard granted else { return }
      await client.registerForRemoteNotifications()
    }

    // Drain the token stream for the lifetime of the process. iOS may
    // re-issue a device token (e.g. after a restore), so we keep
    // consuming rather than taking just the first event.
    tokenForwardingTask = Task { [weak self] in
      await self?.forwardAPNsTokens()
    }
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    PushNotificationClient.live.submitDeviceToken(deviceToken)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    PushNotificationClient.live.submitRegistrationFailure(error)
  }

  /// Iterates ``PushNotificationClient/tokenUpdates`` and forwards every
  /// successful registration to the server. Failures are swallowed — the
  /// stub endpoint isn't a hard dependency for the rest of the app, and
  /// the next launch re-tries via the same delegate callback. Phase 19
  /// adds explicit retry semantics once the endpoint is non-stub.
  private func forwardAPNsTokens() async {
    let client = PushNotificationClient.live
    let env = AppEnvironment.live
    let deviceId = await Self.resolvedDeviceId()
    for await update in client.tokenUpdates() {
      guard case .registered(let data) = update else { continue }
      let hex = data.map { String(format: "%02x", $0) }.joined()
      let request = RegisterDeviceRequestDTO(apnsToken: hex, deviceId: deviceId)
      let endpoint = NotificationsEndpoints.registerDevice(body: request)
      _ = try? await env.apiClient.send(endpoint)
    }
  }

  /// Returns ``UIDevice/identifierForVendor``, falling back to a
  /// persisted UUID if the system can't yield one (rare — happens for
  /// a brief window after first install on some iOS versions). The
  /// fallback lives in standard UserDefaults since it isn't sensitive;
  /// the server side uses it solely as a stable device key.
  @MainActor
  private static func resolvedDeviceId() async -> UUID {
    if let vendorId = UIDevice.current.identifierForVendor {
      return vendorId
    }
    let key = "com.dankdash.consumer.deviceId.fallback"
    let defaults = UserDefaults.standard
    if let raw = defaults.string(forKey: key), let uuid = UUID(uuidString: raw) {
      return uuid
    }
    let generated = UUID()
    defaults.set(generated.uuidString, forKey: key)
    return generated
  }
}
