import SwiftUI

public struct DankLoader: View {
  public enum Size: Sendable {
    case small, medium, large

    public var dimension: CGFloat {
      switch self {
      case .small: 24
      case .medium: 40
      case .large: 64
      }
    }
  }

  private let size: Size
  private let tint: Color

  public init(size: Size = .medium, tint: Color = DankColor.primary) {
    self.size = size
    self.tint = tint
  }

  public var body: some View {
    ProgressView()
      .progressViewStyle(.circular)
      .tint(tint)
      .scaleEffect(size.dimension / 20)
      .frame(width: size.dimension, height: size.dimension)
      .accessibilityLabel("Loading")
      .accessibilityAddTraits(.updatesFrequently)
  }
}

#Preview {
  HStack(spacing: DankSpacing.lg) {
    DankLoader(size: .small)
    DankLoader(size: .medium)
    DankLoader(size: .large)
  }
  .padding()
  .background(DankColor.cream)
}
