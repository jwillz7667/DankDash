import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// First-launch rationale screen for CoreLocation. Lives in front of the
/// feed surface until the user grants or skips location access. "Continue
/// without location" still drops them on the feed — the API returns the
/// most popular dispensaries when no coordinate is supplied — but the
/// ordering is less personal.
struct LocationPermissionPromptView: View {
  @Bindable var store: StoreOf<DispensaryFeedFeature>

  var body: some View {
    VStack(spacing: DankSpacing.lg) {
      Spacer(minLength: 0)

      VStack(spacing: DankSpacing.md) {
        Image(systemName: "location.circle.fill")
          .font(.system(size: 88, weight: .light))
          .foregroundStyle(DankColor.primary.opacity(0.75))
          .accessibilityHidden(true)

        Text("Show me what's nearby")
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
          .multilineTextAlignment(.center)

        Text("Turn on location so DankDash can show dispensaries that deliver to your address. We never share your location with third parties.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.horizontal, DankSpacing.lg)

      Spacer(minLength: 0)

      VStack(spacing: DankSpacing.sm) {
        DankButton(
          "Enable location",
          style: .primary,
          size: .large,
          isLoading: store.isLoading,
          action: { store.send(.enableLocationTapped) }
        )
        DankButton(
          "Continue without location",
          style: .ghost,
          size: .medium,
          action: { store.send(.continueWithoutLocationTapped) }
        )
      }
      .padding(.horizontal, DankSpacing.lg)
      .padding(.bottom, DankSpacing.xl)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
    .accessibilityElement(children: .contain)
  }
}
