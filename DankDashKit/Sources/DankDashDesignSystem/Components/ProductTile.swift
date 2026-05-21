import Foundation
import SwiftUI
import DankDashDomain

/// Grid tile for a menu line: thumbnail, strain-type dot, brand + name,
/// THC% and price. The strain-dot color encodes the indica/sativa/hybrid/
/// cbd/balanced classification at a glance — matches the spec §5.1
/// "strain-type indicator dot" treatment. Tiles are 2-up in a LazyVGrid;
/// the aspect ratio of the image stays square so the grid reads as a
/// stable shelf.
public struct ProductTile: View {
  private let menuItem: MenuItem
  private let cdnBaseURL: URL?
  private let action: () -> Void

  public init(menuItem: MenuItem, cdnBaseURL: URL?, action: @escaping () -> Void) {
    self.menuItem = menuItem
    self.cdnBaseURL = cdnBaseURL
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: DankSpacing.xs) {
        ZStack(alignment: .topTrailing) {
          DankAsyncImage(
            imageKey: menuItem.product.imageKeys.first,
            cdnBaseURL: cdnBaseURL,
            contentMode: .fill,
            aspectRatio: 1
          )
          .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))

          if menuItem.isOnSale {
            DankBadge("Sale", tone: .accent)
              .padding(DankSpacing.xs)
          } else if !menuItem.isInStock {
            DankBadge("Out", tone: .neutral)
              .padding(DankSpacing.xs)
          }
        }

        HStack(spacing: DankSpacing.xxs) {
          Circle()
            .fill(ProductTile.strainTint(menuItem.product.strainType))
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
          Text(menuItem.product.brand.uppercased())
            .font(DankFont.caption)
            .tracking(0.8)
            .foregroundStyle(DankColor.Text.secondary)
            .lineLimit(1)
          Spacer(minLength: 0)
        }

        Text(menuItem.product.name)
          .font(DankFont.bodySmall.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
          .lineLimit(2, reservesSpace: true)
          .multilineTextAlignment(.leading)

        HStack(alignment: .firstTextBaseline, spacing: DankSpacing.xs) {
          Text(Self.formatTHC(menuItem.product.thcMgPerUnit, weight: menuItem.product.weightGramsPerUnit))
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
          Spacer(minLength: 0)
          priceBlock
        }
      }
      .padding(DankSpacing.sm)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
      )
      .shadow(color: DankColor.primaryDark.opacity(0.06), radius: 10, x: 0, y: 4)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(.isButton)
  }

  @ViewBuilder private var priceBlock: some View {
    if let compare = menuItem.compareAtPriceCents, compare > menuItem.priceCents {
      VStack(alignment: .trailing, spacing: 0) {
        Text(Self.formatPrice(compare))
          .font(DankFont.caption)
          .strikethrough()
          .foregroundStyle(DankColor.Text.muted)
        Text(Self.formatPrice(menuItem.priceCents))
          .font(DankFont.headline)
          .foregroundStyle(DankColor.primary)
      }
    } else {
      Text(Self.formatPrice(menuItem.priceCents))
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.primary)
    }
  }

  private var accessibilityLabel: String {
    var parts: [String] = [
      "\(menuItem.product.brand) \(menuItem.product.name)",
    ]
    if let strain = menuItem.product.strainType {
      parts.append(strain.rawValue)
    }
    parts.append(Self.formatTHC(menuItem.product.thcMgPerUnit, weight: menuItem.product.weightGramsPerUnit))
    parts.append("priced at \(Self.formatPrice(menuItem.priceCents))")
    if menuItem.isOnSale, let compare = menuItem.compareAtPriceCents {
      parts.append("on sale, was \(Self.formatPrice(compare))")
    }
    if !menuItem.isInStock {
      parts.append("out of stock")
    }
    return parts.joined(separator: ", ")
  }

  /// Indica / sativa / hybrid / cbd / balanced color encoding. Values
  /// picked for AA contrast against cream; the dot is purely decorative
  /// so a-11y label carries the strain name in text.
  public static func strainTint(_ strain: StrainType?) -> Color {
    switch strain {
    case .indica: Color(red: 0.45, green: 0.35, blue: 0.75)
    case .sativa: Color(red: 0.85, green: 0.55, blue: 0.20)
    case .hybrid: Color(red: 0.30, green: 0.62, blue: 0.45)
    case .cbd: Color(red: 0.25, green: 0.55, blue: 0.80)
    case .balanced: Color(red: 0.55, green: 0.55, blue: 0.55)
    case .none: DankColor.Text.muted
    }
  }

  /// Formats a NUMERIC mg value as a THC label. We render `mg / g` →
  /// rounded percent for flower (g-weighted), and `mg per unit` for
  /// non-flower (vape, edible, etc.). Pure UI — the compliance engine
  /// owns the legal math.
  public static func formatTHC(_ thcMg: Decimal, weight: Decimal) -> String {
    if weight > 0 {
      let weightMg = weight * 1000
      let percent = (thcMg / weightMg) * 100
      let s = oneDecimalFormatter.string(from: percent as NSDecimalNumber) ?? "0.0"
      return "\(s)% THC"
    }
    let mgString = wholeMgFormatter.string(from: thcMg as NSDecimalNumber) ?? "0"
    return "\(mgString) mg THC"
  }

  static func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }
}

private let oneDecimalFormatter: NumberFormatter = {
  let f = NumberFormatter()
  f.minimumFractionDigits = 1
  f.maximumFractionDigits = 1
  f.roundingMode = .halfUp
  return f
}()

private let wholeMgFormatter: NumberFormatter = {
  let f = NumberFormatter()
  f.minimumFractionDigits = 0
  f.maximumFractionDigits = 0
  f.roundingMode = .halfUp
  return f
}()
