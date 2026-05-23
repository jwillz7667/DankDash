import XCTest
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class OrderHistoryFeatureTests: XCTestCase {
  func test_onAppear_loadsFirstPage_andPopulatesItems() async {
    let items = [makeListItem(shortCode: "DD-A"), makeListItem(shortCode: "DD-B")]
    let queryRecorder = QueryRecorder()

    let store = TestStore(initialState: OrderHistoryFeature.State()) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { query in
        await queryRecorder.record(query)
        return OrderListPage(items: items, nextCursor: "cursor-2")
      }
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.firstPageLoaded) {
      $0.isLoading = false
      $0.items = items
      $0.nextCursor = "cursor-2"
      $0.hasLoadedOnce = true
    }

    let recorded = await queryRecorder.snapshot()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded.first?.status, .active)
    XCTAssertEqual(recorded.first?.limit, OrderHistoryFeature.pageSize)
    XCTAssertNil(recorded.first?.cursor)
  }

  func test_onAppear_isIdempotent_whenAlreadyLoaded() async {
    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: [makeListItem(shortCode: "DD-A")],
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        XCTFail("should not fetch when already loaded")
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.onAppear)
  }

  func test_onAppear_isIdempotent_whileLoading() async {
    let store = TestStore(
      initialState: OrderHistoryFeature.State(isLoading: true)
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        XCTFail("should not fetch while loading")
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.onAppear)
  }

  func test_pullToRefresh_refetchesFirstPage_preservingExistingItemsUntilLoaded() async {
    let existing = [makeListItem(shortCode: "DD-OLD")]
    let fresh = [makeListItem(shortCode: "DD-NEW")]
    let queryRecorder = QueryRecorder()

    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: existing,
        nextCursor: "stale",
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { query in
        await queryRecorder.record(query)
        return OrderListPage(items: fresh, nextCursor: nil)
      }
    }

    await store.send(.pullToRefresh) {
      $0.isRefreshing = true
    }
    await store.receive(\.firstPageLoaded) {
      $0.isRefreshing = false
      $0.items = fresh
      $0.nextCursor = nil
    }

    let recorded = await queryRecorder.snapshot()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertNil(recorded.first?.cursor)
  }

  func test_filterChanged_resetsItems_andRefetchesWithNewFilter() async {
    let originalItems = [makeListItem(shortCode: "DD-A")]
    let queryRecorder = QueryRecorder()

    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        statusFilter: .active,
        items: originalItems,
        nextCursor: "stale",
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { query in
        await queryRecorder.record(query)
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.filterChanged(.completed)) {
      $0.statusFilter = .completed
      $0.items = []
      $0.nextCursor = nil
      $0.hasLoadedOnce = false
      $0.isLoading = true
    }
    await store.receive(\.firstPageLoaded) {
      $0.isLoading = false
      $0.hasLoadedOnce = true
    }

    let recorded = await queryRecorder.snapshot()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded.first?.status, .completed)
  }

  func test_filterChanged_isNoop_whenSameFilter() async {
    let store = TestStore(
      initialState: OrderHistoryFeature.State(statusFilter: .completed)
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        XCTFail("should not refetch on same filter")
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.filterChanged(.completed))
  }

  func test_paginate_fetchesNextPageWithCursor_andAppendsRows() async {
    let firstPage = [makeListItem(shortCode: "DD-A")]
    let secondPage = [makeListItem(shortCode: "DD-B"), makeListItem(shortCode: "DD-C")]
    let queryRecorder = QueryRecorder()

    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: firstPage,
        nextCursor: "cursor-2",
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { query in
        await queryRecorder.record(query)
        return OrderListPage(items: secondPage, nextCursor: nil)
      }
    }

    await store.send(.paginate) {
      $0.isPaginating = true
    }
    await store.receive(\.nextPageLoaded) {
      $0.isPaginating = false
      $0.items = firstPage + secondPage
      $0.nextCursor = nil
    }

    let recorded = await queryRecorder.snapshot()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded.first?.cursor, "cursor-2")
  }

  func test_paginate_isNoop_whenNoNextCursor() async {
    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: [makeListItem(shortCode: "DD-A")],
        nextCursor: nil,
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        XCTFail("should not paginate without a cursor")
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.paginate)
  }

  func test_paginate_isNoop_whileAlreadyPaginating() async {
    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: [makeListItem(shortCode: "DD-A")],
        nextCursor: "cursor-2",
        isPaginating: true,
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        XCTFail("should not paginate twice in parallel")
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.paginate)
  }

  func test_paginate_dedupsOverlappingRowsByID() async {
    let shared = makeListItem(id: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!, shortCode: "DD-A")
    let novel = makeListItem(id: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!, shortCode: "DD-B")

    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: [shared],
        nextCursor: "cursor-2",
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        OrderListPage(items: [shared, novel], nextCursor: nil)
      }
    }

    await store.send(.paginate) {
      $0.isPaginating = true
    }
    await store.receive(\.nextPageLoaded) {
      $0.isPaginating = false
      $0.items = [shared, novel]
      $0.nextCursor = nil
    }
  }

  func test_firstPageFailure_surfacesErrorBanner() async {
    struct StubError: LocalizedError {
      var errorDescription: String? { "Offline." }
    }

    let store = TestStore(initialState: OrderHistoryFeature.State()) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in throw StubError() }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.firstPageLoaded) {
      $0.isLoading = false
      $0.error = "Offline."
    }
  }

  func test_paginationFailure_isNonFatal_keepsExistingRows() async {
    struct StubError: LocalizedError {
      var errorDescription: String? { "Timeout." }
    }

    let existing = [makeListItem(shortCode: "DD-A")]

    let store = TestStore(
      initialState: OrderHistoryFeature.State(
        items: existing,
        nextCursor: "cursor-2",
        hasLoadedOnce: true
      )
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in throw StubError() }
    }

    await store.send(.paginate) {
      $0.isPaginating = true
    }
    await store.receive(\.nextPageLoaded) {
      $0.isPaginating = false
      // items unchanged, error unchanged
    }
  }

  func test_retryFirstPageTapped_refetchesAfterFailure() async {
    let items = [makeListItem(shortCode: "DD-A")]

    let store = TestStore(
      initialState: OrderHistoryFeature.State(error: "Offline.")
    ) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        OrderListPage(items: items, nextCursor: nil)
      }
    }

    await store.send(.retryFirstPageTapped) {
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.firstPageLoaded) {
      $0.isLoading = false
      $0.items = items
      $0.hasLoadedOnce = true
    }
  }

  func test_retryFirstPageTapped_isNoop_whenNoError() async {
    let store = TestStore(initialState: OrderHistoryFeature.State()) {
      OrderHistoryFeature()
    } withDependencies: {
      $0.ordersAPIClient.listOrders = { _ in
        XCTFail("should not retry when not in error state")
        return OrderListPage(items: [], nextCursor: nil)
      }
    }

    await store.send(.retryFirstPageTapped)
  }

  func test_orderTapped_emitsOpenOrderDelegate() async {
    let orderId = UUID()
    let item = makeListItem(id: orderId, shortCode: "DD-A")

    let store = TestStore(
      initialState: OrderHistoryFeature.State(items: [item], hasLoadedOnce: true)
    ) {
      OrderHistoryFeature()
    }

    await store.send(.orderTapped(orderId))
    await store.receive(\.delegate.openOrder)
  }

  func test_canLoadNextPage_requiresCursorAndIdleState() {
    var state = OrderHistoryFeature.State(
      items: [makeListItem(shortCode: "DD-A")],
      nextCursor: "cursor-2",
      hasLoadedOnce: true
    )
    XCTAssertTrue(state.canLoadNextPage)

    state.nextCursor = nil
    XCTAssertFalse(state.canLoadNextPage)

    state.nextCursor = "cursor-2"
    state.isPaginating = true
    XCTAssertFalse(state.canLoadNextPage)

    state.isPaginating = false
    state.isLoading = true
    XCTAssertFalse(state.canLoadNextPage)

    state.isLoading = false
    state.isRefreshing = true
    XCTAssertFalse(state.canLoadNextPage)
  }

  func test_showsEmptyState_onlyAfterLoadWithNoItemsAndNoError() {
    var state = OrderHistoryFeature.State()
    XCTAssertFalse(state.showsEmptyState, "before loading should not show empty state")

    state.hasLoadedOnce = true
    XCTAssertTrue(state.showsEmptyState)

    state.error = "boom"
    XCTAssertFalse(state.showsEmptyState, "error overrides empty state")

    state.error = nil
    state.items = [makeListItem(shortCode: "DD-A")]
    XCTAssertFalse(state.showsEmptyState, "items override empty state")
  }
}

// MARK: - Helpers

private func makeListItem(
  id: UUID = UUID(),
  shortCode: String,
  status: OrderStatus = .placed
) -> OrderListItem {
  OrderListItem(
    id: id,
    shortCode: shortCode,
    dispensaryId: UUID(),
    status: status,
    totalCents: 5_000,
    placedAt: Date(timeIntervalSinceReferenceDate: 0),
    statusChangedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

// MARK: - Recorders

private actor QueryRecorder {
  private(set) var calls: [ListOrdersQuery] = []

  func record(_ query: ListOrdersQuery) {
    calls.append(query)
  }

  func snapshot() -> [ListOrdersQuery] { calls }
}
