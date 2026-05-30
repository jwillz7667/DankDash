import Foundation
import ComposableArchitecture
import DankDashDomain

/// Reducer for a single dispensary's storefront — hero, hours, rating,
/// category tab bar, and the 2-column product grid. Owns the active
/// category selection, the filter sheet state, and the offline cache
/// fallback for both the dispensary record and its menu.
///
/// Three things load in parallel from `.task`:
///   1. The cached dispensary (if any) → seeds the hero immediately.
///   2. The cached menu snapshot (if any) → seeds the grid immediately.
///   3. The cached category list → seeds the tab bar immediately.
///
/// The network fetch then overwrites each in turn. Category list is
/// fetched once per session (categories are global, not per-dispensary).
@Reducer
public struct StorefrontFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public let dispensaryId: UUID
    public var dispensary: Dispensary?
    public var menuItems: [MenuItem]
    public var categories: [DankDashDomain.Category]
    /// `nil` = "All" tab. The view binds the tab bar's selection to
    /// this directly.
    public var selectedCategoryId: UUID?
    public var filter: MenuFilter
    public var isShowingFilterSheet: Bool
    public var isLoading: Bool
    public var isShowingFromCache: Bool
    public var error: String?

    public init(
      dispensaryId: UUID,
      dispensary: Dispensary? = nil,
      menuItems: [MenuItem] = [],
      categories: [DankDashDomain.Category] = [],
      selectedCategoryId: UUID? = nil,
      filter: MenuFilter = .none,
      isShowingFilterSheet: Bool = false,
      isLoading: Bool = false,
      isShowingFromCache: Bool = false,
      error: String? = nil
    ) {
      self.dispensaryId = dispensaryId
      self.dispensary = dispensary
      self.menuItems = menuItems
      self.categories = categories
      self.selectedCategoryId = selectedCategoryId
      self.filter = filter
      self.isShowingFilterSheet = isShowingFilterSheet
      self.isLoading = isLoading
      self.isShowingFromCache = isShowingFromCache
      self.error = error
    }

    /// Menu items narrowed by the active category tab and the filter
    /// sheet, in that order. The category tab acts on `categoryId`
    /// because the server's category ontology is the same set the
    /// filter UI references.
    public var filteredItems: [MenuItem] {
      var result = menuItems
      if let selectedCategoryId {
        result = result.filter { $0.product.categoryId == selectedCategoryId }
      }
      return filter.apply(to: result)
    }

    /// Only categories that have at least one item on this menu. The
    /// storefront tab bar omits "Flower" if the dispensary doesn't
    /// stock any.
    public var visibleCategories: [DankDashDomain.Category] {
      let menuCategoryIds = Set(menuItems.map(\.product.categoryId))
      return categories
        .filter { menuCategoryIds.contains($0.id) }
        .sorted { $0.displayOrder < $1.displayOrder }
    }
  }

  public enum Action: Sendable, Equatable {
    case task
    case cacheLoaded(
      dispensary: Dispensary?,
      menu: CatalogCacheClient.MenuSnapshot?,
      categories: [DankDashDomain.Category]?
    )
    case fetchRequested
    case dispensaryResponse(Result<Dispensary, StorefrontError>)
    case menuResponse(Result<[MenuItem], StorefrontError>)
    case categoriesResponse(Result<[DankDashDomain.Category], StorefrontError>)
    case categorySelected(UUID?)
    case filterButtonTapped
    case filterDismissed
    case filterChanged(MenuFilter)
    case filterCleared
    case productTapped(productId: UUID, listingId: UUID)
    case pullToRefresh
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case openProduct(productId: UUID, listingId: UUID)
    }
  }

  public enum StorefrontError: Error, Sendable, Equatable {
    case transport
    case malformedPayload
    case notFound
    case unknown
  }

  @Dependency(\.catalogAPIClient) var api
  @Dependency(\.catalogCacheClient) var cache

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .task:
        let dispensaryId = state.dispensaryId
        return .run { send in
          async let cachedDispensary = cache.readMenu(dispensaryId)
          async let cachedMenu = cache.readMenu(dispensaryId)
          async let cachedCategories = cache.readCategories()
          // The dispensary record itself isn't cached in a dedicated
          // namespace yet — the menu snapshot carries its dispensaryId
          // but not the full dispensary record. We rely on the network
          // fetch to populate the hero in this pass; the menu snapshot
          // is the more valuable cache hit because the grid is the
          // expensive paint.
          _ = await cachedDispensary
          let menu = await cachedMenu
          let categories = await cachedCategories
          await send(.cacheLoaded(
            dispensary: nil,
            menu: menu,
            categories: categories
          ))
          await send(.fetchRequested)
        }

      case .cacheLoaded(let dispensary, let menu, let categories):
        if let dispensary {
          state.dispensary = dispensary
          state.isShowingFromCache = true
        }
        if let menu {
          state.menuItems = menu.items
          state.isShowingFromCache = true
        }
        if let categories {
          state.categories = categories
        }
        return .none

      case .fetchRequested:
        state.isLoading = true
        state.error = nil
        let dispensaryId = state.dispensaryId
        let hadCachedCategories = !state.categories.isEmpty
        return .run { send in
          async let dispensary = Self.fetchDispensary(id: dispensaryId, api: api)
          async let menu = Self.fetchMenu(id: dispensaryId, api: api, cache: cache)
          async let categories = Self.fetchCategoriesIfNeeded(
            api: api,
            cache: cache,
            skip: hadCachedCategories
          )
          await send(.dispensaryResponse(await dispensary))
          await send(.menuResponse(await menu))
          if let categoriesResult = await categories {
            await send(.categoriesResponse(categoriesResult))
          }
        }

      case .dispensaryResponse(.success(let dispensary)):
        state.dispensary = dispensary
        state.isLoading = false
        state.isShowingFromCache = false
        state.error = nil
        return .none

      case .dispensaryResponse(.failure(let error)):
        state.isLoading = false
        if state.dispensary == nil {
          state.error = Self.userMessage(for: error)
        } else {
          state.isShowingFromCache = true
        }
        return .none

      case .menuResponse(.success(let items)):
        state.menuItems = items
        state.isShowingFromCache = false
        state.error = nil
        return .none

      case .menuResponse(.failure(let error)):
        if state.menuItems.isEmpty {
          state.error = Self.userMessage(for: error)
        } else {
          state.isShowingFromCache = true
        }
        return .none

      case .categoriesResponse(.success(let categories)):
        state.categories = categories
        return .none

      case .categoriesResponse(.failure):
        // Categories are non-blocking — if the call fails and we have a
        // cached list, use it; if we have nothing, the tab bar collapses
        // to the "All" pill and the grid still renders.
        return .none

      case .categorySelected(let id):
        state.selectedCategoryId = id
        return .none

      case .filterButtonTapped:
        state.isShowingFilterSheet = true
        return .none

      case .filterDismissed:
        state.isShowingFilterSheet = false
        return .none

      case .filterChanged(let filter):
        state.filter = filter
        return .none

      case .filterCleared:
        state.filter = .none
        return .none

      case .productTapped(let productId, let listingId):
        return .send(.delegate(.openProduct(productId: productId, listingId: listingId)))

      case .pullToRefresh:
        return .send(.fetchRequested)

      case .delegate:
        return .none
      }
    }
  }

  static func fetchDispensary(
    id: UUID,
    api: CatalogAPIClient
  ) async -> Result<Dispensary, StorefrontError> {
    do {
      let dispensary = try await api.getDispensary(id)
      return .success(dispensary)
    } catch let error as CatalogAPIError {
      switch error {
      case .malformedPayload: return .failure(.malformedPayload)
      case .unimplemented: return .failure(.unknown)
      }
    } catch {
      return .failure(.transport)
    }
  }

  static func fetchMenu(
    id: UUID,
    api: CatalogAPIClient,
    cache: CatalogCacheClient
  ) async -> Result<[MenuItem], StorefrontError> {
    do {
      let projection = try await api.getMenu(id)
      let snapshot = CatalogCacheClient.MenuSnapshot(
        dispensaryId: projection.dispensaryId,
        items: projection.items
      )
      await cache.writeMenu(id, snapshot)
      return .success(projection.items)
    } catch let error as CatalogAPIError {
      switch error {
      case .malformedPayload: return .failure(.malformedPayload)
      case .unimplemented: return .failure(.unknown)
      }
    } catch {
      return .failure(.transport)
    }
  }

  static func fetchCategoriesIfNeeded(
    api: CatalogAPIClient,
    cache: CatalogCacheClient,
    skip: Bool
  ) async -> Result<[DankDashDomain.Category], StorefrontError>? {
    if skip { return nil }
    do {
      let categories = try await api.listCategories()
      await cache.writeCategories(categories)
      return .success(categories)
    } catch let error as CatalogAPIError {
      switch error {
      case .malformedPayload: return .failure(.malformedPayload)
      case .unimplemented: return .failure(.unknown)
      }
    } catch {
      return .failure(.transport)
    }
  }

  static func userMessage(for error: StorefrontError) -> String {
    switch error {
    case .transport: "We couldn't reach DankDash. Pull to retry."
    case .malformedPayload: "Something didn't look right in the response."
    case .notFound: "This dispensary isn't available right now."
    case .unknown: "Something went wrong loading this dispensary."
    }
  }
}
