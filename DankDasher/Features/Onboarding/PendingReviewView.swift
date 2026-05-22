import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Terminal screen of the onboarding flow. Renders one of two
/// messages depending on ``DriverOnboardingFeature/State/queuedForOps``:
///
/// - `false` — application accepted by the backend. Copy: "We're
///   reviewing your application." Reducer polls `GET /v1/driver/me`
///   every 30s; when the response shows
///   ``Driver/isBackgroundCheckPassed = true`` the reducer fires
///   `.delegate(.onboardingComplete)` which the parent
///   ``DriverRootFeature`` listens for to route into the shift home.
/// - `true` — the backend onboarding endpoint isn't built yet (404
///   tolerated per Phase 19 plan). Copy: "Your application is queued
///   — an admin will reach out." The reducer still polls so the moment
///   the endpoint lands the same path graduates.
///
/// The badge under the headline reflects
/// ``BackgroundCheckStatus/from(driver:)`` if the reducer has cached
/// a driver record; otherwise it shows "Not started."
struct PendingReviewView: View {
  @Bindable var store: StoreOf<DriverOnboardingFeature>
  let onSignOut: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        VStack(spacing: DankSpacing.md) {
          DankLogo(.mark, size: 88)
          Text(headline)
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
            .multilineTextAlignment(.center)
          Text(supportingCopy)
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.md)
        }

        DankCard {
          VStack(spacing: DankSpacing.sm) {
            Text("Background check")
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.secondary)
            BackgroundCheckStatusBadge(status: backgroundCheckStatus)
              .accessibilityIdentifier("onboarding.pending.backgroundCheckBadge")
            if let pollError = store.pendingPollError {
              Text(pollError)
                .font(DankFont.caption)
                .foregroundStyle(DankColor.Semantic.danger)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("onboarding.pending.pollError")
            }
          }
          .frame(maxWidth: .infinity)
        }

        DankButton(
          "Refresh status",
          style: .primary,
          size: .large,
          action: { store.send(.pendingRefreshTapped) }
        )

        DankButton(
          "Sign out",
          style: .ghost,
          size: .medium,
          action: onSignOut
        )

        Text("We poll automatically every 30 seconds while this screen is open.")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .multilineTextAlignment(.center)
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 560)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  private var headline: String {
    store.queuedForOps ? "Application queued" : "Application submitted"
  }

  private var supportingCopy: String {
    if store.queuedForOps {
      return "We've saved your details on your device. An admin will reach out shortly — once they create your driver record you'll be able to start shifts."
    }
    return "We're running your background check. This typically takes 24 to 48 hours. We'll notify you the moment you're cleared."
  }

  private var backgroundCheckStatus: BackgroundCheckStatus {
    guard let driver = store.driver else { return .notStarted }
    return BackgroundCheckStatus.from(driver: driver)
  }
}
