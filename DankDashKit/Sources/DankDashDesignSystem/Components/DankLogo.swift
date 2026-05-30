import SwiftUI

public struct DankLogo: View {
  public enum Variant: Sendable, CaseIterable {
    case mark, wordmark, full
  }

  private let variant: Variant
  private let size: CGFloat

  public init(_ variant: Variant = .full, size: CGFloat = 64) {
    self.variant = variant
    self.size = size
  }

  public var body: some View {
    switch variant {
    case .mark: markView
    case .wordmark: wordmarkView
    case .full:
      HStack(spacing: DankSpacing.sm) {
        markView
        wordmarkView
      }
    }
  }

  private var markView: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
        .fill(DankColor.primary)
      Text("D")
        .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
        .foregroundStyle(DankColor.cream)
    }
    .frame(width: size, height: size)
    .accessibilityLabel("DankDash mark")
  }

  private var wordmarkView: some View {
    Text("DankDash")
      .font(.system(size: size * 0.45, weight: .bold, design: .rounded))
      .foregroundStyle(DankColor.primary)
      .accessibilityLabel("DankDash wordmark")
  }
}

#Preview {
  VStack(spacing: DankSpacing.lg) {
    DankLogo(.mark, size: 48)
    DankLogo(.wordmark, size: 64)
    DankLogo(.full, size: 56)
  }
  .padding()
  .background(DankColor.cream)
}
