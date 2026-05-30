import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// MN-required gate: 21+ confirmation before any cannabis surface
/// renders. The DOB picker drives a `DateOfBirth` value type whose
/// `isOver21(asOf:)` predicate must agree with the server-side check.
struct AgeGateView: View {
  @Bindable var store: StoreOf<AgeGateFeature>

  private let calendar = Calendar(identifier: .gregorian)

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        header
        dobCard
        continueButton
      }
      .padding(.horizontal, DankSpacing.lg)
      .padding(.vertical, DankSpacing.xl)
      .frame(maxWidth: 460)
      .frame(maxWidth: .infinity)
    }
    // Only scroll when the content can't fit (small device or large
    // Dynamic Type); otherwise it reads as a static single screen.
    .scrollBounceBehavior(.basedOnSize)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  private var header: some View {
    VStack(spacing: DankSpacing.sm) {
      DankLogo(.full, size: 52)
      Text("Welcome to DankDash")
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.primary)
        .multilineTextAlignment(.center)
      Text("Minnesota law requires you to confirm you're 21 or older.")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var dobCard: some View {
    DankCard {
      VStack(alignment: .leading, spacing: DankSpacing.md) {
        VStack(alignment: .leading, spacing: DankSpacing.xs) {
          Text("Date of birth")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          HStack {
            DatePicker(
              "Date of birth",
              selection: dobBinding,
              in: dobRange,
              displayedComponents: .date
            )
            .labelsHidden()
            .datePickerStyle(.compact)
            .tint(DankColor.primary)
            Spacer(minLength: 0)
          }
        }

        Toggle(isOn: acknowledgedBinding) {
          Text("I am 21 or older and agree to the terms.")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
        }
        .tint(DankColor.primary)

        if let error = store.error {
          Text(error)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Semantic.danger)
            .accessibilityIdentifier("ageGate.error")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var continueButton: some View {
    DankButton(
      "Continue",
      style: .primary,
      size: .large,
      isDisabled: !store.canSubmit,
      action: { store.send(.submitTapped) }
    )
  }

  // MARK: - DOB bridge

  /// Bridges the feature's discrete month/day/year fields to a single
  /// `Date` for the native picker, decomposing edits back into the
  /// individual `*Changed` actions so the reducer stays the source of
  /// truth (and its over-21 check is unaffected).
  private var dobBinding: Binding<Date> {
    Binding(
      get: {
        calendar.date(
          from: DateComponents(year: store.year, month: store.month, day: store.day)
        ) ?? Date.now
      },
      set: { newValue in
        let parts = calendar.dateComponents([.year, .month, .day], from: newValue)
        if let month = parts.month, month != store.month { store.send(.monthChanged(month)) }
        if let day = parts.day, day != store.day { store.send(.dayChanged(day)) }
        if let year = parts.year, year != store.year { store.send(.yearChanged(year)) }
      }
    )
  }

  private var acknowledgedBinding: Binding<Bool> {
    Binding(
      get: { store.acknowledged },
      set: { store.send(.acknowledgementToggled($0)) }
    )
  }

  private var dobRange: ClosedRange<Date> {
    let now = Date.now
    let oldest = calendar.date(byAdding: .year, value: -100, to: now) ?? now
    return oldest...now
  }
}
