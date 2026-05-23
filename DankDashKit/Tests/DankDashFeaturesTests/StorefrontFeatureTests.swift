import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class StorefrontFeatureTests: XCTestCase {
  // MARK: - .task and cache

  func test_task_paintsCachedMenuBeforeFetch() async {
    let dispensaryId = UUID()
    let cachedItems = [Self.menuItem(name: "Cached")]
    var cacheClient = CatalogCacheClient.unimplemented
    cacheClient.readMenu = { _ in
      .init(dispensaryId: dispensaryId, items: cachedItems)
    }
    var api = CatalogAPIClient.unimplemented
    api.getDispensary = { _ in throw CatalogAPIError.unimplemented("network down") }
    api.getMenu = { _ in throw CatalogAPIError.unimplemented("network down") }
    api.listCategories = { throw CatalogAPIError.unimplemented("network down") }

    let store = TestStore(
      initialState: StorefrontFeature.State(dispensaryId: dispensaryId)
    ) {
      StorefrontFeature()
    } withDependencies: {
      $0.catalogCacheClient = cacheClient
      $0.catalogAPIClient = api
    }

    await store.send(.task)
    await store.receive(\.cacheLoaded) {
      $0.menuItems = cachedItems
      $0.isShowingFromCache = true
    }
    await store.receive(\.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.dispensaryResponse.failure) {
      $0.isLoading = false
      $0.error = "Something went wrong loading this dispensary."
    }
    // Cached menu items already populated → menuResponse.failure goes
    // through the "keep data" branch; isShowingFromCache was already true
    // from cacheLoaded, so the receive carries no observable state change.
    await store.receive(\.menuResponse.failure)
    await store.receive(\.categoriesResponse.failure)
  }

  // MARK: - fetch happy path

  func test_fetchRequested_overridesCachedData() async {
    let dispensaryId = UUID()
    let dispensary = Self.dispensary(id: dispensaryId)
    let item = Self.menuItem(name: "Fresh")
    let categories = [Self.category(displayOrder: 0)]
    var api = CatalogAPIClient.unimplemented
    api.getDispensary = { _ in dispensary }
    api.getMenu = { _ in (dispensaryId, [item]) }
    api.listCategories = { categories }

    let store = TestStore(
      initialState: StorefrontFeature.State(dispensaryId: dispensaryId, isShowingFromCache: true)
    ) {
      StorefrontFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.dispensaryResponse.success) {
      $0.isLoading = false
      $0.dispensary = dispensary
      $0.isShowingFromCache = false
    }
    await store.receive(\.menuResponse.success) {
      $0.menuItems = [item]
    }
    await store.receive(\.categoriesResponse.success) {
      $0.categories = categories
    }
  }

  func test_fetchRequested_skipsCategoriesIfCached() async {
    let dispensaryId = UUID()
    let existing = [Self.category(displayOrder: 0)]
    var api = CatalogAPIClient.unimplemented
    api.getDispensary = { _ in Self.dispensary(id: dispensaryId) }
    api.getMenu = { _ in (dispensaryId, []) }
    api.listCategories = {
      XCTFail("Categories should not be re-fetched when already loaded")
      return []
    }

    let store = TestStore(
      initialState: StorefrontFeature.State(dispensaryId: dispensaryId, categories: existing)
    ) {
      StorefrontFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.dispensaryResponse.success) {
      $0.isLoading = false
      $0.dispensary = Self.dispensary(id: dispensaryId)
    }
    await store.receive(\.menuResponse.success)
  }

  // MARK: - category & filter

  func test_categorySelected_setsActiveCategory() async {
    let id = UUID()
    let store = TestStore(initialState: StorefrontFeature.State(dispensaryId: UUID())) {
      StorefrontFeature()
    }
    await store.send(.categorySelected(id)) {
      $0.selectedCategoryId = id
    }
    await store.send(.categorySelected(nil)) {
      $0.selectedCategoryId = nil
    }
  }

  func test_filterChanged_updatesFilter() async {
    let filter = MenuFilter(strainTypes: [.indica])
    let store = TestStore(initialState: StorefrontFeature.State(dispensaryId: UUID())) {
      StorefrontFeature()
    }
    await store.send(.filterChanged(filter)) {
      $0.filter = filter
    }
  }

  func test_filterCleared_resetsToNone() async {
    let initial = MenuFilter(strainTypes: [.indica])
    let store = TestStore(
      initialState: StorefrontFeature.State(
        dispensaryId: UUID(),
        filter: initial
      )
    ) { StorefrontFeature() }

    await store.send(.filterCleared) {
      $0.filter = .none
    }
  }

  func test_filterSheet_toggle() async {
    let store = TestStore(initialState: StorefrontFeature.State(dispensaryId: UUID())) {
      StorefrontFeature()
    }
    await store.send(.filterButtonTapped) { $0.isShowingFilterSheet = true }
    await store.send(.filterDismissed) { $0.isShowingFilterSheet = false }
  }

  // MARK: - filteredItems composition

  func test_filteredItems_appliesCategoryThenFilter() {
    let flowerId = UUID()
    let edibleId = UUID()
    let flower = Self.menuItem(categoryId: flowerId, strain: .indica)
    let edible = Self.menuItem(categoryId: edibleId, strain: .sativa)
    var state = StorefrontFeature.State(
      dispensaryId: UUID(),
      menuItems: [flower, edible],
      selectedCategoryId: flowerId,
      filter: MenuFilter(strainTypes: [.indica])
    )
    XCTAssertEqual(state.filteredItems.count, 1)

    state.selectedCategoryId = edibleId
    XCTAssertTrue(state.filteredItems.isEmpty, "Indica filter excludes the sativa edible.")
  }

  func test_visibleCategories_filtersToMenuCategoriesAndSorts() {
    let flowerId = UUID()
    let edibleId = UUID()
    let drinkId = UUID()
    let flower = Self.category(id: flowerId, name: "Flower", displayOrder: 0)
    let edible = Self.category(id: edibleId, name: "Edible", displayOrder: 1)
    let drink = Self.category(id: drinkId, name: "Drink", displayOrder: 2)

    let item1 = Self.menuItem(categoryId: edibleId)
    let item2 = Self.menuItem(categoryId: drinkId)

    let state = StorefrontFeature.State(
      dispensaryId: UUID(),
      menuItems: [item1, item2],
      categories: [drink, flower, edible] // unsorted
    )

    XCTAssertEqual(state.visibleCategories.map(\.displayName), ["Edible", "Drink"])
  }

  // MARK: - delegate

  func test_productTapped_emitsDelegate() async {
    let productId = UUID()
    let listingId = UUID()
    let store = TestStore(initialState: StorefrontFeature.State(dispensaryId: UUID())) {
      StorefrontFeature()
    }
    await store.send(.productTapped(productId: productId, listingId: listingId))
    await store.receive(\.delegate.openProduct)
  }

  // MARK: - failure surface

  func test_menuResponseFailure_withCachedData_keepsItemsShowsOfflineBanner() async {
    let cached = [Self.menuItem()]
    let store = TestStore(
      initialState: StorefrontFeature.State(
        dispensaryId: UUID(),
        menuItems: cached,
        isShowingFromCache: false
      )
    ) { StorefrontFeature() }

    await store.send(.menuResponse(.failure(.transport))) {
      $0.isShowingFromCache = true
    }
    XCTAssertEqual(store.state.menuItems, cached)
    XCTAssertNil(store.state.error, "Existing data suppresses the destructive error string.")
  }

  func test_menuResponseFailure_withoutCachedData_setsError() async {
    let store = TestStore(initialState: StorefrontFeature.State(dispensaryId: UUID())) {
      StorefrontFeature()
    }
    await store.send(.menuResponse(.failure(.transport))) {
      $0.error = "We couldn't reach DankDash. Pull to retry."
    }
  }

  // MARK: - Fixtures

  nonisolated static func dispensary(id: UUID) -> Dispensary {
    Dispensary(
      id: id, legalName: "Test Dispensary", dba: nil, licenseNumber: "MN-1",
      licenseType: .retailer, addressLine1: "1 Main", addressLine2: nil,
      city: "Minneapolis", region: "MN", postalCode: "55401",
      location: Coordinate(latitude: 44.97, longitude: -93.26),
      deliveryPolygon: GeoPolygon(rings: []),
      hours: DispensaryHours(mon: nil, tue: nil, wed: nil, thu: nil, fri: nil, sat: nil, sun: nil),
      phone: nil, email: nil, logoImageKey: nil, heroImageKey: nil, brandColorHex: nil,
      isAcceptingOrders: true, isOpenNow: true, opensAt: nil,
      ratingAvg: Decimal(string: "4.7"), ratingCount: 12, status: .active,
      createdAt: Date(timeIntervalSince1970: 1_780_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_780_000_000)
    )
  }

  nonisolated static func menuItem(
    name: String = "Test Product",
    categoryId: UUID = UUID(),
    strain: StrainType? = .hybrid
  ) -> MenuItem {
    MenuItem(
      listingId: UUID(),
      sku: "SKU-1",
      priceCents: 3000,
      compareAtPriceCents: nil,
      quantityAvailable: 10,
      product: MenuProductSummary(
        id: UUID(),
        categoryId: categoryId,
        brand: "Brand",
        name: name,
        description: nil,
        productType: .flower,
        strainType: strain,
        thcMgPerUnit: 100,
        cbdMgPerUnit: 0,
        weightGramsPerUnit: 1,
        servingCount: nil,
        thcMgPerServing: nil,
        imageKeys: [],
        effectsTags: [],
        flavorTags: []
      )
    )
  }

  nonisolated static func category(
    id: UUID = UUID(),
    name: String = "Cat",
    displayOrder: Int
  ) -> DankDashDomain.Category {
    DankDashDomain.Category(
      id: id,
      slug: name.lowercased(),
      displayName: name,
      parentId: nil,
      displayOrder: displayOrder,
      iconKey: nil
    )
  }
}
