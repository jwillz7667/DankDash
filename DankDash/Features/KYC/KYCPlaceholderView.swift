import SwiftUI
import DankDashDesignSystem

/// Stub for Persona-backed identity verification. The actual SDK wiring
/// lands in Phase 17 when KYC graduates from "placeholder" to a required
/// step before catalog access. Today this view exists so the navigation
/// graph and the post-signup flow have a destination.
struct KYCPlaceholderView: View {
  let onBeginVerification: () -> Void

  var body: some View {
    VStack(spacing: DankSpacing.lg) {
      DankLogo(.mark, size: 64)

      VStack(spacing: DankSpacing.sm) {
        Text("Verify your identity")
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
        Text("Minnesota requires a one-time ID check before you can shop. We use Persona — it takes about 60 seconds.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
          .multilineTextAlignment(.center)
      }

      DankBadge("Phase 17", tone: .info)

      DankButton(
        "Begin verification",
        style: .primary,
        size: .large,
        action: onBeginVerification
      )
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }
}
