import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// MN-required gate: a 21+ attestation before any cannabis surface renders
/// (Minn. Stat. §342.27). No date of birth is collected — a self-attested
/// DOB adds no assurance over the attestation, and the authoritative age
/// checks happen at KYC and again at the driver's government-ID scan on
/// delivery. Tapping "I am 21 or older" records the attestation and opens
/// the gate; "I am under 21" surfaces the block message and keeps it shut.
struct AgeGateView: View {
  @Bindable var store: StoreOf<AgeGateFeature>

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(spacing: DankSpacing.xl) {
          Spacer(minLength: DankSpacing.lg)

          VStack(spacing: DankSpacing.md) {
            DankLogo(.mark, size: 72)

            Text("Welcome to DankDash")
              .font(DankFont.title)
              .foregroundStyle(DankColor.Text.primary)
              .multilineTextAlignment(.center)

            Text("You must be 21 or older to order cannabis in Minnesota.")
              .font(DankFont.body)
              .foregroundStyle(DankColor.Text.secondary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
          }

          DankCard {
            VStack(alignment: .leading, spacing: DankSpacing.md) {
              disclaimerRow(
                systemImage: "checkmark.seal.fill",
                text: "I confirm I am 21 years of age or older."
              )
              disclaimerRow(
                systemImage: "person.text.rectangle.fill",
                text: "I'll show a valid government-issued photo ID to the driver at delivery. Orders can't be handed over without it."
              )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }

          Spacer(minLength: DankSpacing.lg)

          VStack(spacing: DankSpacing.sm) {
            if let error = store.error {
              Text(error)
                .font(DankFont.caption)
                .foregroundStyle(DankColor.Semantic.danger)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("ageGate.error")
            }

            DankButton(
              "I am 21 or older",
              style: .primary,
              size: .large,
              action: { store.send(.confirmTapped) }
            )
            .accessibilityIdentifier("ageGate.confirm")

            DankButton(
              "I am under 21",
              style: .ghost,
              size: .medium,
              action: { store.send(.declineTapped) }
            )
            .accessibilityIdentifier("ageGate.decline")

            Text("By continuing you agree to DankDash's Terms of Service and Privacy Policy.")
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
              .multilineTextAlignment(.center)
              .padding(.top, DankSpacing.xxs)
          }
        }
        .padding(DankSpacing.lg)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity)
        .frame(minHeight: proxy.size.height)
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
  }

  /// One line of the at-a-glance disclaimer: an SF Symbol bullet plus the
  /// attestation copy. Top-aligned so multi-line text hangs cleanly off
  /// the icon column.
  private func disclaimerRow(systemImage: String, text: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      Image(systemName: systemImage)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(DankColor.primary)
        .frame(width: 24)
        .accessibilityHidden(true)

      Text(text)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
