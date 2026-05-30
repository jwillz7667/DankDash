import SwiftUI

public enum DankCardStyle: Sendable {
  /// Cream background, soft drop shadow. Default for stacked content.
  case solid
  /// Translucent overlay used in the dispensary feed against a hero
  /// image — matches the spec §5.1 "frosted dispensary card" treatment.
  case frosted
}

public struct DankCard<Content: View>: View {
  private let style: DankCardStyle
  private let padding: CGFloat
  private let content: () -> Content

  public init(
    style: DankCardStyle = .solid,
    padding: CGFloat = DankSpacing.md,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.style = style
    self.padding = padding
    self.content = content
  }

  public var body: some View {
    content()
      .padding(padding)
      .background(background)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(borderColor, lineWidth: 1)
      )
      .shadow(color: shadowColor, radius: 12, x: 0, y: 6)
  }

  @ViewBuilder private var background: some View {
    switch style {
    case .solid: DankColor.cream
    case .frosted:
      ZStack {
        DankColor.primaryDark.opacity(0.45)
        DankColor.glass
      }
    }
  }

  private var borderColor: Color {
    switch style {
    case .solid: DankColor.primary.opacity(0.08)
    case .frosted: Color.white.opacity(0.18)
    }
  }

  private var shadowColor: Color {
    switch style {
    case .solid: DankColor.primaryDark.opacity(0.08)
    case .frosted: .black.opacity(0.25)
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.lg) {
    DankCard {
      Text("Solid card")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.primary)
    }
    DankCard(style: .frosted) {
      Text("Frosted card")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onPrimary)
    }
  }
  .padding()
  .background(DankColor.cream)
}
