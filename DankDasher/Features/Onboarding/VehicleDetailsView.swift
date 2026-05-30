import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Step 2 — driver fills in vehicle make/model/year/plate/color and
/// their driver's license number. The form is gated by
/// ``DriverOnboardingFeature/State/isVehicleFormComplete`` (all five
/// vehicle fields filled in) AND
/// ``isLicenseNumberValid`` (non-empty trimmed). Continue stays
/// disabled until both pass; a tap with an incomplete form surfaces
/// the reducer's "Fill out every field" message via
/// ``submissionError``.
struct VehicleDetailsView: View {
  @Bindable var store: StoreOf<DriverOnboardingFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        OnboardingStepIndicator(
          currentStep: store.currentStepIndex,
          totalSteps: DriverOnboardingFeature.State.totalSteps
        )

        VStack(spacing: DankSpacing.xs) {
          Text("Your vehicle")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
          Text("Tell us what you'll be driving. Make sure the plate matches your registration exactly.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.md)
        }

        DankCard {
          VStack(spacing: DankSpacing.md) {
            DankInput(
              label: "Make",
              placeholder: "Toyota",
              text: Binding(
                get: { store.makeInput },
                set: { store.send(.makeChanged($0)) }
              )
            )
            DankInput(
              label: "Model",
              placeholder: "Prius",
              text: Binding(
                get: { store.modelInput },
                set: { store.send(.modelChanged($0)) }
              )
            )
            DankInput(
              label: "Year",
              placeholder: "2021",
              text: Binding(
                get: { store.yearInput },
                set: { store.send(.yearChanged($0)) }
              )
            )
            DankInput(
              label: "Plate",
              placeholder: "ABC-1234",
              text: Binding(
                get: { store.plateInput },
                set: { store.send(.plateChanged($0)) }
              )
            )
            DankInput(
              label: "Color",
              placeholder: "Silver",
              text: Binding(
                get: { store.colorInput },
                set: { store.send(.colorChanged($0)) }
              )
            )
            DankInput(
              label: "Driver's license number",
              placeholder: "MN-XXXXXXX",
              text: Binding(
                get: { store.licenseNumberInput },
                set: { store.send(.licenseNumberChanged($0)) }
              )
            )
          }
          .frame(maxWidth: .infinity)
        }

        if let error = store.submissionError {
          Text(error)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Semantic.danger)
            .accessibilityIdentifier("onboarding.vehicle.error")
        }

        DankButton(
          "Continue",
          style: .primary,
          size: .large,
          isDisabled: !(store.isVehicleFormComplete && store.isLicenseNumberValid),
          action: { store.send(.vehicleContinueTapped) }
        )

        DankButton(
          "Back",
          style: .ghost,
          size: .medium,
          action: { store.send(.backTapped) }
        )
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }
}
