import SwiftUI
import DankDashDomain

/// Detail sheet for a claimable open-pool delivery. Unlike the targeted
/// ``OfferCardView`` there is no countdown and no Decline — closing the
/// sheet IS the pass. The driver sees the dispensary → drop-off route,
/// the tip, and the distance, then taps a single Accept.
///
/// Presentational only: the embedding screen owns the claim POST and
/// feeds `isClaiming` / `errorMessage` back in. The route is best-effort
/// — when `route` is nil the map falls back to a straight pickup →
/// drop-off leg (``LiveMapView`` draws a two-point `deliveryLeg`).
public struct AvailableDeliveryDetailView: View {
  private let delivery: AvailableDelivery
  private let route: [Coordinate]?
  private let isClaiming: Bool
  private let errorMessage: String?
  private let onClaim: () -> Void

  public init(
    delivery: AvailableDelivery,
    route: [Coordinate]?,
    isClaiming: Bool = false,
    errorMessage: String? = nil,
    onClaim: @escaping () -> Void
  ) {
    self.delivery = delivery
    self.route = route
    self.isClaiming = isClaiming
    self.errorMessage = errorMessage
    self.onClaim = onClaim
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.lg) {
      LiveMapView(
        dispensary: LiveMapView.Pin(
          id: "pickup",
          kind: .dispensary,
          coordinate: delivery.pickup,
          title: delivery.pickupName
        ),
        customer: LiveMapView.Pin(
          id: "dropoff",
          kind: .customer,
          coordinate: delivery.dropoff,
          title: "Drop-off"
        ),
        driver: nil,
        deliveryLeg: deliveryLeg
      )
      .frame(height: 220)
      .accessibilityHidden(true)

      header
      stopRow(label: "Pickup", value: delivery.pickupName, icon: "shippingbox.fill")
      metricsRow

      if let errorMessage {
        Text(errorMessage)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Semantic.danger)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("delivery.detail.error")
      }

      acceptButton
    }
    .padding(.horizontal, DankSpacing.lg)
    .padding(.vertical, DankSpacing.xl)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.background)
    .accessibilityElement(children: .contain)
  }

  /// Prefer the resolved road-following route; fall back to a straight
  /// pickup → drop-off chord so the sheet always shows the leg.
  private var deliveryLeg: [Coordinate] {
    if let route, route.count >= 2 { return route }
    return [delivery.pickup, delivery.dropoff]
  }

  private var header: some View {
    HStack(alignment: .top, spacing: DankSpacing.md) {
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text("Tip")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        Text(Self.formatPrice(delivery.tipCents))
          .font(DankFont.display)
          .foregroundStyle(DankColor.Text.onBackground)
          .accessibilityLabel("Tip \(Self.formatPrice(delivery.tipCents))")
      }
      Spacer()
      VStack(alignment: .trailing, spacing: DankSpacing.xxs) {
        Text("Order")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        Text("#\(delivery.shortCode)")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onBackground)
      }
    }
  }

  private func stopRow(label: String, value: String, icon: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      Image(systemName: icon)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        Text(value)
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.onBackground)
          .lineLimit(2)
      }
      Spacer()
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(label): \(value)")
  }

  private var metricsRow: some View {
    HStack(spacing: DankSpacing.xl) {
      metric(label: "Distance", value: Self.formatDistance(delivery.distanceMiles))
      metric(label: "Order total", value: Self.formatPrice(delivery.totalCents))
      Spacer()
    }
  }

  private func metric(label: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
        .textCase(.uppercase)
      Text(value)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onBackground)
    }
  }

  private var acceptButton: some View {
    Button(action: onClaim) {
      ZStack {
        Text("Accept delivery")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .opacity(isClaiming ? 0 : 1)
        if isClaiming {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(DankColor.Text.onPrimary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .background(DankColor.primary)
      .clipShape(Capsule())
    }
    .disabled(isClaiming)
    .accessibilityLabel("Accept delivery for \(Self.formatPrice(delivery.tipCents)) tip")
    .accessibilityIdentifier("delivery.detail.accept")
  }

  // MARK: - Formatters

  public static func formatPrice(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: dollars as NSDecimalNumber) ?? "$0.00"
  }

  public static func formatDistance(_ miles: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.minimumFractionDigits = 1
    formatter.maximumFractionDigits = 1
    let value = formatter.string(from: miles as NSNumber) ?? "0.0"
    return "\(value) mi"
  }
}

#Preview {
  AvailableDeliveryDetailView(
    delivery: AvailableDelivery(
      orderId: UUID(),
      shortCode: "7Q4K",
      dispensaryId: UUID(),
      pickupName: "Bloom Dispensary",
      pickup: Coordinate(latitude: 44.9778, longitude: -93.2650),
      dropoff: Coordinate(latitude: 44.9836, longitude: -93.2766),
      tipCents: 650,
      totalCents: 8240,
      distanceMeters: 2100,
      awaitingDriverAt: Date()
    ),
    route: nil,
    isClaiming: false,
    errorMessage: nil,
    onClaim: {}
  )
  .background(DankColor.Text.muted.opacity(0.2))
}
