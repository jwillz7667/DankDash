import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Account creation form for drivers. The reused ``SignUpFeature``
/// hits the same backend register endpoint as the consumer; the
/// driver-specific provisioning happens later in onboarding (vehicle
/// + documents). Field-level validation mirrors the backend's
/// register DTO so an obvious typo never makes it across the wire.
struct SignUpView: View {
  @Bindable var store: StoreOf<SignUpFeature>
  let onLoginTapped: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.sm) {
          DankLogo(.full, size: 56)
          Text("Apply to drive")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
        }

        DankCard {
          VStack(spacing: DankSpacing.md) {
            HStack(spacing: DankSpacing.sm) {
              DankInput(
                label: "First name",
                text: Binding(
                  get: { store.firstName },
                  set: { store.send(.firstNameChanged($0)) }
                ),
                validation: validation(for: store.fieldErrors.firstName)
              )
              DankInput(
                label: "Last name",
                text: Binding(
                  get: { store.lastName },
                  set: { store.send(.lastNameChanged($0)) }
                ),
                validation: validation(for: store.fieldErrors.lastName)
              )
            }

            DankInput(
              label: "Email",
              placeholder: "you@dankdash.test",
              text: Binding(
                get: { store.email },
                set: { store.send(.emailChanged($0)) }
              ),
              kind: .email,
              validation: validation(for: store.fieldErrors.email)
            )

            DankInput(
              label: "Phone (optional)",
              placeholder: "+14155551234",
              text: Binding(
                get: { store.phone },
                set: { store.send(.phoneChanged($0)) }
              ),
              kind: .phone,
              validation: validation(for: store.fieldErrors.phone)
            )

            DankInput(
              label: "Password",
              text: Binding(
                get: { store.password },
                set: { store.send(.passwordChanged($0)) }
              ),
              kind: .secure,
              validation: validation(for: store.fieldErrors.password),
              helper: "12+ characters, must include a letter and a digit."
            )

            dobPicker

            if let error = store.error {
              Text(error)
                .font(DankFont.caption)
                .foregroundStyle(DankColor.Semantic.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("signUp.error")
            }

            DankButton(
              "Create account",
              style: .primary,
              size: .large,
              isLoading: store.isSubmitting,
              isDisabled: !store.canSubmit,
              action: { store.send(.submitTapped) }
            )
          }
          .frame(maxWidth: .infinity)
        }

        HStack(spacing: DankSpacing.xs) {
          Text("Already a driver?")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
          Button("Sign in", action: onLoginTapped)
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
  }

  private var dobPicker: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      Text("Date of birth")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.secondary)
      DatePicker(
        "Date of birth",
        selection: dobBinding,
        in: ...Date(),
        displayedComponents: .date
      )
      .labelsHidden()
      .datePickerStyle(.compact)
      .tint(DankColor.primary)
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.sm)
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(minHeight: 48)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.18), lineWidth: 1)
      )
      if let message = store.fieldErrors.dateOfBirth {
        Text(message)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Semantic.danger)
      }
    }
  }

  private var dobBinding: Binding<Date> {
    Binding(
      get: { dateFromDOB(store.dateOfBirth) ?? defaultAdultDate },
      set: { store.send(.dateOfBirthChanged(dobFromDate($0))) }
    )
  }

  private var defaultAdultDate: Date {
    Calendar(identifier: .gregorian).date(byAdding: .year, value: -30, to: Date()) ?? Date()
  }

  private func dateFromDOB(_ dob: DateOfBirth?) -> Date? {
    guard let dob else { return nil }
    var components = DateComponents()
    components.year = dob.year
    components.month = dob.month
    components.day = dob.day
    return Calendar(identifier: .gregorian).date(from: components)
  }

  private func dobFromDate(_ date: Date) -> DateOfBirth? {
    let components = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
    guard let year = components.year,
          let month = components.month,
          let day = components.day
    else { return nil }
    return DateOfBirth(year: year, month: month, day: day)
  }

  private func validation(for message: String?) -> DankInput.ValidationState {
    if let message { .invalid(message) } else { .idle }
  }
}
