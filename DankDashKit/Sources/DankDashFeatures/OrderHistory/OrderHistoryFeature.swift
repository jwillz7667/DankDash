import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Orders tab list surface. Owns the cursor-paginated list of
/// ``OrderListItem`` rows the user has placed, the `active|completed|all`
/// segment filter, and the pull-to-refresh + bottom-paginate gestures.
///
/// State flow:
///
/// 1. `.onAppear` (first time) → `loadFirstPage` — `GET /v1/orders?status=
///    <filter>&limit=20`. Sets `isLoading = true`.
/// 2. `.firstPageLoaded(.success)` replaces `items` with the new page,
///    captures `nextCursor`, marks `hasLoadedOnce = true`.
/// 3. User pulls down → `.pullToRefresh` — same fetch as the initial
///    load but routed through `isRefreshing` so the view can keep
///    rendering the existing rows underneath the spinner.
/// 4. User scrolls past the last row → `.paginate` — if `nextCursor` is
///    non-nil and we're not already paginating, fire
///    `GET /v1/orders?status=...&cursor=<nextCursor>`. Append on success.
/// 5. User toggles the segment → `.filterChanged(newFilter)` — resets
///    `items` + `nextCursor`, refires `loadFirstPage`.
/// 6. User taps a row → `.orderTapped(orderId)` → delegate
///    `.openOrder(orderId)` so the parent (Browse/RootFeature) can push
///    `OrderDetailFeature`.
///
/// Errors on the first page surface via `state.error` (banner above the
/// list). Errors on pagination are non-fatal — the loaded rows stay in
/// place and `isPaginating` flips back to false so the user can retry by
/// scrolling.
@Reducer
public struct OrderHistoryFeature: Sendable {
  /// Server default page size — the iOS reducer doesn't override unless
  /// the test does, so this constant lives here only as the value the
  /// reducer ships in the `limit` query param.
  public static let pageSize: Int = 20

  @ObservableState
  public struct State: Equatable, Sendable {
    public var statusFilter: OrderListStatusFilter
    public var items: [OrderListItem]

    /// Cursor for the *next* page. `nil` means we've loaded the last
    /// page (or we haven't loaded at all yet — discriminate via
    /// ``hasLoadedOnce``).
    public var nextCursor: String?

    /// True while the initial fetch is in flight (no rows on screen
    /// yet, or filter just changed and we're replacing the list).
    public var isLoading: Bool

    /// True during a pull-to-refresh — the existing rows stay visible
    /// underneath; the view shows a top spinner.
    public var isRefreshing: Bool

    /// True while a `paginate` next-page fetch is in flight.
    public var isPaginating: Bool

    /// Top-of-list error banner. Set on first-page / refresh failures;
    /// pagination failures don't touch this (they just stop appending).
    public var error: String?

    /// True after the first successful first-page load (regardless of
    /// filter). Drives the difference between "show spinner" and
    /// "show empty state" on the view.
    public var hasLoadedOnce: Bool

    public init(
      statusFilter: OrderListStatusFilter = .active,
      items: [OrderListItem] = [],
      nextCursor: String? = nil,
      isLoading: Bool = false,
      isRefreshing: Bool = false,
      isPaginating: Bool = false,
      error: String? = nil,
      hasLoadedOnce: Bool = false
    ) {
      self.statusFilter = statusFilter
      self.items = items
      self.nextCursor = nextCursor
      self.isLoading = isLoading
      self.isRefreshing = isRefreshing
      self.isPaginating = isPaginating
      self.error = error
      self.hasLoadedOnce = hasLoadedOnce
    }

    /// True when the bottom-of-list paginate gesture should fire. The
    /// view reads this to decide whether to even render the
    /// `.onAppear` sentinel under the last row.
    public var canLoadNextPage: Bool {
      nextCursor != nil && !isPaginating && !isLoading && !isRefreshing
    }

    /// True when the list is empty *after* a load — drives the empty
    /// state ("No orders yet") vs. the spinner.
    public var showsEmptyState: Bool {
      hasLoadedOnce && items.isEmpty && !isLoading && !isRefreshing && error == nil
    }
  }

  public enum Action: Sendable {
    case onAppear
    case pullToRefresh
    case filterChanged(OrderListStatusFilter)
    case paginate
    case retryFirstPageTapped

    case firstPageLoaded(Result<OrderListPage, EquatableError>)
    case nextPageLoaded(Result<OrderListPage, EquatableError>)

