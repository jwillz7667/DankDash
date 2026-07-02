import SwiftUI
import DankDashDesignSystem
import SafariServices

/// Thin `UIViewControllerRepresentable` over `SFSafariViewController` used to
/// present the Aeropay hosted bank-link flow. Mirrors the consumer app's
/// checkout Safari host: reader mode is force-disabled (the Aeropay flow is a
/// dynamic form) and `onDismiss` fires on both the user's "Done" tap and any
/// programmatic dismissal, so the reducer can re-query link status either way.
struct BankLinkSafariView: UIViewControllerRepresentable {
  let url: URL
  let onDismiss: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onDismiss: onDismiss) }

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let config = SFSafariViewController.Configuration()
    config.entersReaderIfAvailable = false
    config.barCollapsingEnabled = true
    let controller = SFSafariViewController(url: url, configuration: config)
    controller.preferredControlTintColor = UIColor(DankColor.primary)
    controller.dismissButtonStyle = .done
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {
    // The Safari controller owns its URL once presented; a changed session
    // URL would require a fresh presentation, which the reducer models by
    // clearing and re-setting `bankLinkSession`.
  }

  final class Coordinator: NSObject, SFSafariViewControllerDelegate {
    let onDismiss: () -> Void

    init(onDismiss: @escaping () -> Void) {
      self.onDismiss = onDismiss
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
      onDismiss()
    }
  }
}
