import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures
import SafariServices

/// SwiftUI host for ``KYCFeature`` — the consumer identity-verification
/// flow. Explains why Minnesota requires the check, starts a Persona
/// inquiry, and presents the hosted flow in an `SFSafariViewController`.
///
/// Like ``CheckoutSafariView``, the reducer never holds the raw URL — it
/// carries a typed ``KYCInquiry`` and this view reads `inquiry.inquiryURL`.
/// The view owns opening + dismissing Safari and reports both lifecycle
/// events back to the reducer (`.safariOpened` / `.safariDismissed`). The
/// Persona webhook is authoritative server-side; on return the reducer
/// polls `/v1/me` for the `kycVerified` flip.
struct KYCView: View {
  @Bindable var store: StoreOf<KYCFeature>

  var body: some View {
    VStack(spacing: DankSpacing.md) {
      header
      Spacer(minLength: 0)
      content
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream.ignoresSafeArea())
    .fullScreenCover(
      isPresented: Binding(
        get: { store.presentableInquiry != nil },
        set: { _ in /* dismissal flows through the SafariView delegate */ }
      )
    ) {
      if let inquiry = store.presentableInquiry {
        PersonaSafariRepresentable(
          url: inquiry.inquiryURL,
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
      Spacer(minLength: 0)
      Button("Close") { store.send(.dismissTapped) }
        .font(DankFont.body.weight(.semibold))
        .foregroundStyle(DankColor.primary)
    }
  }

  // MARK: - Phase content

  @ViewBuilder private var content: some View {
    switch store.phase {
    case .intro:
      introContent

    case .starting:
      loading("Starting secure verification…")

    case .readyToOpen, .awaitingReturn:
      messageContent(
        systemImage: "person.text.rectangle.fill",
        tint: DankColor.primary,
        title: "Verification is opening",
        body: "Complete the ID check in the window that appears. This screen updates automatically when you return."
      )

    case .verifying:
      loading("Confirming your verification…")

    case .pendingReview:
      pendingReviewContent

    case .approved:
      messageContent(
        systemImage: "checkmark.seal.fill",
        tint: DankColor.Semantic.success,
        title: "You're verified",
        body: "Taking you back to checkout…"
      )

    case .failed:
      failedContent
    }
  }

  private var introContent: some View {
    VStack(spacing: DankSpacing.lg) {
      DankLogo(.mark, size: 64)

      VStack(spacing: DankSpacing.sm) {
        Text("Verify your identity")
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
        Text("Minnesota requires a one-time ID check before you can place a cannabis order. We use Persona — it takes about 60 seconds and opens in a secure browser.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
          .multilineTextAlignment(.center)
      }

      DankButton(
        "Begin verification",
        style: .primary,
        size: .large,
        action: { store.send(.beginTapped) }
      )
    }
  }

  private var pendingReviewContent: some View {
    VStack(spacing: DankSpacing.lg) {
      Image(systemName: "clock.badge.checkmark")
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(DankColor.primary)

      VStack(spacing: DankSpacing.sm) {
        Text("Almost there")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        Text("We're still confirming your verification. This can take a moment after you finish the ID check.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
          .multilineTextAlignment(.center)
      }

      VStack(spacing: DankSpacing.sm) {
        DankButton(
          "Check again",
          style: .primary,
          size: .large,
          action: { store.send(.checkAgainTapped) }
        )
        DankButton(
          "Start over",
          style: .secondary,
          size: .large,
          action: { store.send(.restartTapped) }
        )
      }
    }
  }

  private var failedContent: some View {
    VStack(spacing: DankSpacing.lg) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 40, weight: .semibold))
        .foregroundStyle(DankColor.Semantic.danger)

      VStack(spacing: DankSpacing.sm) {
        Text("Couldn't start verification")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        if let message = store.failureMessage {
          Text(message)
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
        }
      }

      DankButton(
        "Try again",
        style: .primary,
        size: .large,
        action: { store.send(.retryTapped) }
      )
    }
  }

  private func loading(_ message: String) -> some View {
    VStack(spacing: DankSpacing.md) {
      ProgressView().controlSize(.large)
      Text(message)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private func messageContent(
    systemImage: String,
    tint: Color,
    title: String,
    body: String
  ) -> some View {
    VStack(spacing: DankSpacing.md) {
      Image(systemName: systemImage)
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(tint)
      Text(title)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.primary)
        .multilineTextAlignment(.center)
      Text(body)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
    }
  }
}

/// Thin `UIViewControllerRepresentable` over `SFSafariViewController` for
/// the Persona hosted flow. Mirrors ``CheckoutSafariView``'s
/// representable: reader mode is force-disabled (the Persona flow is a
/// dynamic form), and `onDismiss` fires on both the user's "Done" tap and
/// a programmatic dismissal — the reducer's `.safariDismissed` treats
/// both the same and begins polling `/v1/me`.
private struct PersonaSafariRepresentable: UIViewControllerRepresentable {
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
    // The Safari controller owns its own URL once presented — a changed
    // inquiry URL would require a fresh presentation.
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
