import SwiftUI

/// Eyebrow + title pair used at the top of every feed and search section
/// ("Delivering Now", "Top Rated", etc.). The eyebrow renders in accent
/// gold above the title to give the section a tabletop-magazine feel
/// matching the spec §5.1 visual language. Optional `accessoryTitle`
/// shows a trailing pill-style "See all" affordance.
public struct SectionHeader: View {
  private let eyebrow: String?
  private let title: String
  private let accessoryTitle: String?
  private let accessoryAction: (() -> Void)?

  public init(
    eyebrow: String? = nil,
    title: String,
    accessoryTitle: String? = nil,
    accessoryAction: (() -> Void)? = nil
  ) {
    self.eyebrow = eyebrow
    self.title = title
    self.accessoryTitle = accessoryTitle
    self.accessoryAction = accessoryAction
  }

  public var body: some View {
    HStack(alignment: .lastTextBaseline, spacing: DankSpacing.sm) {
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        if let eyebrow {
          Text(eyebrow.uppercased())
            .font(DankFont.caption)
            .tracking(1.2)
            .foregroundStyle(DankColor.accent)
            .accessibilityHidden(true)
        }
        Text(title)
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
      }
      Spacer(minLength: 0)
      if let accessoryTitle, let accessoryAction {
        Button(accessoryTitle, action: accessoryAction)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.primary)
          .accessibilityHint("Opens \(title)")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(eyebrow.map { "\($0), \(title)" } ?? title)
    .accessibilityAddTraits(.isHeader)
  }
}

#Preview {
  VStack(spacing: DankSpacing.lg) {
    SectionHeader(eyebrow: "Near you", title: "Delivering now")
    SectionHeader(
      eyebrow: "Trending",
      title: "Top rated",
      accessoryTitle: "See all",
      accessoryAction: {}
    )
    SectionHeader(title: "New arrivals")
  }
  .padding()
  .background(DankColor.cream)
}
