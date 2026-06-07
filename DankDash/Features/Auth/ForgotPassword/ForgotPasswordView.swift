import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Password-reset flow. Two steps against the backend reset surface:
/// request a code by email, then redeem the code with a new password. The
/// request step never confirms or denies that an address is registered (to
/// avoid leaking account existence) — submitting always advances to the code
/// entry step.
struct ForgotPasswordView: View {
  @Bindable var store: StoreOf<ForgotPasswordFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        header

        DankCard {
          VStack(spacing: DankSpacing.md) {
            switch store.step {
            case .request:
              requestStep
            case .redeem:
              redeemStep
            case .done:
              doneStep
            }
          }
          .frame(maxWidth: .infinity)
        }
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  private var header: some View {
    VStack(spacing: DankSpacing.sm) {
      DankLogo(.mark, size: 64)
      Text("Reset password")
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.primary)
      Text(headerSubtitle)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var headerSubtitle: String {
    switch store.step {
    case .request: "Enter the email tied to your account."
    case .redeem: "Enter the code we emailed you and choose a new password."
    case .done: "You're all set."
    }
  }

  // MARK: - Steps

  private var requestStep: some View {
    Group {
      DankInput(
        label: "Email",
        placeholder: "you@dankdash.test",
        text: Binding(
          get: { store.email },
          set: { store.send(.emailChanged($0)) }
        ),
        kind: .email
      )

      errorText

      DankButton(
        "Send reset code",
        style: .primary,
        size: .large,
        isLoading: store.isSubmitting,
        isDisabled: !store.canRequest,
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

  private var redeemStep: some View {
    Group {
      Text("If an account exists for that address, we just sent a reset code.")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)

      DankInput(
        label: "Reset code",
        placeholder: "XXXX-XXXX-XXXX",
        text: Binding(
          get: { store.code },
          set: { store.send(.codeChanged($0)) }
        ),
        kind: .text
      )

      DankInput(
        label: "New password",
        placeholder: "New password",
        text: Binding(
          get: { store.newPassword },
          set: { store.send(.newPasswordChanged($0)) }
        ),
        kind: .secure,
        helper: "At least 12 characters, with a letter and a number."
      )

      errorText

      DankButton(
        "Reset password",
        style: .primary,
        size: .large,
        isLoading: store.isSubmitting,
        isDisabled: !store.canRedeem,
        action: { store.send(.resetTapped) }
      )

      DankButton(
        "Cancel",
        style: .ghost,
        size: .medium,
        action: { store.send(.dismissTapped) }
      )
    }
  }

  private var doneStep: some View {
    Group {
      VStack(spacing: DankSpacing.sm) {
        Text("Password updated")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        Text("Your password has been changed and you've been signed out everywhere. Sign in with your new password.")
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
    }
  }

  @ViewBuilder
  private var errorText: some View {
    if let error = store.error {
      Text(error)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityIdentifier("forgotPassword.error")
    }
  }
}
