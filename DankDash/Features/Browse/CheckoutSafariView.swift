import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures
import SafariServices

/// SwiftUI host for ``CheckoutHandoffFeature``. Renders the spinner while
/// the one-shot token is in flight, surfaces failure copy + a retry CTA,
/// and presents the `SFSafariViewController` against `exchangeUrl` once
/// the token is in hand.
///
/// Apple §10.4: this is the only place in the consumer app that imports
/// `SafariServices`. The reducer never holds the URL — it only carries
/// the typed ``HandoffToken``. The view is responsible for opening +
/// dismissing the Safari sheet and reporting both lifecycle events back
/// to the reducer (`.safariOpened` / `.safariDismissed`).
struct CheckoutSafariView: View {
  @Bindable var store: StoreOf<CheckoutHandoffFeature>

  var body: some View {
    VStack(spacing: DankSpacing.md) {
      header
      content
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream.ignoresSafeArea())
    .onAppear { store.send(.onAppear) }
    .fullScreenCover(
      isPresented: Binding(
        get: { store.presentableToken != nil },
        set: { _ in /* dismissal flows through the SafariView delegate */ }
      )
    ) {
      if let token = store.presentableToken {
        SFSafariRepresentable(
          url: token.exchangeUrl,
          onAppear: { store.send(.safariOpened) },
          onDismiss: { store.send(.safariDismissed) }
        )
        .ignoresSafeArea()
      }
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack {
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text("Finish on dankdash.com")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        Text("Per App Store policy, checkout opens in Safari.")
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.secondary)
      }
      Spacer(minLength: 0)
      Button("Close") { store.send(.dismissTapped) }
        .font(DankFont.body.weight(.semibold))
        .foregroundStyle(DankColor.primary)
    }
    .padding(.top, DankSpacing.sm)
  }

  // MARK: - Status content

  @ViewBuilder private var content: some View {
    switch store.status {
    case .idle, .requesting:
      VStack(spacing: DankSpacing.md) {
        ProgressView().controlSize(.large)
        Text("Preparing a secure checkout link…")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
      }
      .padding(.top, DankSpacing.xl)

    case .readyToOpen, .awaitingDeepLink:
      VStack(spacing: DankSpacing.md) {
        Image(systemName: "safari.fill")
          .font(.system(size: 48, weight: .semibold))
          .foregroundStyle(DankColor.primary)
        Text("Safari is opening to finish your order.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.primary)
          .multilineTextAlignment(.center)
        Text("This window will close automatically when your order is placed.")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .multilineTextAlignment(.center)
      }
      .padding(.top, DankSpacing.xl)

    case .completed:
      VStack(spacing: DankSpacing.md) {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 48, weight: .semibold))
          .foregroundStyle(DankColor.Semantic.success)
        Text("Order placed!")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
      }
      .padding(.top, DankSpacing.xl)

    case .failed:
      VStack(spacing: DankSpacing.md) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 36, weight: .semibold))
          .foregroundStyle(DankColor.Semantic.danger)
        if let message = store.failureMessage {
          Text(message)
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.primary)
            .multilineTextAlignment(.center)
        }
        DankButton(
          "Retry",
          style: .primary,
          size: .medium,
          action: { store.send(.retryTapped) }
        )
        .padding(.horizontal, DankSpacing.xl)
      }
      .padding(.top, DankSpacing.xl)
    }
  }
}

/// Thin `UIViewControllerRepresentable` over `SFSafariViewController`.
/// Reader mode is force-disabled because the dankdash.com checkout is a
/// dynamic single-page form (reader mode would strip the inputs). The
/// `onDismiss` closure fires both on programmatic dismissal and on the
/// user's "Done" tap inside Safari — the reducer's `.safariDismissed`
/// action treats both the same.
private struct SFSafariRepresentable: UIViewControllerRepresentable {
  let url: URL
  let onAppear: () -> Void
  let onDismiss: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onDismiss: onDismiss) }

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let config = SFSafariViewController.Configuration()
    config.entersReaderIfAvailable = false
    config.barCollapsingEnabled = true
    let controller = SFSafariViewController(url: url, configuration: config)
    controller.preferredControlTintColor = UIColor(DankColor.primary)
    controller.dismissButtonStyle = .close
    controller.delegate = context.coordinator
    DispatchQueue.main.async { onAppear() }
    return controller
  }

  func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {
    // The Safari controller owns its own URL once presented — updates
    // to the published exchange URL would require a fresh presentation.
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
