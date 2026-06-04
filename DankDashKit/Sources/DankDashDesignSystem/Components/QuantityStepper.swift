import SwiftUI

/// `− N +` stepper for the cart line item. Disabled `−` at `minQuantity`,
/// disabled `+` at `maxQuantity` (the listing's `quantityAvailable`).
///
/// The caller owns debouncing — every tap fires the callback synchronously
/// so the parent reducer can re-debounce a PATCH cart-item request via
/// TCA's `.debounce(id:for:)`. The view itself is stateless: the displayed
/// number comes from `quantity` so optimistic updates from the reducer
/// land immediately.
///
/// `+` while at `maxQuantity` is still tappable for VoiceOver discovery —
/// it just no-ops with a soft impact. We don't hide the button because
/// hiding it would mean a user near the cap can't tell whether `+` is
/// even an option.
public struct QuantityStepper: View {
  private let quantity: Int
  private let minQuantity: Int
  private let maxQuantity: Int
  private let onIncrement: () -> Void
  private let onDecrement: () -> Void

  public init(
    quantity: Int,
    minQuantity: Int = 0,
    maxQuantity: Int,
    onIncrement: @escaping () -> Void,
    onDecrement: @escaping () -> Void
  ) {
    self.quantity = quantity
    self.minQuantity = minQuantity
    self.maxQuantity = maxQuantity
    self.onIncrement = onIncrement
    self.onDecrement = onDecrement
  }

  public var body: some View {
    HStack(spacing: 0) {
      stepperButton(
        symbol: "minus",
        action: onDecrement,
        isEnabled: canDecrement,
        a11yLabel: "Decrease quantity"
      )

      Text("\(quantity)")
        .font(DankFont.headline.monospacedDigit())
        .foregroundStyle(DankColor.Text.primary)
        .frame(minWidth: 32)
        .accessibilityLabel("Quantity \(quantity)")

      stepperButton(
        symbol: "plus",
        action: onIncrement,
        isEnabled: canIncrement,
        a11yLabel: "Increase quantity"
      )
    }
    .padding(.vertical, DankSpacing.xxs)
    .padding(.horizontal, DankSpacing.xs)
    .background(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .fill(DankColor.primary.opacity(0.06))
    )
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
    .accessibilityElement(children: .contain)
  }

  public var canIncrement: Bool { quantity < maxQuantity }
  public var canDecrement: Bool { quantity > minQuantity }

  @ViewBuilder
  private func stepperButton(
    symbol: String,
    action: @escaping () -> Void,
    isEnabled: Bool,
    a11yLabel: String
  ) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .bold))
        .frame(width: 44, height: 44)
        .foregroundStyle(
          isEnabled ? DankColor.primary : DankColor.Text.muted
        )
        .contentShape(Rectangle())
    }
    .disabled(!isEnabled)
    .accessibilityLabel(a11yLabel)
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    QuantityStepper(quantity: 0, maxQuantity: 10, onIncrement: {}, onDecrement: {})
    QuantityStepper(quantity: 3, maxQuantity: 10, onIncrement: {}, onDecrement: {})
    QuantityStepper(quantity: 10, maxQuantity: 10, onIncrement: {}, onDecrement: {})
  }
  .padding()
  .background(DankColor.cream)
}
