import SwiftUI
import Foundation
import DankDashDomain

/// One row of the server cart: thumbnail, brand + name, line subtotal,
/// quantity stepper. The product (brand / name / image) doesn't ride on
/// the `CartItem` wire payload — the parent feature joins against its
/// cached menu projection by `listingId` and passes the resolved bits in.
///
/// Keeping the catalog join in the parent (rather than embedding catalog
/// fields on `CartItem`) means cart reads don't have to invalidate when
/// the catalog cache turns over.
public struct LineItemRow: View {
  private let listingId: UUID
  private let productName: String
  private let brand: String
  private let imageKey: String?
  private let cdnBaseURL: URL?
  private let unitPriceCents: Int
  private let lineSubtotalCents: Int
  private let quantity: Int
  private let maxQuantity: Int
  private let isPending: Bool
  private let onIncrement: () -> Void
  private let onDecrement: () -> Void

  public init(
    listingId: UUID,
    productName: String,
    brand: String,
    imageKey: String?,
    cdnBaseURL: URL?,
    unitPriceCents: Int,
    lineSubtotalCents: Int,
    quantity: Int,
    maxQuantity: Int,
    isPending: Bool = false,
    onIncrement: @escaping () -> Void,
    onDecrement: @escaping () -> Void
  ) {
    self.listingId = listingId
    self.productName = productName
    self.brand = brand
    self.imageKey = imageKey
    self.cdnBaseURL = cdnBaseURL
    self.unitPriceCents = unitPriceCents
    self.lineSubtotalCents = lineSubtotalCents
    self.quantity = quantity
    self.maxQuantity = maxQuantity
    self.isPending = isPending
    self.onIncrement = onIncrement
    self.onDecrement = onDecrement
  }

  public var body: some View {
    HStack(alignment: .top, spacing: DankSpacing.md) {
      DankAsyncImage(
        imageKey: imageKey,
        cdnBaseURL: cdnBaseURL,
        contentMode: .fill,
        aspectRatio: 1
      )
      .frame(width: 72, height: 72)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))

      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(brand.uppercased())
          .font(DankFont.caption)
          .tracking(0.8)
          .foregroundStyle(DankColor.Text.secondary)
          .lineLimit(1)

        Text(productName)
          .font(DankFont.bodySmall.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
          .lineLimit(2)

        HStack(spacing: DankSpacing.xs) {
          Text(Self.formatPrice(unitPriceCents))
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
          Spacer(minLength: 0)
          Text(Self.formatPrice(lineSubtotalCents))
            .font(DankFont.headline.monospacedDigit())
            .foregroundStyle(DankColor.Text.primary)
            .opacity(isPending ? 0.45 : 1)
        }

        QuantityStepper(
          quantity: quantity,
          maxQuantity: maxQuantity,
          onIncrement: onIncrement,
          onDecrement: onDecrement
        )
        .padding(.top, DankSpacing.xxs)
      }
    }
    .padding(.vertical, DankSpacing.sm)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var accessibilityLabel: String {
    var parts: [String] = [
      "\(brand) \(productName)",
      "Quantity \(quantity)",
      "Line total \(Self.formatPrice(lineSubtotalCents))",
    ]
    if isPending {
      parts.append("Updating")
    }
    return parts.joined(separator: ", ")
  }

  static func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }
}

#Preview {
  LineItemRow(
    listingId: UUID(),
    productName: "Gorilla Glue #4 3.5g",
    brand: "DankCo",
    imageKey: nil,
    cdnBaseURL: nil,
    unitPriceCents: 4500,
    lineSubtotalCents: 9000,
    quantity: 2,
    maxQuantity: 10,
    onIncrement: {},
    onDecrement: {}
  )
  .padding()
  .background(DankColor.cream)
}
