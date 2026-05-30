import SwiftUI
import Foundation
import DankDashDomain

/// Slim row used by the Orders tab list. Renders the short-code, status
/// pill, total cents (formatted), and a relative `placedAt` ("12m ago").
/// Joins against the dispensary cache by `dispensaryId` to render the
/// brand line — passed in as `dispensaryName` so this layer never
/// touches a network.
public struct OrderListRow: View {
  private let item: OrderListItem
  private let dispensaryName: String?
  private let now: Date
  private let action: () -> Void

  public init(
    item: OrderListItem,
    dispensaryName: String?,
    now: Date = Date(),
    action: @escaping () -> Void
  ) {
    self.item = item
    self.dispensaryName = dispensaryName
    self.now = now
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: DankSpacing.md) {
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          HStack(spacing: DankSpacing.xs) {
            Text(item.shortCode)
              .font(DankFont.mono)
              .foregroundStyle(DankColor.Text.primary)
            OrderStatusPill(status: item.status)
          }
          if let dispensaryName, !dispensaryName.isEmpty {
            Text(dispensaryName)
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.secondary)
              .lineLimit(1)
          }
          Text(Self.relativeLabel(item.placedAt, now: now))
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
        }

        Spacer(minLength: 0)

        VStack(alignment: .trailing, spacing: DankSpacing.xxs) {
          Text(Self.formatPrice(item.totalCents))
            .font(DankFont.headline.monospacedDigit())
            .foregroundStyle(DankColor.Text.primary)
          Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(DankColor.Text.muted)
        }
      }
      .padding(.vertical, DankSpacing.sm)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(.isButton)
  }

  private var accessibilityLabel: String {
    var parts: [String] = [
      "Order \(item.shortCode)",
      OrderStatusPill.label(for: item.status),
    ]
    if let dispensaryName, !dispensaryName.isEmpty {
      parts.append("from \(dispensaryName)")
    }
    parts.append("total \(Self.formatPrice(item.totalCents))")
    parts.append("placed \(Self.relativeLabel(item.placedAt, now: now))")
    return parts.joined(separator: ", ")
  }

  static func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }

  /// Coarse relative label tuned for the Orders tab — most rows are
  /// either freshly placed (minutes) or weeks old. Inside a day we show
  /// minutes/hours; beyond that we fall back to a short date so the
  /// list stays scannable.
  static func relativeLabel(_ date: Date, now: Date) -> String {
    let delta = now.timeIntervalSince(date)
    switch delta {
    case ..<60: return "just now"
    case ..<3600:
      let m = Int(delta / 60)
      return "\(m)m ago"
    case ..<86_400:
      let h = Int(delta / 3600)
      return "\(h)h ago"
    default:
      let f = DateFormatter()
      f.dateFormat = "MMM d"
      return f.string(from: date)
    }
  }
}

#Preview {
  let item = OrderListItem(
    id: UUID(),
    shortCode: "DD-ABC123",
    dispensaryId: UUID(),
    status: .enRouteDropoff,
    totalCents: 5550,
    placedAt: Date(timeIntervalSinceNow: -600),
    statusChangedAt: Date()
  )
  return OrderListRow(
    item: item,
    dispensaryName: "Greenleaf Cooperative",
    action: {}
  )
  .padding()
  .background(DankColor.cream)
}
