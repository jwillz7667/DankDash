import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Edit-profile form. The backend only permits self-service edits to the
/// first and last name (`PATCH /v1/me`); email is shown read-only because
/// changing it is a step-up-gated flow that lives elsewhere. Saving pops
/// back to the hub via the feature's `saved` delegate.
struct ProfileEditView: View {
  @Bindable var store: StoreOf<ProfileEditFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        DankCard {
          VStack(spacing: DankSpacing.md) {
            DankInput(
              label: "First name",
              placeholder: "First name",
              text: Binding(
                get: { store.firstName },
                set: { store.send(.firstNameChanged($0)) }
              ),
              kind: .text
            )

            DankInput(
              label: "Last name",
              placeholder: "Last name",
              text: Binding(
                get: { store.lastName },
                set: { store.send(.lastNameChanged($0)) }
              ),
              kind: .text
            )

            emailField

            errorText

            DankButton(
              "Save changes",
              style: .primary,
              size: .large,
              isLoading: store.isSubmitting,
              isDisabled: !store.canSave,
              action: { store.send(.saveTapped) }
            )

            DankButton(
              "Cancel",
              style: .ghost,
              size: .medium,
              action: { store.send(.cancelTapped) }
            )
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
    .navigationTitle("Edit profile")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var emailField: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      Text("Email")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.secondary)
      Text(store.email)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.muted)
      Text("Contact support to change the email on your account.")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private var errorText: some View {
    if let error = store.error {
      Text(error)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityIdentifier("profileEdit.error")
    }
  }
}
