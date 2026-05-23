import SwiftUI

/// Bottom-anchored sheet wrapper that puts a moss-tinted handle + soft
/// drop shadow on top of arbitrary content. Wraps `.presentationDetents`
/// so callers don't have to remember the iOS 16.4+ API surface.
public struct DankSheet<Content: View>: View {
  private let content: () -> Content

  public init(@ViewBuilder content: @escaping () -> Content) {
    self.content = content
  }

  public var body: some View {
    VStack(spacing: 0) {
      Capsule()
        .fill(DankColor.primary.opacity(0.18))
        .frame(width: 40, height: 5)
        .padding(.top, DankSpacing.sm)

      content()
        .padding(.horizontal, DankSpacing.lg)
        .padding(.vertical, DankSpacing.md)
    }
    .frame(maxWidth: .infinity, alignment: .top)
    .background(DankColor.cream)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .shadow(color: DankColor.primaryDark.opacity(0.1), radius: 16, x: 0, y: -2)
  }
}

#Preview {
  ZStack(alignment: .bottom) {
    DankColor.primary.ignoresSafeArea()
    DankSheet {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        Text("Confirm your order")
          .font(DankFont.headline)
        Text("Total: $42.18")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
      }
    }
  }
}
