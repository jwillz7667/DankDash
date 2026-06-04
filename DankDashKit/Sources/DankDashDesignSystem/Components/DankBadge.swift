import SwiftUI

public struct DankBadge: View {
  public enum Tone: Sendable, CaseIterable {
    case neutral, success, warning, danger, info, accent
  }

  private let title: String
  private let tone: Tone

  public init(_ title: String, tone: Tone = .neutral) {
    self.title = title
    self.tone = tone
  }

  public var body: some View {
    Text(title)
      .font(DankFont.caption)
      .foregroundStyle(textColor)
      .padding(.horizontal, DankSpacing.sm)
      .padding(.vertical, DankSpacing.xxs)
      .background(backgroundColor)
      .clipShape(Capsule())
      .accessibilityLabel(title)
  }

  private var textColor: Color {
    switch tone {
    case .neutral: DankColor.Text.primary
    case .success: .white
    case .warning: .white
    case .danger: .white
    case .info: .white
    case .accent: DankColor.primaryDark
    }
  }

  private var backgroundColor: Color {
    switch tone {
    case .neutral: DankColor.primary.opacity(0.12)
    case .success: DankColor.Semantic.success
    case .warning: DankColor.Semantic.warning
    case .danger: DankColor.Semantic.danger
    case .info: DankColor.Semantic.info
    case .accent: DankColor.accent
    }
  }
}

#Preview {
  HStack(spacing: DankSpacing.xs) {
    ForEach(DankBadge.Tone.allCases, id: \.self) { tone in
      DankBadge(String(describing: tone), tone: tone)
    }
  }
  .padding()
  .background(DankColor.cream)
}
