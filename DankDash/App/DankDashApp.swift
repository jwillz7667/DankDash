import SwiftUI
import UIKit
import UserNotifications
import ComposableArchitecture
import DankDashFeatures
import DankDashNetwork

@main
struct DankDashApp: App {
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
        // The design system is a light theme (cream surfaces, dark-green
        // ink). Forcing .dark made system controls (Picker, Toggle,
        // DatePicker, secure fields) render dark chrome on cream — illegible.
        // Pin to .light so app surfaces and system controls agree, matching
        // the driver app.
        .preferredColorScheme(.light)
        .dynamicTypeSize(.medium ... .accessibility1)
        .onOpenURL { url in
          Self.store.send(.deepLinkReceived(url))
        }
    }
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  private let registrar = PushTokenRegistrar(
    deviceIdKey: "com.dankdash.consumer.deviceId.fallback",
    appVariant: .consumer,
    apiClient: AppEnvironment.live.apiClient
  )

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Own foreground presentation + tap routing for the lifecycle pushes
    // the backend already emits (accepted/ready/picked_up/arrived/delivered).
    UNUserNotificationCenter.current().delegate = self
    registrar.bootstrap()
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    registrar.didRegister(deviceToken)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    registrar.didFailToRegister(error)
  }

  // MARK: - UNUserNotificationCenterDelegate

  /// Show order-lifecycle pushes while the app is foregrounded — the
  /// consumer is usually staring at the tracking screen when these land,
  /// and a silent drop reads as "nothing happened".
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound, .badge])
  }

  /// Route a tapped lifecycle push to its order's tracking screen. The
  /// backend stamps every order push with a top-level `orderId` (see
  /// `apns.provider.ts`); we rebuild the canonical deep link
  /// (`dankdash://order/complete?orderId=<uuid>`) that `DeepLinkRouter`
  /// already recognizes rather than introduce a second routing path.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    let userInfo = response.notification.request.content.userInfo
    guard
      let raw = userInfo["orderId"] as? String,
      let orderId = UUID(uuidString: raw),
      let url = Self.orderTrackingDeepLink(orderId: orderId)
    else { return }
    DankDashApp.store.send(.deepLinkReceived(url))
  }

  /// Builds the deep link `DeepLinkRouter` parses for an order push. Kept
  /// in sync with that router by construction — scheme `dankdash`, host
  /// `order`, path `complete`, `orderId` query carrying the UUID.
  private static func orderTrackingDeepLink(orderId: UUID) -> URL? {
    var components = URLComponents()
    components.scheme = "dankdash"
    components.host = "order"
    components.path = "/complete"
    components.queryItems = [URLQueryItem(name: "orderId", value: orderId.uuidString)]
    return components.url
  }
}
