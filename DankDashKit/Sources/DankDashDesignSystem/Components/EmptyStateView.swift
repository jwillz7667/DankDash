import SwiftUI

/// Icon + title + body + optional action — used wherever a paged surface
/// has zero rows: feed without location grant, empty search, dispensary
/// with no menu items, empty cart. The icon is SFSymbol-keyed so brand
/// alignment is consistent across surfaces.
public struct EmptyStateView: View {
  private let systemImage: String
  private let title: String
  private let message: String
  private let actionTitle: String?
  private let action: (() -> Void)?

  public init(
    systemImage: String,
    title: String,
    message: String,
    actionTitle: String? = nil,
    action: (() -> Void)? = nil
  ) {
    self.systemImage = systemImage
    self.title = title
    self.message = message
    self.actionTitle = actionTitle
    self.action = action
  }

  public var body: some View {
    VStack(spacing: DankSpacing.md) {
      Image(systemName: systemImage)
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(DankColor.primary.opacity(0.55))
        .accessibilityHidden(true)
      Text(title)
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.primary)
        .multilineTextAlignment(.center)
      Text(message)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      if let actionTitle, let action {
        DankButton(actionTitle, style: .secondary, action: action)
          .frame(maxWidth: 280)
      }
    }
    .padding(.horizontal, DankSpacing.lg)
    .padding(.vertical, DankSpacing.xl)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(message)")
  }
}

#Preview {
  EmptyStateView(
    systemImage: "location.slash",
    title: "Location needed",
    message: "Turn on location so we can show dispensaries that deliver to you.",
    actionTitle: "Enable location",
    action: {}
  )
  .background(DankColor.cream)
}
