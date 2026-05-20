import SwiftUI

@main
struct DankDashApp: App {
  var body: some Scene {
    WindowGroup {
      BootstrapView()
    }
  }
}

private struct BootstrapView: View {
  var body: some View {
    VStack(spacing: 12) {
      Text("DankDash")
        .font(.largeTitle.bold())
      Text("Consumer iOS scaffold")
        .foregroundStyle(.secondary)
    }
    .padding()
  }
}
