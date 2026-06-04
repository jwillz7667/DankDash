import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Live tracking surface bound to ``OrderTrackingFeature``. Renders the
/// status timeline, ETA banner, polling-fallback banner, error banner,
/// and driver card. The reducer drives every refresh — this view layer
/// only dispatches `.onAppear` / `.onDisappear` and lets the realtime
/// stream + polling fallback push state in.
///
/// Phase 18 note: the ``LiveMapView`` requires a customer-address
/// coordinate that isn't carried on ``OrderTrackingFeature/State`` yet
/// (the order detail response only exposes `deliveryAddressId`). The
/// timeline + driver card + ETA cover the live-tracking DoD; the map
/// lights up once a follow-up wires the address fetch through the
/// reducer.
struct OrderTrackingView: View {
  @Bindable var store: StoreOf<OrderTrackingFeature>
  @Dependency(\.urlOpenerClient) private var urlOpener
  @Dependency(\.cdnBaseURL) private var cdnBaseURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: DankSpacing.lg) {
        if let order = store.order {
          header(order: order)
        } else if store.isLoading {
          loadingPlaceholder
        }

        if let error = store.error {
          errorBanner(error)
        }

        if store.isPolling {
          pollingBanner
        }

        if let order = store.order {
          OrderStatusTimeline(status: order.status)
            .padding(DankSpacing.md)
            .background(DankColor.cream)
            .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
                .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
            )
        }

        if let etaMinutes = store.etaMinutes {
          etaBanner(minutes: etaMinutes)
        }

        if let driver = store.driver {
          DriverCard(
            driver: driver,
            cdnBaseURL: cdnBaseURL,
            onCall: callAction(driver: driver)
          )
        }
      }
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.md)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle(navigationTitle)
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { store.send(.onAppear) }
    .onDisappear { store.send(.onDisappear) }
  }

  private var navigationTitle: String {
    store.order.map { "Order \($0.shortCode)" } ?? "Order"
  }

  // MARK: - Header

  private func header(order: Order) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      HStack(spacing: DankSpacing.sm) {
        Text(order.shortCode)
          .font(DankFont.mono)
          .foregroundStyle(DankColor.Text.primary)
        OrderStatusPill(status: order.status)
        Spacer(minLength: 0)
      }
      Text(formatPrice(order.totalCents))
        .font(DankFont.title.monospacedDigit())
        .foregroundStyle(DankColor.Text.primary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Order \(order.shortCode), \(OrderStatusPill.label(for: order.status)), total \(formatPrice(order.totalCents))"
    )
  }

  // MARK: - ETA

  private func etaBanner(minutes: Int) -> some View {
    HStack(spacing: DankSpacing.sm) {
      Image(systemName: "clock.fill")
        .foregroundStyle(DankColor.primary)
        .accessibilityHidden(true)
      Text(etaLabel(minutes: minutes))
        .font(DankFont.body.weight(.semibold))
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .background(DankColor.primary.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
  }

  private func etaLabel(minutes: Int) -> String {
    switch minutes {
    case ..<1: return "Arriving now"
    case 1: return "Arriving in 1 minute"
    default: return "Arriving in \(minutes) minutes"
    }
  }

  // MARK: - Polling fallback

  private var pollingBanner: some View {
    HStack(spacing: DankSpacing.sm) {
      Image(systemName: "antenna.radiowaves.left.and.right.slash")
        .foregroundStyle(DankColor.Semantic.warning)
        .accessibilityHidden(true)
      Text("Live updates paused — refreshing every 15 seconds.")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .background(DankColor.Semantic.warning.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
  }

  // MARK: - Error

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.xs) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .background(DankColor.Semantic.danger.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
  }

  // MARK: - Loading

  private var loadingPlaceholder: some View {
    VStack(spacing: DankSpacing.md) {
      ProgressView().controlSize(.large)
      Text("Loading order…")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, DankSpacing.xl)
  }

  // MARK: - Tap-to-call

  /// Returns a tap-to-call closure when the driver has a phone number we
  /// can dial. The masked-display string carries U+2022 bullets (the
  /// human-readable form); `tel:` URIs need plain digits, so we strip
  /// non-digit characters before composing the URL. Twilio Proxy
  /// provisioning lands in Phase 23 — until then we dial the raw
  /// masked-display sequence, which the carrier rejects gracefully.
  private func callAction(driver: DriverPublicProfile) -> (() -> Void)? {
    guard let phone = driver.maskedPhone, !phone.isEmpty else { return nil }
    let digits = phone.filter { $0.isNumber }
    guard !digits.isEmpty, let url = URL(string: "tel:\(digits)") else { return nil }
    return {
      Task { _ = await urlOpener.open(url) }
    }
  }

  private func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }
}
