import SwiftUI

public struct DankButton: View {
  public enum Style: Sendable {
    case primary, secondary, ghost, destructive
  }

  public enum Size: Sendable {
    case small, medium, large

    public var height: CGFloat {
      switch self {
      case .small: 36
      case .medium: 48
      case .large: 56
      }
    }

    public var horizontalPadding: CGFloat {
      switch self {
      case .small: DankSpacing.sm
      case .medium: DankSpacing.md
      case .large: DankSpacing.lg
      }
    }

    public var font: Font {
      switch self {
      case .small: DankFont.caption
      case .medium: DankFont.body
      case .large: DankFont.headline
      }
    }
  }

  private let title: String
  private let style: Style
  private let size: Size
  private let isLoading: Bool
  private let isDisabled: Bool
  private let action: () -> Void

  public init(
    _ title: String,
    style: Style = .primary,
    size: Size = .medium,
    isLoading: Bool = false,
    isDisabled: Bool = false,
    action: @escaping () -> Void
  ) {
    self.title = title
    self.style = style
    self.size = size
    self.isLoading = isLoading
    self.isDisabled = isDisabled
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      ZStack {
        Text(title)
          .font(size.font)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .opacity(isLoading ? 0 : 1)
        if isLoading {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(foregroundColor)
        }
      }
      .frame(maxWidth: .infinity, minHeight: size.height)
      .padding(.horizontal, size.horizontalPadding)
      .background(background)
      .foregroundStyle(foregroundColor)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .strokeBorder(borderColor, lineWidth: borderWidth)
      )
      .opacity(isDisabled ? 0.5 : 1)
    }
    .disabled(isDisabled || isLoading)
    .accessibilityLabel(title)
    .accessibilityAddTraits(.isButton)
  }

  private var foregroundColor: Color {
    switch style {
    case .primary: DankColor.Text.onPrimary
    case .secondary: DankColor.primary
    case .ghost: DankColor.primary
    case .destructive: .white
    }
  }

  @ViewBuilder private var background: some View {
    switch style {
    case .primary: DankColor.primary
    case .secondary: DankColor.cream
    case .ghost: Color.clear
    case .destructive: DankColor.Semantic.danger
    }
  }

  private var borderColor: Color {
    switch style {
    case .primary: .clear
    case .secondary: DankColor.primary
    case .ghost: DankColor.primary.opacity(0.6)
    case .destructive: .clear
    }
  }

  private var borderWidth: CGFloat {
    switch style {
    case .primary, .destructive: 0
    case .secondary, .ghost: 1
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    DankButton("Primary", action: {})
    DankButton("Secondary", style: .secondary, action: {})
    DankButton("Ghost", style: .ghost, action: {})
    DankButton("Destructive", style: .destructive, action: {})
    DankButton("Loading", isLoading: true, action: {})
    DankButton("Disabled", isDisabled: true, action: {})
  }
  .padding()
  .background(DankColor.cream)
}
