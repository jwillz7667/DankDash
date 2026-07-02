import SwiftUI
import DankDashDomain

/// Feed-card representation of a Dispensary. The card layers brand text
/// over the hero image with a frosted overlay so the moss/cream palette
/// reads cleanly over photography. The open/closed pill is the most
/// important affordance — the spec's §10.4 menu-only constraint hinges on
/// the user clearly knowing whether they can place an order right now.
public struct DispensaryCard: View {
  private let dispensary: Dispensary
  private let cdnBaseURL: URL?
  private let etaHint: String?
  private let isFavorite: Bool?
  private let favoriteAction: (() -> Void)?
  private let action: () -> Void

  /// - Parameters:
  ///   - isFavorite / favoriteAction: when both are supplied, a heart toggle
  ///     is overlaid on the top-trailing corner. Pass `nil` (the default) on
  ///     surfaces that don't offer saving, and the heart is omitted entirely.
  public init(
    dispensary: Dispensary,
    cdnBaseURL: URL?,
    etaHint: String? = nil,
    isFavorite: Bool? = nil,
    favoriteAction: (() -> Void)? = nil,
    action: @escaping () -> Void
  ) {
    self.dispensary = dispensary
    self.cdnBaseURL = cdnBaseURL
    self.etaHint = etaHint
    self.isFavorite = isFavorite
    self.favoriteAction = favoriteAction
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      ZStack(alignment: .bottomLeading) {
        DankAsyncImage(
          imageKey: dispensary.heroImageKey,
          cdnBaseURL: cdnBaseURL,
          contentMode: .fill,
          aspectRatio: 16.0 / 9.0
        )

        LinearGradient(
          colors: [
            Color.black.opacity(0.0),
            Color.black.opacity(0.45),
            Color.black.opacity(0.65),
          ],
          startPoint: .top,
          endPoint: .bottom
        )
        .allowsHitTesting(false)

        VStack(alignment: .leading, spacing: DankSpacing.xs) {
          HStack(spacing: DankSpacing.xs) {
            statusBadge
            if let etaHint {
              DankBadge(etaHint, tone: .accent)
            }
            Spacer(minLength: 0)
            if let rating = dispensary.ratingAvg {
              HStack(spacing: 2) {
                Image(systemName: "star.fill")
                  .font(.system(size: 11, weight: .semibold))
                Text(Self.ratingFormatter.string(from: rating as NSDecimalNumber) ?? "—")
                  .font(DankFont.caption)
                Text("(\(dispensary.ratingCount))")
                  .font(DankFont.caption)
                  .opacity(0.8)
              }
              .foregroundStyle(DankColor.Text.onPrimary)
              .padding(.horizontal, DankSpacing.xs)
              .padding(.vertical, DankSpacing.xxs)
              .background(DankColor.primaryDark.opacity(0.55))
              .clipShape(Capsule())
            }
          }
          Text(dispensary.displayName)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.onPrimary)
            .lineLimit(1)
          Text("\(dispensary.city), \(dispensary.region)")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.onPrimary.opacity(0.85))
            .lineLimit(1)
        }
        .padding(DankSpacing.md)
      }
      .frame(maxWidth: .infinity)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
      )
      .shadow(color: .black.opacity(0.18), radius: 14, x: 0, y: 8)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(.isButton)
    // Heart lives as a sibling overlay (not inside the card Button) so its
    // tap toggles the favorite without also triggering navigation.
    .overlay(alignment: .topTrailing) {
      if let isFavorite, let favoriteAction {
        FavoriteButton(isFavorite: isFavorite, action: favoriteAction)
          .padding(DankSpacing.xs)
      }
    }
  }

  @ViewBuilder private var statusBadge: some View {
    if dispensary.isOpenNow {
      DankBadge("Open now", tone: .success)
    } else if let opensAt = dispensary.opensAt {
      DankBadge("Opens \(Self.timeFormatter.string(from: opensAt))", tone: .warning)
    } else {
      DankBadge("Closed", tone: .neutral)
    }
  }

  private var accessibilityLabel: String {
    var parts: [String] = [dispensary.displayName]
    if dispensary.isOpenNow {
      parts.append("open now")
    } else if let opensAt = dispensary.opensAt {
      parts.append("opens at \(Self.timeFormatter.string(from: opensAt))")
    } else {
      parts.append("closed")
    }
    if let rating = dispensary.ratingAvg, let s = Self.ratingFormatter.string(from: rating as NSDecimalNumber) {
      parts.append("rated \(s) stars from \(dispensary.ratingCount) reviews")
    }
    parts.append("in \(dispensary.city), \(dispensary.region)")
    return parts.joined(separator: ", ")
  }

  private static let ratingFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.minimumFractionDigits = 1
    f.maximumFractionDigits = 1
    return f
  }()

  private static let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f
  }()
}
