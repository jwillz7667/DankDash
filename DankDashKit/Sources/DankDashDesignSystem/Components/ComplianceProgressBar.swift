import SwiftUI
import Foundation

/// Single-dimension progress bar for the compliance preview. Renders
/// `current / max` as a ratio; tone shifts from green (<70%) → amber
/// (70-95%) → red (≥95%) so a user pushing close to the per-transaction
/// statutory limit sees it before the validate response says no.
///
/// Values are `Decimal` to match the server-authoritative
/// ``ComplianceTotals`` / ``ComplianceLimits`` shape — the bar never
/// recomputes legal totals client-side; it just renders the latest
/// validate response. `unit` is purely cosmetic ("g" / "mg") for the
/// label.
public struct ComplianceProgressBar: View {
  private let title: String
  private let current: Decimal
  private let maxValue: Decimal
  private let unit: String

  public init(
    title: String,
    current: Decimal,
    max maxValue: Decimal,
    unit: String
  ) {
    self.title = title
    self.current = current
    self.maxValue = maxValue
    self.unit = unit
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      HStack(alignment: .firstTextBaseline) {
        Text(title)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.secondary)
        Spacer(minLength: DankSpacing.xs)
        Text(displayValue)
          .font(DankFont.caption.monospacedDigit())
          .foregroundStyle(tone.textColor)
      }
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(DankColor.primary.opacity(0.08))
          Capsule()
            .fill(tone.barColor)
            .frame(width: geo.size.width * CGFloat(ratio))
        }
      }
      .frame(height: 6)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  /// 0...1 clamped — the bar can never overflow the track visually even
  /// if the server returns `cartTotals > limits` (which can happen for
  /// failed validates so the user sees how far over they are; the text
  /// label conveys the exact over-amount).
  public var ratio: Double {
    guard maxValue > 0 else { return 0 }
    let r = (current as NSDecimalNumber).doubleValue
      / (maxValue as NSDecimalNumber).doubleValue
    return min(max(r, 0), 1)
  }

  public var tone: Tone {
    switch ratio {
    case ..<0.70: return .calm
    case ..<0.95: return .warn
    default: return .alert
    }
  }

  public enum Tone: Sendable {
    case calm, warn, alert

    var barColor: Color {
      switch self {
      case .calm: DankColor.Semantic.success
      case .warn: DankColor.Semantic.warning
      case .alert: DankColor.Semantic.danger
      }
    }

    var textColor: Color {
      switch self {
      case .calm: DankColor.Semantic.success
      case .warn: DankColor.Semantic.warning
      case .alert: DankColor.Semantic.danger
      }
    }
  }

  private var displayValue: String {
    let currentStr = Self.format(current)
    let maxStr = Self.format(maxValue)
    return "\(currentStr) / \(maxStr) \(unit)"
  }

  private var accessibilityLabel: String {
    let percent = Int((ratio * 100).rounded())
    return "\(title): \(percent) percent of limit. \(displayValue)"
  }

  static func format(_ value: Decimal) -> String {
    Self.formatter.string(from: value as NSDecimalNumber) ?? "0"
  }

  /// Up to one decimal place — keeps the bar legend tight (e.g.
  /// "12.3 / 56.7 g") while preserving cannabis-weight precision in
  /// the .1g range that customers actually shop in.
  private static let formatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.minimumFractionDigits = 0
    f.maximumFractionDigits = 1
    f.roundingMode = .halfUp
    return f
  }()
}

#Preview {
  VStack(spacing: DankSpacing.sm) {
    ComplianceProgressBar(
      title: "Flower",
      current: Decimal(string: "12.5")!,
      max: Decimal(string: "56.7")!,
      unit: "g"
    )
    ComplianceProgressBar(
      title: "Concentrate",
      current: Decimal(string: "6.5")!,
      max: Decimal(string: "8")!,
      unit: "g"
    )
    ComplianceProgressBar(
      title: "Edible THC",
      current: Decimal(string: "780")!,
      max: Decimal(string: "800")!,
      unit: "mg"
    )
  }
  .padding()
  .background(DankColor.cream)
}
