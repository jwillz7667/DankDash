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

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.md) {
          DankLogo(.mark, size: 96)
          Text("Welcome to DankDash")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
            .fixedSize(horizontal: false, vertical: true)
          Text("Minnesota law requires you to confirm you're 21 or older.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
        }

        DankCard {
          VStack(alignment: .leading, spacing: DankSpacing.md) {
            Text("Date of birth")
              .font(DankFont.headline)
              .foregroundStyle(DankColor.Text.primary)

            DatePicker(
              "Date of birth",
              selection: dobBinding,
              in: dobRange,
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

            Toggle(isOn: Binding(
              get: { store.acknowledged },
              set: { store.send(.acknowledgementToggled($0)) }
            )) {
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

        DankButton(
          "Continue",
          style: .primary,
          size: .large,
          isDisabled: !store.canSubmit,
          action: { store.send(.submitTapped) }
        )
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  /// Valid DOB span: today back to 100 years ago. Bounding the picker
  /// keeps the wheel/calendar focused and forbids future dates.
  private var dobRange: ClosedRange<Date> {
    let calendar = Calendar(identifier: .gregorian)
    let now = Date()
    let oldest = calendar.date(byAdding: .year, value: -100, to: now) ?? now
    return oldest...now
  }

  /// Bridges the reducer's month/day/year Ints to a single `Date` so the
  /// compact DatePicker can drive them; each setter still flows through
  /// the existing actions, leaving `AgeGateFeature` untouched.
  private var dobBinding: Binding<Date> {
    Binding(
      get: {
        var components = DateComponents()
        components.year = store.year
        components.month = store.month
        components.day = store.day
        return Calendar(identifier: .gregorian).date(from: components) ?? Date()
      },
      set: { date in
        let components = Calendar(identifier: .gregorian)
          .dateComponents([.year, .month, .day], from: date)
        if let month = components.month { store.send(.monthChanged(month)) }
        if let day = components.day { store.send(.dayChanged(day)) }
        if let year = components.year { store.send(.yearChanged(year)) }
      }
    )
  }
}
