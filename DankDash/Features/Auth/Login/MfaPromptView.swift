import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Sheet that takes over when the backend responds with `mfa_required`.
/// The 6-digit code field carries the existing `LoginFeature` challenge
/// so verifying lands the same auth tokens as the happy path.
struct MfaPromptView: View {
  @Bindable var store: StoreOf<LoginFeature>

  var body: some View {
    VStack(spacing: DankSpacing.lg) {
      VStack(spacing: DankSpacing.sm) {
        DankLogo(.mark, size: 64)
        Text("Two-factor code")
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
        Text("Enter the 6-digit code from your authenticator.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
          .multilineTextAlignment(.center)
      }

      DankInput(
        label: "Code",
        placeholder: "123456",
        text: Binding(
          get: { store.mfaCode },
          set: { store.send(.mfaCodeChanged($0)) }
        ),
        kind: .phone
      )

      if let error = store.mfaError {
        Text(error)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Semantic.danger)
          .accessibilityIdentifier("mfa.error")
      }

      DankButton(
        "Verify",
        style: .primary,
        size: .large,
        isLoading: store.isSubmitting,
        isDisabled: !store.canSubmitMfa,
        action: { store.send(.mfaVerifyTapped) }
      )

      Spacer(minLength: 0)
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(DankColor.cream)
  }
}
