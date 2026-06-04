import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// First step of the driver onboarding flow. A simple explainer
/// surface — what the applicant is about to do, what documents they'll
/// need, and a single CTA into the vehicle-details form. The view
/// never owns state itself; the `Get Started` tap fires
/// ``DriverOnboardingFeature/Action/getStartedTapped`` which the
/// reducer turns into a step transition.
struct WelcomeView: View {
  @Bindable var store: StoreOf<DriverOnboardingFeature>
  let onSignOut: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        OnboardingStepIndicator(
          currentStep: store.currentStepIndex,
          totalSteps: DriverOnboardingFeature.State.totalSteps
        )

        VStack(spacing: DankSpacing.md) {
          DankLogo(.mark, size: 88)
          Text("Drive with DankDash")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
          Text("Three quick steps and we'll start your background check. You can resume any time — drafts save automatically.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.md)
        }

        DankCard {
          VStack(alignment: .leading, spacing: DankSpacing.sm) {
            Text("Have these ready")
              .font(DankFont.headline)
              .foregroundStyle(DankColor.Text.primary)
            checklistRow(icon: "person.text.rectangle", title: "Driver's license", subtitle: "Front side, MN-issued")
            checklistRow(icon: "doc.text.fill", title: "Vehicle insurance", subtitle: "Current declarations page")
            checklistRow(icon: "car.fill", title: "Vehicle registration", subtitle: "Most recent certificate")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        DankButton(
          "Get started",
          style: .primary,
          size: .large,
          action: { store.send(.getStartedTapped) }
        )

        DankButton(
          "Sign out",
          style: .ghost,
          size: .medium,
          action: onSignOut
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
  private func checklistRow(icon: String, title: String, subtitle: String) -> some View {
    HStack(alignment: .center, spacing: DankSpacing.md) {
      Image(systemName: icon)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
        .frame(width: 36, height: 36)
        .background(DankColor.primary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.sm, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(title)
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.primary)
        Text(subtitle)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.secondary)
      }
      Spacer(minLength: 0)
    }
  }
}