    case orderTapped(UUID)

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case openOrder(orderId: UUID)
    }
  }

  @Dependency(\.ordersAPIClient) var ordersAPIClient

  public init() {}

  /// Cancel ids — first-page fetches replace each other (filter switch
  /// kills any in-flight first load); paginate is independent so a
  /// stale paginate from before the filter switch can't append into
  /// the new filter's list.
  private enum CancelID: Hashable {
    case firstPage
    case nextPage
  }

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Re-entering the tab after a previous load shouldn't re-fetch;
        // the user pulls to refresh if they want fresh data. This keeps
        // the scroll position intact on tab switches.
        guard !state.hasLoadedOnce, !state.isLoading else { return .none }
        return loadFirstPage(state: &state)

      case .pullToRefresh:
        guard !state.isLoading, !state.isRefreshing else { return .none }
        state.isRefreshing = true
        state.error = nil
        let filter = state.statusFilter
        return .run { [ordersAPIClient] send in
          do {
            let page = try await ordersAPIClient.listOrders(
              ListOrdersQuery(status: filter, limit: Self.pageSize, cursor: nil)
            )
            await send(.firstPageLoaded(.success(page)))
          } catch {
            await send(.firstPageLoaded(.failure(EquatableError(error))))
          }
        }.cancellable(id: CancelID.firstPage, cancelInFlight: true)

      case .filterChanged(let newFilter):
        guard newFilter != state.statusFilter else { return .none }
        state.statusFilter = newFilter
        // Reset to the empty state before the new first-page fetch so
        // the view doesn't briefly render rows from the previous
        // filter.
        state.items = []
        state.nextCursor = nil
        state.hasLoadedOnce = false
        return loadFirstPage(state: &state)

      case .paginate:
        guard state.canLoadNextPage, let cursor = state.nextCursor else { return .none }
        state.isPaginating = true
        let filter = state.statusFilter
        return .run { [ordersAPIClient] send in
          do {
            let page = try await ordersAPIClient.listOrders(
              ListOrdersQuery(status: filter, limit: Self.pageSize, cursor: cursor)
            )
            await send(.nextPageLoaded(.success(page)))
          } catch {
            await send(.nextPageLoaded(.failure(EquatableError(error))))
          }
        }.cancellable(id: CancelID.nextPage, cancelInFlight: true)

      case .retryFirstPageTapped:
        guard state.error != nil else { return .none }
        return loadFirstPage(state: &state)

      case .firstPageLoaded(.success(let page)):
        state.isLoading = false
        state.isRefreshing = false
        state.items = page.items
        state.nextCursor = page.nextCursor
        state.hasLoadedOnce = true
        state.error = nil
        return .none

      case .firstPageLoaded(.failure(let err)):
        state.isLoading = false
        state.isRefreshing = false
        state.error = err.message
        return .none

      case .nextPageLoaded(.success(let page)):
        state.isPaginating = false
        // Dedupe by id while preserving order — the cursor is keyed on
        // `(placedAt, id)` so concurrent inserts at the boundary can
        // legally produce overlap.
        var seen = Set<UUID>(state.items.map(\.id))
        let appended = page.items.filter { seen.insert($0.id).inserted }
        state.items.append(contentsOf: appended)
        state.nextCursor = page.nextCursor
        return .none

      case .nextPageLoaded(.failure):
        // Non-fatal: the rows we already have stay; the user can scroll
        // again to re-trigger. We deliberately don't surface a banner
        // here because the first-page banner is reserved for the empty
        // / failed-from-scratch state.
        state.isPaginating = false
        return .none

      case .orderTapped(let id):
        return .send(.delegate(.openOrder(orderId: id)))

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect helpers

  /// Fires the initial first-page fetch (used by onAppear,
  /// filterChanged, and retryFirstPageTapped). Mutates `state` so the
  /// caller can observe the `isLoading = true` transition without
  /// duplicating the branch.
  private func loadFirstPage(state: inout State) -> Effect<Action> {
    state.isLoading = true
    state.error = nil
    let filter = state.statusFilter
    return .run { [ordersAPIClient] send in
      do {
        let page = try await ordersAPIClient.listOrders(
          ListOrdersQuery(status: filter, limit: Self.pageSize, cursor: nil)
        )
        await send(.firstPageLoaded(.success(page)))
      } catch {
        await send(.firstPageLoaded(.failure(EquatableError(error))))
      }
    }.cancellable(id: CancelID.firstPage, cancelInFlight: true)
  }
}

