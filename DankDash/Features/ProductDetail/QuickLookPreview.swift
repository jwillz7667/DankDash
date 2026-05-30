import SwiftUI
import QuickLook

/// `UIViewControllerRepresentable` wrapper around `QLPreviewController`.
/// We hand it a single local file URL (the COA PDF the reducer downloads
/// into `URL.cachesDirectory`) and present it modally from
/// `ProductDetailView` via `.sheet`.
struct QuickLookPreview: UIViewControllerRepresentable {
  let fileURL: URL
  let onDismiss: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(fileURL: fileURL, onDismiss: onDismiss)
  }

  func makeUIViewController(context: Context) -> UINavigationController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    controller.delegate = context.coordinator

    let nav = UINavigationController(rootViewController: controller)
    controller.navigationItem.rightBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .done,
      target: context.coordinator,
      action: #selector(Coordinator.dismissTapped)
    )
    return nav
  }

  func updateUIViewController(_ uiViewController: UINavigationController, context: Context) {
    context.coordinator.fileURL = fileURL
    context.coordinator.onDismiss = onDismiss
    if let qlPreview = uiViewController.viewControllers.first as? QLPreviewController {
      qlPreview.reloadData()
    }
  }

  final class Coordinator: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    var fileURL: URL
    var onDismiss: () -> Void

    init(fileURL: URL, onDismiss: @escaping () -> Void) {
      self.fileURL = fileURL
      self.onDismiss = onDismiss
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
      fileURL as QLPreviewItem
    }

    func previewControllerWillDismiss(_ controller: QLPreviewController) {
      onDismiss()
    }

    @objc func dismissTapped() {
      onDismiss()
    }
  }
}
