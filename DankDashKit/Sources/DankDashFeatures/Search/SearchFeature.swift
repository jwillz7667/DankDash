import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Reducer for the catalog search surface. Owns a debounced query field,
/// optional category / strain-type facets the user can toggle, and the
/// paginated list of `SearchProductResult`s the server returns. A new
/// query (3+ chars after `debounceMs` of silence) cancels any in-flight
/// search and starts a fresh page-0 fetch; toggling a facet collapses
/// pagination back to page 0; scrolling past the loaded results triggers
/// `paginate` which appends the next slab.
///
/// The feature surfaces a single `delegate.productTapped` so the parent
/// (Browse) can route to a fresh ProductDetail without the search owning
/// navigation state.
@Reducer
public struct SearchFeature: Sendable {
  /// Minimum query length before a network request is issued. Two-letter
  /// substrings produce too much noise; three-letter is the same gate
  /// the web search uses.
  public static let minimumQueryLength = 3
  /// Debounce window in milliseconds. The reducer test verifies that
  /// three quick keystrokes within this window collapse to a single
  /// search effect.
  public static let debounceMs = 300

  @ObservableState
  public struct State: Equatable, Sendable {
    public var query: String
    public var selectedCategoryId: UUID?
    public var selectedStrainType: StrainType?
    public var results: [SearchProductResult]
    public var categoryFacets: [SearchCategoryFacet]
    public var strainTypeFacets: [SearchStrainTypeFacet]
    public var page: SearchPage
    public var isLoading: Bool
    public var isLoadingNextPage: Bool
    public var error: String?

    public init(
      query: String = "",
      selectedCategoryId: UUID? = nil,
      selectedStrainType: StrainType? = nil,
      results: [SearchProductResult] = [],
      categoryFacets: [SearchCategoryFacet] = [],
      strainTypeFacets: [SearchStrainTypeFacet] = [],
      page: SearchPage = SearchPage(limit: 24, offset: 0, total: 0),
      isLoading: Bool = false,
      isLoadingNextPage: Bool = false,
      error: String? = nil
    ) {
      self.query = query
      self.selectedCategoryId = selectedCategoryId
      self.selectedStrainType = selectedStrainType
      self.results = results
      self.categoryFacets = categoryFacets
      self.strainTypeFacets = strainTypeFacets
      self.page = page
      self.isLoading = isLoading
      self.isLoadingNextPage = isLoadingNextPage
      self.error = error
    }

    /// True if the current query is at or above the minimum search
    /// length. Views read this to decide whether to render results or
    /// the "Start typing..." empty state.
    public var hasActiveQuery: Bool {
      query.count >= SearchFeature.minimumQueryLength
    }

    /// True if any facet is selected. Used by the Clear chip in the
    /// facet rail.
    public var hasActiveFacets: Bool {
      selectedCategoryId != nil || selectedStrainType != nil
    }

    /// True if `page.offset + page.limit < page.total` AND we have at
    /// least one result. Stops the list view from prefetching past the
    /// last page.
    public var canLoadNextPage: Bool {
      !results.isEmpty && page.hasNextPage
    }
  }

