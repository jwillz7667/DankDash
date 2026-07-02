import SwiftUI

/// A heart toggle for saving a dispensary or product. Renders a filled or
/// outline SF Symbol heart on a frosted circular chip so it reads over both
/// photography (feed/detail hero overlays) and flat surfaces. The parent owns
/// the `isFavorite` state and performs the optimistic flip; this view is
/// purely presentational + a tap target.
public struct FavoriteButton: View {
  private let isFavorite: Bool
  private let overImagery: Bool
  private let action: () -> Void

  /// - Parameters:
  ///   - isFavorite: whether the target is currently saved (drives fill).
  ///   - overImagery: `true` when the button sits on a photo/gradient (feed
  ///     cards, detail hero) so it gets a frosted chip and light outline;
  ///     `false` on flat surfaces (a toolbar), where it's a bare heart.
  ///   - action: invoked on tap. The parent flips state optimistically.
  public init(
    isFavorite: Bool,
    overImagery: Bool = true,
    action: @escaping () -> Void
  ) {
    self.isFavorite = isFavorite
    self.overImagery = overImagery
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Image(systemName: isFavorite ? "heart.fill" : "heart")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(iconColor)
        .padding(overImagery ? DankSpacing.xs : 0)
        .background(chip)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
    .accessibilityAddTraits(isFavorite ? [.isButton, .isSelected] : .isButton)
  }

  private var iconColor: Color {
    if isFavorite { return DankColor.Semantic.danger }
    return overImagery ? DankColor.Text.onPrimary : DankColor.Text.secondary
  }

  @ViewBuilder private var chip: some View {
    if overImagery {
      Circle().fill(DankColor.primaryDark.opacity(0.45))
    }
  }
}
