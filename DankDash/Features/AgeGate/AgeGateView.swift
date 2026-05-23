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
          DankLogo(.full, size: 96)
          Text("Welcome to DankDash")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
            .multilineTextAlignment(.center)
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

            HStack(spacing: DankSpacing.sm) {
              numericPicker(
                title: "Month",
                range: 1...12,
                selection: Binding(
                  get: { store.month },
                  set: { store.send(.monthChanged($0)) }
                )
              )
              numericPicker(
                title: "Day",
                range: 1...31,
                selection: Binding(
                  get: { store.day },
                  set: { store.send(.dayChanged($0)) }
                )
              )
              numericPicker(
                title: "Year",
                range: yearRange,
                selection: Binding(
                  get: { store.year },
                  set: { store.send(.yearChanged($0)) }
                )
              )
            }

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
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  private var yearRange: ClosedRange<Int> {
    let currentYear = Calendar(identifier: .gregorian).component(.year, from: Date())
    return (currentYear - 100)...currentYear
  }

  @ViewBuilder
  private func numericPicker(
    title: String,
    range: ClosedRange<Int>,
    selection: Binding<Int>
  ) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      Text(title)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.secondary)
      Picker(title, selection: selection) {
        ForEach(Array(range), id: \.self) { value in
          Text(String(value)).tag(value)
        }
      }
      .pickerStyle(.menu)
      .tint(DankColor.primary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, DankSpacing.sm)
      .frame(minHeight: 48)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.18), lineWidth: 1)
      )
    }
  }
}
