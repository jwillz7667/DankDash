import SwiftUI

/// Filter chip with an optional count badge — search facets, category
/// filters, strain-type quick selects. Selection state inverts the
/// background; unselected state matches the neutral DankBadge tone so the
/// chip rail reads as a single visual family.
public struct FacetPill: View {
  private let title: String
  private let count: Int?
  private let isSelected: Bool
  private let action: () -> Void

  public init(
    title: String,
    count: Int? = nil,
    isSelected: Bool = false,
    action: @escaping () -> Void
  ) {
    self.title = title
    self.count = count
    self.isSelected = isSelected
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: DankSpacing.xxs) {
        Text(title)
          .font(DankFont.caption)
        if let count {
          Text("\(count)")
            .font(DankFont.caption)
            .foregroundStyle(countColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(countBackground)
            .clipShape(Capsule())
        }
      }
      .padding(.horizontal, DankSpacing.sm)
      .padding(.vertical, DankSpacing.xxs)
      .foregroundStyle(foreground)
      .background(background)
      .clipShape(Capsule())
      .overlay(
        Capsule().strokeBorder(borderColor, lineWidth: 1)
      )
    }
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
  }

  private var foreground: Color {
    isSelected ? DankColor.Text.onPrimary : DankColor.Text.primary
  }

  private var background: Color {
    isSelected ? DankColor.primary : DankColor.primary.opacity(0.08)
  }

  private var borderColor: Color {
    isSelected ? DankColor.primary : DankColor.primary.opacity(0.15)
  }

  private var countColor: Color {
    isSelected ? DankColor.primary : DankColor.Text.onPrimary
  }

  private var countBackground: Color {
    isSelected ? DankColor.Text.onPrimary.opacity(0.9) : DankColor.primary.opacity(0.85)
  }

  private var accessibilityLabel: String {
    if let count {
      return "\(title), \(count) results"
    }
    return title
  }
}

#Preview {
  HStack(spacing: DankSpacing.xs) {
    FacetPill(title: "Indica", count: 12, isSelected: true, action: {})
    FacetPill(title: "Sativa", count: 6, isSelected: false, action: {})
    FacetPill(title: "Hybrid", isSelected: false, action: {})
  }
  .padding()
  .background(DankColor.cream)
}
