import SwiftUI
import DankDashDomain

/// Slim card pinned to the bottom of the shift map. Renders
/// today's totals — `totalCents`, `deliveriesCount`, and the
/// tip slice — with a chevron-tap to push the earnings detail.
///
/// All money is integer cents formatted with the en_US currency
/// formatter (`$XX.YY` / `$1,234.56`). Empty windows render a
/// muted "$0.00 today" + "0 deliveries" rather than hiding the
/// card so the driver gets a stable bottom anchor on the map.
public struct EarningsSummaryCard: View {
  private let earnings: DriverEarnings?
  private let onTap: () -> Void

  public init(earnings: DriverEarnings?, onTap: @escaping () -> Void) {
    self.earnings = earnings
    self.onTap = onTap
  }

  public var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: DankSpacing.md) {
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(totalLabel)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
            .accessibilityLabel(totalAccessibilityLabel)
          Text(secondaryLabel)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
        }
        Spacer(minLength: DankSpacing.sm)
        VStack(alignment: .trailing, spacing: DankSpacing.xxs) {
          Text(periodLabel)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
          Image(systemName: "chevron.right")
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
        }
      }
      .padding(.vertical, DankSpacing.sm)
      .padding(.horizontal, DankSpacing.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.18), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(totalAccessibilityLabel) over \(periodLabel)")
    .accessibilityAddTraits(.isButton)
  }

  // MARK: - Derived strings

  public var totalLabel: String {
    Self.formatPrice(earnings?.totalCents ?? 0)
  }

  public var totalAccessibilityLabel: String {
    "\(totalLabel) earned"
  }

  public var secondaryLabel: String {
    let count = earnings?.deliveriesCount ?? 0
    let tips = earnings?.tipsCents ?? 0
    let deliveryCopy = count == 1 ? "1 delivery" : "\(count) deliveries"
    return "\(deliveryCopy) · \(Self.formatPrice(tips)) tips"
  }

  public var periodLabel: String {
    Self.label(for: earnings?.period ?? .today)
  }

  public static func label(for period: EarningsPeriod) -> String {
    switch period {
    case .today: "Today"
    case .week: "This week"
    case .month: "This month"
    }
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
    EarningsSummaryCard(
      earnings: DriverEarnings(
        period: .today,
        since: Date().addingTimeInterval(-86_400),
        until: Date(),
        tipsCents: 1850,
        deliveryFeesCents: 4500,
        deliveriesCount: 7,
        totalCents: 14_350
      ),
      onTap: {}
    )
    EarningsSummaryCard(earnings: nil, onTap: {})
  }
  .padding()
  .background(DankColor.cream)
}
