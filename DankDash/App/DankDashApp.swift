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
