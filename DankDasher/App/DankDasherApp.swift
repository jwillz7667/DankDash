import SwiftUI
import UIKit
import UserNotifications
import ComposableArchitecture
import DankDashFeatures
import DankDashNetwork

/// `@main` entry point for the DankDasher driver app. Sibling target to
/// `DankDash` (consumer). Reuses the shared `DankDashKit` package and
/// composes the same `LiveAuthInterceptor`-backed `APIClient`, plus the
/// driver-specific live bindings (location, battery, shift, heatmap,
/// onboarding, session/draft stores). The single `Store` is bound to
/// `DriverRootFeature` and survives view rebuilds.
@main
struct DankDasherApp: App {
  /// `UIApplicationDelegateAdaptor` is required so iOS routes APNs
  /// registration callbacks through a concrete delegate — SwiftUI's
  /// scene lifecycle still has no equivalent hook. Same pattern as the
  /// consumer app's `AppDelegate`.
  @UIApplicationDelegateAdaptor(DankDasherAppDelegate.self) private var appDelegate

  @MainActor
  static let store = Store(initialState: DriverRootFeature.State()) {
    DriverRootFeature()
  } withDependencies: { dependencies in
    AppEnvironment.live.prepareDependencies(&dependencies)
  }

  var body: some Scene {
    WindowGroup {
      RootView(store: Self.store)
        .preferredColorScheme(.light)
        .dynamicTypeSize(.medium ... .accessibility1)
        .onOpenURL { url in
          // Phase 19 plumbing: forward every URL into the reducer.
          // Phase 20 introduces the `dankdasher://offer/<id>` route
          // table for the dispatch-offer push hand-off; until then
          // the reducer stashes the URL without parsing.
          Self.store.send(.deepLinkReceived(url))
        }
    }
  }
}

/// `UIApplicationDelegate` shim with two responsibilities, mirroring
/// the consumer's `AppDelegate`:
///
/// 1. Bridge APNs delegate callbacks into the shared
///    ``PushNotificationClient/live`` coordinator so reducers / the
///    forwarder below observe tokens via
///    ``PushNotificationClient/tokenUpdates``.
/// 2. Drive the registration pipeline on first launch — request
///    `UNUserNotificationCenter` authorization, call
///    `UIApplication.shared.registerForRemoteNotifications`, then
///    drain the resulting token stream into
///    `POST /v1/notifications/register-device`. The server endpoint
///    is the same Phase 18 stub the consumer hits; the driver app
///    surfaces here so when dispatch-offer pushes land in Phase 20
///    the registration path already exists.
final class DankDasherAppDelegate: NSObject, UIApplicationDelegate {
  private var tokenForwardingTask: Task<Void, Never>?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    Task { @MainActor in
      let client = PushNotificationClient.live
      let granted = await client.requestAuthorization()
      guard granted else { return }
      await client.registerForRemoteNotifications()
    }

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

  @MainActor
  private static func resolvedDeviceId() async -> UUID {
    if let vendorId = UIDevice.current.identifierForVendor {
      return vendorId
    }
    let key = "com.dankdash.driver.deviceId.fallback"
    let defaults = UserDefaults.standard
    if let raw = defaults.string(forKey: key), let uuid = UUID(uuidString: raw) {
      return uuid
    }
    let generated = UUID()
    defaults.set(generated.uuidString, forKey: key)
    return generated
  }
}
