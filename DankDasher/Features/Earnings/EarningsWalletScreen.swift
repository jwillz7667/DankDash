import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Phase 20 replacement for `EarningsView`. The headline surface is
/// the design-system ``EarningsWalletView`` (period picker + breakdown
/// + recent cashouts + cashout CTA); a `.sheet(isPresented:)` mounts
/// ``CashoutSheetView`` for the request flow, and a transient toast at
/// the top of the screen confirms a successful submission.
///
/// `onAppear` triggers the initial load (idempotent against re-entry);
/// pull-to-refresh re-fires both the earnings and shift endpoints
/// concurrently. The `onDismiss` closure returns the driver to the
/// shift home — the wallet is a leaf screen, no further navigation.
struct EarningsWalletScreen: View {
  @Bindable var store: StoreOf<DriverEarningsFeature>
  let onDismiss: () -> Void

  var body: some View {
    NavigationStack {
      ZStack(alignment: .top) {
        DankColor.background.ignoresSafeArea()

        EarningsWalletView(
          period: store.period,
          earnings: store.earnings,
          recentCashouts: store.recentCashouts,
          isLoading: store.isLoadingEarnings || store.isLoadingShifts,
          cashoutCTAEnabled: cashoutCTAEnabled,
          onPeriodChanged: { store.send(.periodChanged($0)) },
          onCashoutTapped: { store.send(.cashoutCtaTapped) }
        )
        .refreshable {
          store.send(.pullToRefresh)
          await waitForRefreshCompletion()
        }

        VStack(spacing: DankSpacing.sm) {
          if let banner = store.errorBanner {
            errorBanner(banner)
              .padding(.horizontal, DankSpacing.md)
              .padding(.top, DankSpacing.sm)
          }
          if let toast = store.cashoutToast {
            toastBanner(toast)
              .padding(.horizontal, DankSpacing.md)
              .padding(.top, DankSpacing.sm)
              .transition(.move(edge: .top).combined(with: .opacity))
          }
          Spacer(minLength: 0)
        }
        .animation(.easeInOut(duration: 0.2), value: store.cashoutToast)
        .animation(.easeInOut(duration: 0.2), value: store.errorBanner)
      }
      .navigationTitle("Earnings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Back to shift", action: onDismiss)
        }
      }
      .task { store.send(.onAppear) }
      .sheet(
        isPresented: Binding(
          get: { store.cashoutSheet != nil },
          set: { isShown in
            if !isShown { store.send(.cashoutSheetDismissed) }
          }
        )
      ) {
        cashoutSheetContent
          .presentationDetents([.medium, .large])
      }
    }
  }

  /// Cashout CTA is enabled when we have a positive total in the
  /// current period view AND nothing is in flight. The backend is
  /// authoritative on the actual balance — this just avoids the
  /// obvious zero-state tap.
  private var cashoutCTAEnabled: Bool {
    guard let total = store.earnings?.totalCents, total > 0 else { return false }
    return !(store.isLoadingEarnings || store.isLoadingShifts || store.isRefreshing)
  }

  // MARK: - Cashout sheet

  @ViewBuilder
  private var cashoutSheetContent: some View {
    if let sheet = store.cashoutSheet {
      CashoutSheetView(
        amountText: Binding(
          get: { sheet.amountText },
          set: { store.send(.cashoutAmountChanged($0)) }
        ),
        availableBalanceCents: store.earnings?.totalCents,
        isSubmitting: sheet.isSubmitting,
        errorMessage: sheet.errorMessage,
        isConfirmEnabled: sheet.isConfirmEnabled,
        onConfirm: { store.send(.cashoutConfirmed) },
        onCancel: { store.send(.cashoutSheetDismissed) }
      )
    }
  }

  // MARK: - Banners

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

  private func toastBanner(_ message: String) -> some View {
    HStack(alignment: .center, spacing: DankSpacing.sm) {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(DankColor.Semantic.success)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
      Button {
        store.send(.cashoutToastDismissed)
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
        .strokeBorder(DankColor.Semantic.success.opacity(0.4), lineWidth: 1)
    )
    .shadow(color: DankColor.Text.primary.opacity(0.08), radius: 8, x: 0, y: 2)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Success: \(message)")
  }

  /// Awaits the reducer's `isRefreshing` flag flipping back to false so
  /// the pull-to-refresh spinner stays up until both concurrent fetches
  /// land. Mirrors `EarningsView`'s spin-wait idiom.
  private func waitForRefreshCompletion() async {
    while store.isRefreshing {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
  }
}
