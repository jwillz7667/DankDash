import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Email + password sign-in. Reused from the consumer target — the
/// underlying ``LoginFeature`` is parent-agnostic and emits a
/// `Delegate` on success, so the driver root listens identically.
/// MFA challenge surfaces via the same sheet as the consumer.
struct LoginView: View {
  @Bindable var store: StoreOf<LoginFeature>
  let onSignUpTapped: () -> Void
  let onForgotPasswordTapped: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.sm) {
          DankLogo(.full, size: 56)
          Text("Driver sign in")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
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
          Text("New to DankDasher?")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
          Button("Apply to drive", action: onSignUpTapped)
            .font(DankFont.bodySmall.weight(.semibold))
            .foregroundStyle(DankColor.primary)
        }
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
    }
    .scrollBounceBehavior(.basedOnSize)
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
