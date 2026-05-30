import SwiftUI
import UIKit
import ComposableArchitecture
import DankDashFeatures
import DankDashNetwork

@main
struct DankDasherApp: App {
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
        // Clamp Dynamic Type one notch above default. The spacing/type
        // tokens are tuned for .large; uncapped accessibility sizes
        // overflowed the driver route, earnings, and handoff screens.
        .dynamicTypeSize(.medium ... .xLarge)
        .onOpenURL { url in
          Self.store.send(.deepLinkReceived(url))
        }
    }
  }
}

final class DankDasherAppDelegate: NSObject, UIApplicationDelegate {
  private let registrar = PushTokenRegistrar(
    deviceIdKey: "com.dankdash.driver.deviceId.fallback",
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
