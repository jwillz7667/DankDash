import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Step 3 — driver picks each of the three required documents. Each
/// row owns its own ``SlotUploadState`` (idle / uploading / uploaded /
/// failed). A tap fires
/// ``DriverOnboardingFeature/Action/documentRowTapped`` which opens
/// the system picker (photo library for license, files picker for
/// insurance + registration), and a successful pick copies the file
/// into the on-disk draft store so a relaunch resumes from here.
///
/// "Continue" stays disabled until every slot is in ``.uploaded`` —
/// the reducer also re-checks this defensively on tap and surfaces a
/// reminder via ``submissionError`` if anything is missing.
struct DocumentsView: View {
  @Bindable var store: StoreOf<DriverOnboardingFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        OnboardingStepIndicator(
          currentStep: store.currentStepIndex,
          totalSteps: DriverOnboardingFeature.State.totalSteps
        )

        VStack(spacing: DankSpacing.xs) {
          Text("Documents")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
          Text("Tap a row to upload. Files stay on your device until your application is submitted.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.md)
        }

        VStack(spacing: DankSpacing.sm) {
          ForEach(DocumentSlot.allCases, id: \.self) { slot in
            DocumentUploadRow(
              slot: slot,
              state: rowState(for: slot),
              onTap: { store.send(.documentRowTapped(slot)) }
            )
            .accessibilityIdentifier("onboarding.document.\(slot.rawValue)")
          }
        }

        if let error = store.submissionError {
          Text(error)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Semantic.danger)
            .accessibilityIdentifier("onboarding.documents.error")
        }

        DankButton(
          "Continue",
          style: .primary,
          size: .large,
          isDisabled: !store.documentsCompleted,
          action: { store.send(.documentsContinueTapped) }
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
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  /// Maps the reducer's per-slot upload state onto the
  /// ``DocumentUploadRow`` design-system state. The two enums are
  /// intentionally similar but live in different layers — the design
  /// system has no domain dependency on the feature module.
  private func rowState(for slot: DocumentSlot) -> DocumentUploadRow.State {
    switch store.slotUploadStates[slot] ?? .idle {
    case .idle: .empty
    case .uploading: .uploading
    case .uploaded: .uploaded
    case .failed(let reason): .failed(reason: reason)
    }
  }
}
