import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Pre-prompt sheet presented before iOS's system Always-location prompt.
/// The system only ever shows that prompt once — if we ask the user
/// cold and they hit deny, the only recovery is a trip to Settings. So
/// we explain the why first, then let the user choose to trigger the
/// system prompt via "Allow location access," which dispatches
/// ``DriverShiftFeature/Action/locationRationaleAllowTapped`` (the
/// reducer calls `requestAlwaysAuthorization` on the
/// `BackgroundLocationClient` from there). "Not now" maps to
/// ``locationRationaleDismissed``.
struct AuthorizationRationaleView: View {
  let onAllow: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.md) {
          Image(systemName: "location.fill")
            .font(.system(size: 56, weight: .semibold))
            .foregroundStyle(DankColor.primary)
            .padding(DankSpacing.md)
            .background(DankColor.primary.opacity(0.10))
            .clipShape(Circle())
            .accessibilityHidden(true)

          Text("Location access keeps you earning")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
            .multilineTextAlignment(.center)

          Text("DankDasher needs your location while online so dispatch can route nearby offers to you, navigate you to pickups and dropoffs, and share your live ETA with the customer you're delivering to.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.sm)
        }

        DankCard {
          VStack(alignment: .leading, spacing: DankSpacing.sm) {
            bulletRow(
              icon: "circle.fill",
              title: "Choose Always",
              copy: "We pause tracking when you go offline. Background updates only run during an active shift."
            )
            bulletRow(
              icon: "battery.75",
              title: "Battery-aware throttling",
              copy: "Low-battery mode automatically switches to significant-change updates to conserve charge."
            )
            bulletRow(
              icon: "hand.raised.fill",
              title: "You stay in control",
              copy: "Going offline tears down tracking immediately. We never ping when you're off shift."
            )
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        VStack(spacing: DankSpacing.sm) {
          DankButton(
            "Allow location access",
            style: .primary,
            size: .large,
            action: onAllow
          )
          .accessibilityIdentifier("shift.rationale.allow")

          DankButton(
            "Not now",
            style: .ghost,
            size: .medium,
            action: onDismiss
          )
          .accessibilityIdentifier("shift.rationale.dismiss")
        }
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  @ViewBuilder
  private func bulletRow(icon: String, title: String, copy: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.md) {
      Image(systemName: icon)
        .font(DankFont.body)
        .foregroundStyle(DankColor.primary)
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(title)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        Text(copy)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.secondary)
      }
      Spacer(minLength: 0)
    }
  }
}
