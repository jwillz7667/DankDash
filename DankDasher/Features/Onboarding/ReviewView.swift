import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Step 4 — read-only summary of everything the applicant has entered.
/// Tap "Submit application" → reducer hits
/// ``DriverOnboardingAPIClient/submitApplication(_:)``. A 404 falls
/// through to the pending screen with ``queuedForOps = true``; the
/// view layer doesn't see that branch, but the next screen reads it.
struct ReviewView: View {
  @Bindable var store: StoreOf<DriverOnboardingFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        OnboardingStepIndicator(
          currentStep: store.currentStepIndex,
          totalSteps: DriverOnboardingFeature.State.totalSteps
        )

        VStack(spacing: DankSpacing.xs) {
          Text("Review")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
          Text("Check the details below. You'll be able to update them after we approve your application.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.md)
        }

        DankCard {
          VStack(alignment: .leading, spacing: DankSpacing.sm) {
            sectionHeader("Vehicle")
            summaryRow(label: "Make", value: store.draft.vehicle.make)
            summaryRow(label: "Model", value: store.draft.vehicle.model)
            summaryRow(label: "Year", value: store.draft.vehicle.year.map(String.init))
            summaryRow(label: "Plate", value: store.draft.vehicle.plate)
            summaryRow(label: "Color", value: store.draft.vehicle.color)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        DankCard {
          VStack(alignment: .leading, spacing: DankSpacing.sm) {
            sectionHeader("License")
            summaryRow(label: "License number", value: store.draft.licenseNumber.isEmpty ? nil : store.draft.licenseNumber)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        DankCard {
          VStack(alignment: .leading, spacing: DankSpacing.sm) {
            sectionHeader("Documents")
            ForEach(DocumentSlot.allCases, id: \.self) { slot in
              documentRow(slot: slot)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        if let error = store.submissionError {
          Text(error)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Semantic.danger)
            .accessibilityIdentifier("onboarding.review.error")
        }

        DankButton(
          "Submit application",
          style: .primary,
          size: .large,
          isLoading: store.isSubmittingDraft,
          isDisabled: !store.canSubmitApplication,
          action: { store.send(.reviewSubmitTapped) }
        )

        DankButton(
          "Back",
          style: .ghost,
          size: .medium,
          isDisabled: store.isSubmittingDraft,
          action: { store.send(.backTapped) }
        )
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  @ViewBuilder
  private func sectionHeader(_ title: String) -> some View {
    Text(title)
      .font(DankFont.headline)
      .foregroundStyle(DankColor.Text.primary)
  }

  @ViewBuilder
  private func summaryRow(label: String, value: String?) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
      Spacer()
      Text(value ?? "—")
        .font(DankFont.body)
        .foregroundStyle(value == nil ? DankColor.Text.muted : DankColor.Text.primary)
        .multilineTextAlignment(.trailing)
    }
  }

  @ViewBuilder
  private func documentRow(slot: DocumentSlot) -> some View {
    HStack(alignment: .center, spacing: DankSpacing.md) {
      Image(systemName: documentIcon(for: slot))
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
        .frame(width: 32, height: 32)
        .background(DankColor.primary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.sm, style: .continuous))
        .accessibilityHidden(true)
      Text(slot.displayLabel)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.primary)
      Spacer()
      if store.draft.documents[slot] != nil {
        DankBadge("Ready", tone: .success)
      } else {
        DankBadge("Missing", tone: .danger)
      }
    }
  }

  private func documentIcon(for slot: DocumentSlot) -> String {
    switch slot {
    case .driversLicense: "person.text.rectangle"
    case .vehicleInsurance: "doc.text.fill"
    case .vehicleRegistration: "car.fill"
    }
  }
}
