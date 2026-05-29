import SwiftUI
import DankDashDomain

/// Row used by the address picker (sheet) and as a read-only delivery
/// address summary in the cart. Renders label + one-line street + an
/// optional "Default" badge. Trailing accessory varies: chevron in the
/// picker, checkmark for the currently selected address.
public struct AddressRow: View {
  public enum Accessory: Sendable {
    case none
    case chevron
    case selected
  }

  private let address: UserAddress
  private let accessory: Accessory
  private let action: (() -> Void)?

  public init(
    address: UserAddress,
    accessory: Accessory = .none,
    action: (() -> Void)? = nil
  ) {
    self.address = address
    self.accessory = accessory
    self.action = action
  }

  public var body: some View {
    Group {
      if let action {
        Button(action: action) { content }
          .buttonStyle(.plain)
          .accessibilityAddTraits(.isButton)
      } else {
        content
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var content: some View {
    HStack(alignment: .top, spacing: DankSpacing.md) {
      Image(systemName: iconName)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(DankColor.primary)
        .frame(width: 28, alignment: .center)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        HStack(spacing: DankSpacing.xs) {
          Text(displayLabel)
            .font(DankFont.body.weight(.semibold))
            .foregroundStyle(DankColor.Text.primary)
          if address.isDefault {
            DankBadge("Default", tone: .accent)
          }
          if !address.isValidated {
            DankBadge("Delivery unavailable", tone: .warning)
          }
        }
        Text(address.oneLine)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.secondary)
          .lineLimit(2)
      }

      Spacer(minLength: 0)
      accessoryView
    }
    .padding(.vertical, DankSpacing.sm)
  }

  @ViewBuilder
  private var accessoryView: some View {
    switch accessory {
    case .none:
      EmptyView()
    case .chevron:
      Image(systemName: "chevron.right")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(DankColor.Text.muted)
    case .selected:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(DankColor.Semantic.success)
    }
  }

  private var displayLabel: String {
    if let label = address.label, !label.isEmpty { return label }
    return "Delivery address"
  }

  /// Distinct icon per common label so the row reads at a glance from
  /// the cart screen. Falls back to a generic pin.
  private var iconName: String {
    switch displayLabel.lowercased() {
    case "home": return "house.fill"
    case "work", "office": return "briefcase.fill"
    default: return "mappin.and.ellipse"
    }
  }

  private var accessibilityLabel: String {
    var parts: [String] = [displayLabel, address.oneLine]
    if address.isDefault { parts.append("default") }
    if !address.isValidated { parts.append("delivery unavailable") }
    if case .selected = accessory { parts.append("selected") }
    return parts.joined(separator: ", ")
  }
}

#Preview {
  let coordinate = Coordinate(latitude: 44.9778, longitude: -93.2650)
  let address = UserAddress(
    id: UUID(),
    label: "Home",
    line1: "1100 Hennepin Ave",
    line2: "Apt 204",
    city: "Minneapolis",
    region: "MN",
    postalCode: "55403",
    country: "US",
    location: coordinate,
    isDefault: true,
    isValidated: true,
    validatedAt: Date(),
    deliveryInstructions: "Buzz #204",
    createdAt: Date(),
    updatedAt: Date()
  )
  return VStack {
    AddressRow(address: address, accessory: .chevron, action: {})
    AddressRow(address: address, accessory: .selected, action: {})
  }
  .padding()
  .background(DankColor.cream)
}
