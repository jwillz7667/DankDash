import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// SwiftUI shell for ``IDScanFeature``. Wraps the design-system
/// ``IDScanLaunchView`` and routes its CTAs to the reducer. The reducer
/// fires ``IDScanFeature/Delegate/confirmed`` when the scan passes and
/// ``DriverRootFeature`` swaps to ``DeliveryCompleteScreen``; the
/// escalation delegates (`escalatedContactSupport`,
/// `escalatedReturnToDispensary`, `dismissed`) all pop back to the
/// shift home.
///
/// `onAppear` is sent so the reducer's defensive deep-link branch
/// (already-passed scan → fire `.confirmed` immediately) gets a chance
/// to short-circuit before the user sees a stale "Begin Scan" CTA.
struct IDScanScreen: View {
  @Bindable var store: StoreOf<IDScanFeature>

  var body: some View {
    ZStack(alignment: .top) {
      DankColor.background.ignoresSafeArea()

      IDScanLaunchView(
        status: store.status,
        attemptsRemaining: max(0, IDScanFeature.maxAttempts - store.attempts),
        onBeginScan: { store.send(.beginScanTapped) },
        onRetry: { store.send(.retryTapped) },
        onContactSupport: { store.send(.contactSupportTapped) },
        onReturnToDispensary: { store.send(.returnToDispensaryTapped) }
      )

      VStack(spacing: 0) {
        if let banner = store.errorBanner {
          errorBanner(banner)
            .padding(.horizontal, DankSpacing.md)
            .padding(.top, DankSpacing.sm)
        }
        Spacer(minLength: 0)
      }
    }
    .overlay(alignment: .topLeading) {
      backButton
        .padding(.leading, DankSpacing.md)
        .padding(.top, DankSpacing.xs)
    }
    .task { store.send(.onAppear) }
  }

  private var backButton: some View {
    Button {
      store.send(.backTapped)
    } label: {
      Image(systemName: "chevron.left")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onBackground)
        .padding(DankSpacing.sm)
        .background(DankColor.background.opacity(0.9))
        .clipShape(Circle())
        .shadow(color: DankColor.Text.primary.opacity(0.08), radius: 4, x: 0, y: 1)
    }
    .disabled(store.status.isInFlight)
    .opacity(store.status.isInFlight ? 0.4 : 1)
    .accessibilityLabel("Back")
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
      Button {
        store.send(.errorBannerDismissed)
      } label: {
        Image(systemName: "xmark")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
      }
      .accessibilityLabel("Dismiss")
    }
    .padding(DankSpacing.sm)
    .background(DankColor.cream)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .strokeBorder(DankColor.Semantic.danger.opacity(0.4), lineWidth: 1)
    )
    .shadow(color: DankColor.Text.primary.opacity(0.08), radius: 8, x: 0, y: 2)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
  }
}
