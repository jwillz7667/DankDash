import Foundation
import ComposableArchitecture
import DankDashDomain

/// The consumer's "Saved" screen — a reverse-chronological list of favorited
/// dispensaries and products, reachable from the Account tab. Loads the first
/// page of `GET /v1/me/favorites` on appearance and supports pull-to-refresh.
///
/// Removing a favorite is optimistic: the row is dropped immediately and the
/// unsave fired; a failure re-inserts the row at its original position so the
/// list matches the server. Row navigation into the storefront / product
/// detail is intentionally out of scope here (it would require threading a
/// listing resolution across the tab boundary) — the screen's job is to review
/// and prune saves; discovery + product detail own the deep links.
@Reducer
public struct FavoritesFeature: Sendable {
  /// Page size for the saved-items list. Deep pagination is a follow-up; one
  /// generous page covers the overwhelming majority of shoppers.
  static let pageSize = 50

  @ObservableState
  public struct State: Equatable, Sendable {
    public var items: [FavoriteItem]
    public var isLoading: Bool
    public var hasLoaded: Bool
    public var error: String?

    public init(
      items: [FavoriteItem] = [],
      isLoading: Bool = false,
      hasLoaded: Bool = false,
      error: String? = nil
    ) {
      self.items = items
      self.isLoading = isLoading
      self.hasLoaded = hasLoaded
      self.error = error
    }
  }

  public enum Action: Sendable, Equatable {
    case task
    case pullToRefresh
    case favoritesResponse(Result<FavoritesPage, FavoritesError>)
    /// Heart tapped on a saved row — drop it optimistically and unsave.
    case unfavoriteTapped(id: UUID)
    /// Unsave settled. On failure the removed row is restored at `index`.
    case unfavoriteResponse(item: FavoriteItem, index: Int, didSucceed: Bool)
  }

  public enum FavoritesError: Error, Sendable, Equatable {
    case transport
    case unknown
  }

  @Dependency(\.favoritesAPIClient) var favoritesClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .task, .pullToRefresh:
        state.isLoading = true
        state.error = nil
        return .run { send in
          do {
            let page = try await favoritesClient.list(Self.pageSize, 0)
            await send(.favoritesResponse(.success(page)))
          } catch {
            await send(.favoritesResponse(.failure(.transport)))
          }
        }

      case .favoritesResponse(.success(let page)):
        state.isLoading = false
        state.hasLoaded = true
        state.items = page.items
        state.error = nil
        return .none

      case .favoritesResponse(.failure(let error)):
        state.isLoading = false
        state.hasLoaded = true
        state.error = Self.userMessage(for: error)
        return .none

      case .unfavoriteTapped(let id):
        guard let index = state.items.firstIndex(where: { $0.id == id }) else { return .none }
        let item = state.items.remove(at: index)
        return .run { send in
          do {
            switch item {
            case .dispensary:
              try await favoritesClient.removeDispensary(id)
            case .product:
              try await favoritesClient.removeProduct(id)
            }
            await send(.unfavoriteResponse(item: item, index: index, didSucceed: true))
          } catch {
            await send(.unfavoriteResponse(item: item, index: index, didSucceed: false))
          }
        }

      case let .unfavoriteResponse(item, index, didSucceed):
        // Success needs no work — the row is already gone. On failure restore
        // it at its original slot (clamped, in case the list changed under it).
        if !didSucceed {
          let clamped = min(index, state.items.count)
          state.items.insert(item, at: clamped)
        }
        return .none
      }
    }
  }

  static func userMessage(for error: FavoritesError) -> String {
    switch error {
    case .transport: "We couldn't load your favorites. Pull to refresh to try again."
    case .unknown: "Something went wrong loading your favorites."
    }
  }
}
