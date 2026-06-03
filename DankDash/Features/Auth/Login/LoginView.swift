import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Email + password sign-in. When the reducer flips `mfaChallengeId`
/// non-nil the second-factor sheet takes over the surface; tokens land
/// via the parent only after MFA verifies.
struct LoginView: View {
  @Bindable var store: StoreOf<LoginFeature>
  let onSignUpTapped: () -> Void
  let onForgotPasswordTapped: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.sm) {
          DankLogo(.mark, size: 96)
          Text("Sign in")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }

        DankCard {
          VStack(spacing: DankSpacing.md) {
            DankInput(
              label: "Email",
              placeholder: "you@dankdash.test",
              text: Binding(
                get: { store.email },
                set: { store.send(.emailChanged($0)) }
              ),
              kind: .email
            )
            DankInput(
              label: "Password",
              text: Binding(
                get: { store.password },
                set: { store.send(.passwordChanged($0)) }
              ),
              kind: .secure
            )

            if let error = store.error {
              Text(error)
                .font(DankFont.caption)
                .foregroundStyle(DankColor.Semantic.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("login.error")
            }

            DankButton(
              "Sign in",
              style: .primary,
              size: .large,
              isLoading: store.isSubmitting,
              isDisabled: !store.canSubmit,
              action: { store.send(.loginTapped) }
            )

            DankButton(
              "Forgot password?",
              style: .ghost,
              size: .small,
              action: onForgotPasswordTapped
            )
          }
          .frame(maxWidth: .infinity)
        }

        HStack(spacing: DankSpacing.xs) {
          Text("New to DankDash?")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
          Button("Create an account", action: onSignUpTapped)
            .font(DankFont.bodySmall.weight(.semibold))
            .foregroundStyle(DankColor.primary)
        }
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
    .sheet(
      isPresented: Binding(
        get: { store.mfaChallengeId != nil },
        set: { _ in }
      )
    ) {
      MfaPromptView(store: store)
        .presentationDetents([.medium, .large])
    }
  }
}
