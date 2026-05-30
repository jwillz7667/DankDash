import XCTest
import Foundation
import ComposableArchitecture
import Clocks
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class SearchFeatureTests: XCTestCase {
  // MARK: - debounce

  func test_queryChanged_belowMinimumLength_doesNotFetch() async {
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { _ in
      XCTFail("Should not search below minimum query length")
      return Self.emptyResult
    }

    let store = TestStore(initialState: SearchFeature.State()) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.queryChanged("a")) {
      $0.query = "a"
    }
    await store.send(.queryChanged("ab")) {
      $0.query = "ab"
    }
    // No queryDebounceFired should arrive — the reducer never scheduled it.
  }

  func test_queryChanged_threeKeystrokes_collapsesToOneFetch() async {
    let clock = TestClock()
    let expected = Self.makeResult(results: [Self.searchResult(name: "blue")])
    var api = CatalogAPIClient.unimplemented
    let callCount = LockIsolated(0)
    api.searchProducts = { query in
      callCount.withValue { $0 += 1 }
      XCTAssertEqual(query.q, "blu")
      return expected
    }

    let store = TestStore(initialState: SearchFeature.State()) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = clock
    }

    await store.send(.queryChanged("b")) { $0.query = "b" }
    await store.send(.queryChanged("bl")) { $0.query = "bl" }
    await store.send(.queryChanged("blu")) { $0.query = "blu" }
    await clock.advance(by: .milliseconds(SearchFeature.debounceMs))
    await store.receive(\.queryDebounceFired) {
      $0.isLoading = true
    }
    await store.receive(\.searchResponse.success) {
      $0.isLoading = false
      $0.results = expected.results
      $0.categoryFacets = expected.categoryFacets
      $0.strainTypeFacets = expected.strainTypeFacets
      $0.page = expected.page
    }
    XCTAssertEqual(callCount.value, 1, "Only the final keystroke should produce a search.")
  }

  func test_queryChanged_belowMinimumAfterValid_clearsResults() async {
    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: [Self.searchResult(name: "result")],
        categoryFacets: [SearchCategoryFacet(categoryId: UUID(), count: 1)],
        strainTypeFacets: [SearchStrainTypeFacet(strainType: .indica, count: 1)],
        page: SearchPage(limit: 24, offset: 0, total: 1),
        error: "old error"
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.queryChanged("b")) {
      $0.query = "b"
      $0.results = []
      $0.categoryFacets = []
      $0.strainTypeFacets = []
      $0.page = SearchPage(limit: 24, offset: 0, total: 0)
      $0.error = nil
    }
  }

  func test_clearQueryTapped_resetsToEmpty() async {
    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: [Self.searchResult()],
        page: SearchPage(limit: 24, offset: 0, total: 1)
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.clearQueryTapped) {
      $0.query = ""
      $0.results = []
      $0.page = SearchPage(limit: 24, offset: 0, total: 0)
    }
  }

  // MARK: - facets

  func test_categoryFacetTapped_withActiveQuery_refetches() async {
    let categoryId = UUID()
    let response = Self.makeResult(results: [Self.searchResult(name: "category-narrowed")])
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { query in
      XCTAssertEqual(query.categoryId, categoryId)
      XCTAssertEqual(query.offset, 0)
      return response
    }

    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: [Self.searchResult(name: "previous")],
        page: SearchPage(limit: 24, offset: 0, total: 1)
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.categoryFacetTapped(categoryId)) {
      $0.selectedCategoryId = categoryId
      $0.isLoading = true
    }
    await store.receive(\.searchResponse.success) {
      $0.isLoading = false
      $0.results = response.results
      $0.categoryFacets = response.categoryFacets
      $0.strainTypeFacets = response.strainTypeFacets
      $0.page = response.page
    }
  }

  func test_strainFacetTapped_withoutActiveQuery_isNoop() async {
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { _ in
      XCTFail("Facet selection should not search when query is empty")
      return Self.emptyResult
    }

    let store = TestStore(initialState: SearchFeature.State()) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.strainFacetTapped(.indica)) {
      $0.selectedStrainType = .indica
    }
  }

  func test_clearFacetsTapped_withActiveQuery_refetches() async {
    let response = Self.makeResult(results: [Self.searchResult()])
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { query in
      XCTAssertNil(query.categoryId)
      XCTAssertNil(query.strainType)
      return response
    }

    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        selectedCategoryId: UUID(),
        selectedStrainType: .indica
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.clearFacetsTapped) {
      $0.selectedCategoryId = nil
      $0.selectedStrainType = nil
      $0.isLoading = true
    }
    await store.receive(\.searchResponse.success) {
      $0.isLoading = false
      $0.results = response.results
      $0.categoryFacets = response.categoryFacets
      $0.strainTypeFacets = response.strainTypeFacets
      $0.page = response.page
    }
  }

  func test_clearFacetsTapped_withoutActiveQuery_isNoop() async {
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { _ in
      XCTFail("Should not search when query is empty")
      return Self.emptyResult
    }

    let store = TestStore(
      initialState: SearchFeature.State(selectedCategoryId: UUID())
    ) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.clearFacetsTapped) {
      $0.selectedCategoryId = nil
    }
  }

  // MARK: - pagination

  func test_paginate_appendsResultsAndAdvancesOffset() async {
    let first = Self.makeResult(
      results: [Self.searchResult(id: UUID(), name: "A")],
      page: SearchPage(limit: 1, offset: 0, total: 2)
    )
    let secondResult = Self.searchResult(id: UUID(), name: "B")
    let second = Self.makeResult(
      results: [secondResult],
      page: SearchPage(limit: 1, offset: 1, total: 2)
    )
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { query in
      XCTAssertEqual(query.offset, 1, "Pagination must request the next slab.")
      return second
    }

    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: first.results,
        categoryFacets: first.categoryFacets,
        strainTypeFacets: first.strainTypeFacets,
        page: first.page
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.paginate) {
      $0.isLoadingNextPage = true
    }
    await store.receive(\.paginateResponse.success) {
      $0.isLoadingNextPage = false
      $0.results = first.results + [secondResult]
      $0.categoryFacets = second.categoryFacets
      $0.strainTypeFacets = second.strainTypeFacets
      $0.page = second.page
    }
  }

  func test_paginate_dedupesOverlappingResults() async {
    let shared = Self.searchResult(id: UUID(), name: "Shared")
    let first = Self.makeResult(
      results: [shared, Self.searchResult(id: UUID(), name: "First-only")],
      page: SearchPage(limit: 2, offset: 0, total: 3)
    )
    let secondNew = Self.searchResult(id: UUID(), name: "Second-only")
    let second = Self.makeResult(
      results: [shared, secondNew], // shared overlaps
      page: SearchPage(limit: 2, offset: 2, total: 3)
    )
    var api = CatalogAPIClient.unimplemented
    api.searchProducts = { _ in second }

    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: first.results,
        page: first.page
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.continuousClock = TestClock()
    }

    await store.send(.paginate) {
      $0.isLoadingNextPage = true
    }
    await store.receive(\.paginateResponse.success) {
      $0.isLoadingNextPage = false
      $0.results = [shared, first.results[1], secondNew]
      $0.categoryFacets = second.categoryFacets
      $0.strainTypeFacets = second.strainTypeFacets
      $0.page = second.page
    }
  }

  func test_paginate_isNoopAtEndOfPage() async {
    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: [Self.searchResult()],
        page: SearchPage(limit: 24, offset: 0, total: 1) // no next page
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.paginate)
  }

  func test_paginate_isNoopWhenAlreadyLoading() async {
    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: [Self.searchResult()],
        page: SearchPage(limit: 1, offset: 0, total: 5),
        isLoadingNextPage: true
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.paginate)
  }

  func test_paginateResponse_failure_isNonFatal() async {
    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        results: [Self.searchResult()],
        page: SearchPage(limit: 1, offset: 0, total: 2),
        isLoadingNextPage: true
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.paginateResponse(.failure(.transport))) {
      $0.isLoadingNextPage = false
    }
    XCTAssertNil(store.state.error, "Pagination failures keep the existing rows; no destructive error string.")
  }

  // MARK: - search failure

  func test_searchResponse_failure_setsUserMessage() async {
    let store = TestStore(
      initialState: SearchFeature.State(
        query: "blu",
        isLoading: true
      )
    ) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.searchResponse(.failure(.transport))) {
      $0.isLoading = false
      $0.error = "We couldn't reach DankDash. Try again."
    }
  }

  // MARK: - delegate

  func test_productTapped_emitsDelegate() async {
    let target = UUID()
    let store = TestStore(initialState: SearchFeature.State()) {
      SearchFeature()
    } withDependencies: {
      $0.continuousClock = TestClock()
    }

    await store.send(.productTapped(target))
    await store.receive(\.delegate.openProduct)
  }

  // MARK: - derived state

  func test_hasActiveQuery_reflectsMinimumLength() {
    XCTAssertFalse(SearchFeature.State(query: "ab").hasActiveQuery)
    XCTAssertTrue(SearchFeature.State(query: "abc").hasActiveQuery)
  }

  func test_canLoadNextPage_requiresResultsAndRoom() {
    var state = SearchFeature.State(
      results: [],
      page: SearchPage(limit: 1, offset: 0, total: 10)
    )
    XCTAssertFalse(state.canLoadNextPage, "Empty results means we haven't loaded a first page yet.")
    state = SearchFeature.State(
      results: [Self.searchResult()],
      page: SearchPage(limit: 1, offset: 0, total: 1)
    )
    XCTAssertFalse(state.canLoadNextPage, "Page-1 of 1 has no next slab.")
    state = SearchFeature.State(
      results: [Self.searchResult()],
      page: SearchPage(limit: 1, offset: 0, total: 5)
    )
    XCTAssertTrue(state.canLoadNextPage)
  }

  // MARK: - Fixtures

  nonisolated static let emptyResult = SearchProductsResult(
    results: [],
    categoryFacets: [],
    strainTypeFacets: [],
    page: SearchPage(limit: 24, offset: 0, total: 0)
  )

  nonisolated static func makeResult(
    results: [SearchProductResult],
    page: SearchPage? = nil
  ) -> SearchProductsResult {
    SearchProductsResult(
      results: results,
      categoryFacets: [SearchCategoryFacet(categoryId: UUID(), count: results.count)],
      strainTypeFacets: [SearchStrainTypeFacet(strainType: .hybrid, count: results.count)],
      page: page ?? SearchPage(limit: 24, offset: 0, total: results.count)
    )
  }

  nonisolated static func searchResult(
    id: UUID = UUID(),
    name: String = "Result"
  ) -> SearchProductResult {
    SearchProductResult(
      id: id,
      categoryId: UUID(),
      brand: "Brand",
      name: name,
      productType: .flower,
      strainType: .hybrid,
      thcMgPerUnit: 100,
      cbdMgPerUnit: 0,
      weightGramsPerUnit: 1,
      servingCount: nil,
      thcMgPerServing: nil,
      imageKeys: [],
      effectsTags: [],
      flavorTags: []
    )
  }
}