  public enum Action: Sendable, Equatable {
    case queryChanged(String)
    case queryDebounceFired
    case categoryFacetTapped(UUID?)
    case strainFacetTapped(StrainType?)
    case clearFacetsTapped
    case clearQueryTapped
    case paginate
    case searchResponse(Result<SearchProductsResult, SearchError>)
    case paginateResponse(Result<SearchProductsResult, SearchError>)
    case productTapped(UUID)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case openProduct(productId: UUID)
    }
  }

  public enum SearchError: Error, Sendable, Equatable {
    case transport
    case malformedPayload
    case unknown
  }

  @Dependency(\.catalogAPIClient) var api
  @Dependency(\.continuousClock) var clock

  public init() {}

  /// Identifier used to cancel the in-flight debounce + search effect
  /// when a new keystroke arrives.
  private enum CancelID: Hashable, Sendable {
    case search
  }

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .queryChanged(let new):
        state.query = new
        guard state.hasActiveQuery else {
          state.results = []
          state.categoryFacets = []
          state.strainTypeFacets = []
          state.page = SearchPage(limit: state.page.limit, offset: 0, total: 0)
          state.isLoading = false
          state.error = nil
          return .cancel(id: CancelID.search)
        }
        return .run { send in
          try await clock.sleep(for: .milliseconds(SearchFeature.debounceMs))
          await send(.queryDebounceFired)
        }
        .cancellable(id: CancelID.search, cancelInFlight: true)

      case .queryDebounceFired:
        guard state.hasActiveQuery else { return .none }
        return Self.runSearch(state: &state, isPagination: false, api: api)

      case .categoryFacetTapped(let id):
        state.selectedCategoryId = id
        guard state.hasActiveQuery else { return .none }
        return Self.runSearch(state: &state, isPagination: false, api: api)

      case .strainFacetTapped(let strain):
        state.selectedStrainType = strain
        guard state.hasActiveQuery else { return .none }
        return Self.runSearch(state: &state, isPagination: false, api: api)

      case .clearFacetsTapped:
        state.selectedCategoryId = nil
        state.selectedStrainType = nil
        guard state.hasActiveQuery else { return .none }
        return Self.runSearch(state: &state, isPagination: false, api: api)

      case .clearQueryTapped:
        state.query = ""
        state.results = []
        state.categoryFacets = []
        state.strainTypeFacets = []
        state.page = SearchPage(limit: state.page.limit, offset: 0, total: 0)
        state.isLoading = false
        state.error = nil
        return .cancel(id: CancelID.search)

      case .paginate:
        guard state.canLoadNextPage, !state.isLoadingNextPage else { return .none }
        return Self.runSearch(state: &state, isPagination: true, api: api)

      case .searchResponse(.success(let projection)):
        state.isLoading = false
        state.results = projection.results
        state.categoryFacets = projection.categoryFacets
        state.strainTypeFacets = projection.strainTypeFacets
        state.page = projection.page
        state.error = nil
        return .none

      case .searchResponse(.failure(let error)):
        state.isLoading = false
        state.error = Self.userMessage(for: error)
        return .none

      case .paginateResponse(.success(let projection)):
        state.isLoadingNextPage = false
        // Append, don't replace — pagination accumulates.
        let merged = state.results + projection.results
        // Dedupe by id while preserving order (the server may overlap
        // the boundary if inventory shifted between page fetches).
        var seen = Set<UUID>()
        state.results = merged.filter { seen.insert($0.id).inserted }
        state.categoryFacets = projection.categoryFacets
        state.strainTypeFacets = projection.strainTypeFacets
        state.page = projection.page
        return .none

      case .paginateResponse(.failure):
        // A failed pagination is non-fatal — the list keeps the rows
        // it already has. Surface it via a destructive toast in the
        // view if needed (out of scope for the reducer).
        state.isLoadingNextPage = false
        return .none

      case .productTapped(let id):
        return .send(.delegate(.openProduct(productId: id)))

      case .delegate:
        return .none
      }
    }
  }

  /// Issues a search request and routes the response onto either the
  /// fresh-page or pagination branch. Mutates `state` in-place to set
  /// the right loading flag and reset the offset for fresh searches.
  static func runSearch(
    state: inout State,
    isPagination: Bool,
    api: CatalogAPIClient
  ) -> Effect<Action> {
    let limit = state.page.limit
    let offset = isPagination ? state.page.offset + limit : 0
    let query = SearchProductsQuery(
      q: state.query,
      categoryId: state.selectedCategoryId,
      strainType: state.selectedStrainType,
      dispensaryId: nil,
      limit: limit,
      offset: offset
    )
    if isPagination {
      state.isLoadingNextPage = true
    } else {
      state.isLoading = true
      state.error = nil
    }
    return .run { send in
      do {
        let result = try await api.searchProducts(query)
        if isPagination {
          await send(.paginateResponse(.success(result)))
        } else {
          await send(.searchResponse(.success(result)))
        }
      } catch let error as CatalogAPIError {
        let mapped: SearchError
        switch error {
        case .malformedPayload: mapped = .malformedPayload
        case .unimplemented: mapped = .unknown
        }
        if isPagination {
          await send(.paginateResponse(.failure(mapped)))
        } else {
          await send(.searchResponse(.failure(mapped)))
        }
      } catch {
        if isPagination {
          await send(.paginateResponse(.failure(.transport)))
        } else {
          await send(.searchResponse(.failure(.transport)))
        }
      }
    }
    .cancellable(id: CancelID.search, cancelInFlight: true)
  }

  static func userMessage(for error: SearchError) -> String {
    switch error {
    case .transport: "We couldn't reach DankDash. Try again."
    case .malformedPayload: "Something didn't look right in the search results."
    case .unknown: "Something went wrong with that search."
    }
  }
}
