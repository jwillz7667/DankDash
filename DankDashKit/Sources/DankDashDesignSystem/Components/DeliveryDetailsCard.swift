import SwiftUI

/// At-a-glance card for the driver's current delivery — order code,
/// what's in the bag, and the tip they're earning on this run. Sits above
/// the phase-action card on the active-route screen so the driver always
/// sees the stakes (the tip) and the contents without opening anything.
///
/// Pure presentation: the caller pre-flattens the line items into a single
/// `itemSummary` string and an aggregate `itemCount` so this stays free of
/// the `OrderItem` / `AnyValue` snapshot-decoding concern. `tipCents` is
/// integer cents (the order's `driverTipCents`); the tip row is emphasized
/// only when there's actually a tip, otherwise it reads "No tip".
public struct DeliveryDetailsCard: View {
  private let orderShortCode: String
  private let itemSummary: String?
  private let itemCount: Int
  private let tipCents: Int

  public init(
    orderShortCode: String,
    itemSummary: String?,
    itemCount: Int,
    tipCents: Int
  ) {
    self.orderShortCode = orderShortCode
    self.itemSummary = itemSummary
    self.itemCount = itemCount
    self.tipCents = tipCents
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      header
      if let itemSummary, !itemSummary.isEmpty {
        Text(itemSummary)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.secondary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Divider()
        .overlay(DankColor.primary.opacity(0.12))
      tipRow
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.background)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: DankSpacing.sm) {
      Text("Order #\(orderShortCode)")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onBackground)
      Spacer(minLength: 0)
      Text(itemCountLabel)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
    }
  }

  private var tipRow: some View {
    HStack(alignment: .firstTextBaseline, spacing: DankSpacing.sm) {
      Text("Your tip")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
      Spacer(minLength: 0)
      Text(hasTip ? Self.formatPrice(tipCents) : "No tip")
        .font(hasTip ? DankFont.headline : DankFont.body)
        .foregroundStyle(hasTip ? DankColor.Semantic.success : DankColor.Text.muted)
    }
  }

  private var hasTip: Bool { tipCents > 0 }

  private var itemCountLabel: String {
    itemCount == 1 ? "1 item" : "\(itemCount) items"
  }

  private var accessibilityLabel: String {
    let tip = hasTip ? "Tip \(Self.formatPrice(tipCents))" : "No tip"
    return "Order \(orderShortCode), \(itemCountLabel). \(tip)."
  }

  public static func formatPrice(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: dollars as NSDecimalNumber) ?? "$0.00"
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    DeliveryDetailsCard(
      orderShortCode: "A1B2C3",
      itemSummary: "Blue Dream 1/8 ×2 · Sour Gummies 10mg ×1",
      itemCount: 3,
      tipCents: 850
    )
    DeliveryDetailsCard(
      orderShortCode: "Z9Y8X7",
      itemSummary: "Northern Lights Cart ×1",
      itemCount: 1,
      tipCents: 0
    )
  }
  .padding()
  .background(DankColor.cream)
}
