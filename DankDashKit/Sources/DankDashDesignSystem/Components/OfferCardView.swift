import SwiftUI
import DankDashDomain

/// Slide-up sheet body for a dispatched offer. Three things at a glance:
///
///   - Payout estimate (big-number, the only metric a driver decides on)
///   - Pickup / dropoff one-liners (where they're going)
///   - Distance + countdown ring (how far, how much time to decide)
///
/// Accept / Decline are equal-prominence CTAs so a fast tap can't
/// accidentally accept the wrong one — Decline is on the leading edge
/// (left-thumb friendly), Accept on the trailing edge with the brand
/// primary fill.
public struct OfferCardView: View {
  private let offer: DispatchOffer
  private let pickupSummary: String
  private let dropoffSummary: String
  private let secondsRemaining: TimeInterval
  private let totalSeconds: TimeInterval
  private let isSubmitting: Bool
  private let onAccept: () -> Void
  private let onDecline: () -> Void

  public init(
    offer: DispatchOffer,
    pickupSummary: String,
    dropoffSummary: String,
    secondsRemaining: TimeInterval,
    totalSeconds: TimeInterval = 30,
    isSubmitting: Bool = false,
    onAccept: @escaping () -> Void,
    onDecline: @escaping () -> Void
  ) {
    self.offer = offer
    self.pickupSummary = pickupSummary
    self.dropoffSummary = dropoffSummary
    self.secondsRemaining = secondsRemaining
    self.totalSeconds = totalSeconds
    self.isSubmitting = isSubmitting
    self.onAccept = onAccept
    self.onDecline = onDecline
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.lg) {
      header
      stopRow(label: "Pickup", value: pickupSummary, icon: "shippingbox.fill")
      Divider().background(DankColor.Text.muted.opacity(0.15))
      stopRow(label: "Dropoff", value: dropoffSummary, icon: "house.fill")
      Divider().background(DankColor.Text.muted.opacity(0.15))
      metricsRow
      ctaRow
    }
    .padding(.horizontal, DankSpacing.lg)
    .padding(.vertical, DankSpacing.xl)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.background)
    .clipShape(
      UnevenRoundedRectangle(
        topLeadingRadius: DankRadius.lg,
        bottomLeadingRadius: 0,
        bottomTrailingRadius: 0,
        topTrailingRadius: DankRadius.lg
      )
    )
    .shadow(color: .black.opacity(0.18), radius: 24, x: 0, y: -8)
    .accessibilityElement(children: .contain)
  }

  // MARK: - Sections

  private var header: some View {
    HStack(alignment: .top, spacing: DankSpacing.md) {
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text("New offer")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        Text(Self.formatPrice(offer.payoutEstimateCents))
          .font(DankFont.display)
          .foregroundStyle(DankColor.Text.onBackground)
          .accessibilityLabel("Payout estimate \(Self.formatPrice(offer.payoutEstimateCents))")
      }
      Spacer()
      CountdownRingView(
        secondsRemaining: secondsRemaining,
        totalSeconds: totalSeconds
      )
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
      metric(label: "Distance", value: Self.formatDistance(offer.distanceMiles))
      metric(label: "Estimated", value: Self.formatPrice(offer.payoutEstimateCents))
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

  private var ctaRow: some View {
    HStack(spacing: DankSpacing.sm) {
      Button(action: onDecline) {
        Text("Decline")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onBackground)
          .frame(maxWidth: .infinity, minHeight: 52)
          .background(DankColor.Text.muted.opacity(0.12))
          .clipShape(Capsule())
      }
      .disabled(isSubmitting)
      .accessibilityLabel("Decline offer")
      Button(action: onAccept) {
        ZStack {
          Text("Accept")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.onPrimary)
            .opacity(isSubmitting ? 0 : 1)
          if isSubmitting {
            ProgressView()
              .progressViewStyle(.circular)
              .tint(DankColor.Text.onPrimary)
          }
        }
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(DankColor.primary)
        .clipShape(Capsule())
      }
      .disabled(isSubmitting)
      .accessibilityLabel("Accept offer for \(Self.formatPrice(offer.payoutEstimateCents))")
    }
  }

  // MARK: - Formatters

  public static func formatPrice(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: dollars as NSDecimalNumber) ?? "$0.00"
  }

  public static func formatDistance(_ miles: Decimal) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.minimumFractionDigits = 1
    formatter.maximumFractionDigits = 1
    let value = formatter.string(from: miles as NSDecimalNumber) ?? "0.0"
    return "\(value) mi"
  }
}

#Preview {
  let offer = DispatchOffer(
    id: UUID(),
    orderId: UUID(),
    driverId: UUID(),
    offeredAt: Date(),
    expiresAt: Date().addingTimeInterval(18),
    payoutEstimateCents: 1450,
    distanceMiles: Decimal(string: "3.2")!,
    status: .offered,
    respondedAt: nil,
    declineReason: nil
  )
  return OfferCardView(
    offer: offer,
    pickupSummary: "Bloom Dispensary · 401 N 3rd St",
    dropoffSummary: "1234 Hennepin Ave, Apt 4B · Minneapolis",
    secondsRemaining: 18,
    totalSeconds: 30,
    isSubmitting: false,
    onAccept: {},
    onDecline: {}
  )
  .background(DankColor.Text.muted.opacity(0.2))
}
