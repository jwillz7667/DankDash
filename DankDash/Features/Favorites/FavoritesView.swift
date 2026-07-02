import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// The "Saved" screen, pushed from the Account tab. Lists the user's favorited
/// dispensaries and products newest-first; the trailing heart on each row
/// removes it (optimistically, in ``FavoritesFeature``). Pull-to-refresh
/// re-reads the first page.
struct FavoritesView: View {
  @Bindable var store: StoreOf<FavoritesFeature>
  @Dependency(\.cdnBaseURL) private var cdnBaseURL

  var body: some View {
    Group {
      if store.items.isEmpty {
        emptyOrLoading
      } else {
        ScrollView {
          LazyVStack(spacing: DankSpacing.sm) {
            if let error = store.error {
              InlineErrorBanner(message: error)
            }
            ForEach(store.items) { item in
              FavoriteRow(
                item: item,
                cdnBaseURL: cdnBaseURL,
                onUnfavorite: { store.send(.unfavoriteTapped(id: item.id)) }
              )
            }
            Color.clear.frame(height: DankSpacing.lg)
          }
          .padding(DankSpacing.lg)
        }
        .refreshable { store.send(.pullToRefresh) }
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Favorites")
    .navigationBarTitleDisplayMode(.inline)
    .task { store.send(.task) }
  }

  @ViewBuilder private var emptyOrLoading: some View {
    if store.isLoading && !store.hasLoaded {
      VStack { Spacer(); DankLoader(); Spacer() }
    } else if let error = store.error {
      EmptyStateView(
        systemImage: "heart.slash",
        title: "Couldn't load favorites",
        message: error,
        actionTitle: "Try again",
        action: { store.send(.task) }
      )
    } else {
      EmptyStateView(
        systemImage: "heart",
        title: "No favorites yet",
        message: "Tap the heart on a dispensary or product to save it here for quick access."
      )
    }
  }
}

/// One saved item: thumbnail, title/subtitle, and a filled heart that removes
/// it. Rows are not tappable-into-detail in this iteration — the screen's job
/// is to review and prune saves.
private struct FavoriteRow: View {
  let item: FavoriteItem
  let cdnBaseURL: URL?
  let onUnfavorite: () -> Void

  var body: some View {
    DankCard {
      HStack(spacing: DankSpacing.sm) {
        DankAsyncImage(
          imageKey: imageKey,
          cdnBaseURL: cdnBaseURL,
          contentMode: .fill,
          aspectRatio: 1
        )
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))

        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(title)
            .font(DankFont.body.weight(.semibold))
            .foregroundStyle(DankColor.Text.primary)
            .lineLimit(1)
          Text(subtitle)
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        FavoriteButton(isFavorite: true, overImagery: false, action: onUnfavorite)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(subtitle)")
  }

  private var imageKey: String? {
    switch item {
    case let .dispensary(_, dispensary): return dispensary.heroImageKey ?? dispensary.logoImageKey
    case let .product(_, product): return product.imageKeys.first
    }
  }

  private var title: String {
    switch item {
    case let .dispensary(_, dispensary): return dispensary.displayName
    case let .product(_, product): return product.name
    }
  }

  private var subtitle: String {
    switch item {
    case let .dispensary(_, dispensary):
      let place = "\(dispensary.city), \(dispensary.region)"
      return dispensary.isOpenNow ? "Open now · \(place)" : place
    case let .product(_, product):
      return product.brand
    }
  }
}

/// Compact inline error strip for a stale/failed refresh where we still have
/// rows to show.
private struct InlineErrorBanner: View {
  let message: String

  var body: some View {
    Text(message)
      .font(DankFont.bodySmall)
      .foregroundStyle(DankColor.Semantic.danger)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(DankSpacing.sm)
      .background(DankColor.Semantic.danger.opacity(0.08))
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
  }
}
