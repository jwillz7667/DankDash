import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Password-reset entry point. Phase 16 implements the UX surface only —
/// the actual reset endpoint lands with the account-management work in
/// Phase 17. On submit we render the standard "check your email" copy
/// regardless of whether the address exists, to avoid leaking which
/// accounts are registered.
struct ForgotPasswordView: View {
  @Bindable var store: StoreOf<ForgotPasswordFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.sm) {
          DankLogo(.mark, size: 64)
          Text("Reset password")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
          Text("Enter the email tied to your account.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
        }

        DankCard {
          VStack(spacing: DankSpacing.md) {
            if store.submitted {
              VStack(spacing: DankSpacing.sm) {
                Text("Check your email")
                  .font(DankFont.headline)
                  .foregroundStyle(DankColor.Text.primary)
                Text("If an account exists for that address, we just sent reset instructions.")
                  .font(DankFont.bodySmall)
                  .foregroundStyle(DankColor.Text.secondary)
                  .multilineTextAlignment(.center)
              }
              DankButton(
                "Back to sign in",
                style: .primary,
                size: .large,
                action: { store.send(.dismissTapped) }
              )
            } else {
              DankInput(
                label: "Email",
                placeholder: "you@dankdash.test",
                text: Binding(
                  get: { store.email },
                  set: { store.send(.emailChanged($0)) }
                ),
                kind: .email
              )

              if let error = store.error {
                Text(error)
                  .font(DankFont.caption)
                  .foregroundStyle(DankColor.Semantic.danger)
                  .accessibilityIdentifier("forgotPassword.error")
              }

              DankButton(
                "Send reset link",
                style: .primary,
                size: .large,
                isLoading: store.isSubmitting,
                isDisabled: !store.canSubmit,
                action: { store.send(.submitTapped) }
              )

              DankButton(
                "Cancel",
                style: .ghost,
                size: .medium,
                action: { store.send(.dismissTapped) }
              )
            }
          }
          .frame(maxWidth: .infinity)
        }
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }
}
