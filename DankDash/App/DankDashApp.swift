import SwiftUI
import ComposableArchitecture
import DankDashFeatures

@main
struct DankDashApp: App {
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
    }
  }
}
