import SwiftUI
import UIKit
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
        // The design system ships a single cream/ink light palette; pin
        // .light so the app doesn't inherit the device's dark appearance
        // (which left text on unstyled system-dark backgrounds).
        .preferredColorScheme(.light)
        // Clamp Dynamic Type one notch above default. The spacing/type
        // tokens are tuned for .large; uncapped accessibility sizes
        // overflowed the dense compliance and checkout screens.
        .dynamicTypeSize(.medium ... .xLarge)
        .onOpenURL { url in
          Self.store.send(.deepLinkReceived(url))
        }
    }
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
  private let registrar = PushTokenRegistrar(
    deviceIdKey: "com.dankdash.consumer.deviceId.fallback",
    apiClient: AppEnvironment.live.apiClient
  )

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
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
}
