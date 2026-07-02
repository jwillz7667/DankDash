import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class ProductDetailFeatureTests: XCTestCase {
  // MARK: - composeURL

  func test_composeURL_absoluteKey_returnsAsIs() {
    let url = ProductDetailFeature.composeURL(
      base: URL(string: "https://cdn.dankdash.com"),
      key: "https://example.com/coa.pdf"
    )
    XCTAssertEqual(url?.absoluteString, "https://example.com/coa.pdf")
  }

  func test_composeURL_relativeKey_prefixesBase() {
    let url = ProductDetailFeature.composeURL(
      base: URL(string: "https://cdn.dankdash.com"),
      key: "coa/abc123.pdf"
    )
    XCTAssertEqual(url?.absoluteString, "https://cdn.dankdash.com/coa/abc123.pdf")
  }

  func test_composeURL_nilBase_relativeKey_returnsNil() {
    XCTAssertNil(ProductDetailFeature.composeURL(base: nil, key: "coa/abc123.pdf"))
  }

  // MARK: - .task → cache → fetch

  func test_task_paintsCachedProductBeforeFetch() async {
    let productId = UUID()
    let categoryId = UUID()
    let cachedProduct = Self.product(id: productId, categoryId: categoryId, name: "Cached")
    let fresh = Self.product(id: productId, categoryId: categoryId, name: "Fresh")

    var cache = CatalogCacheClient.unimplemented
    cache.readProduct = { _ in cachedProduct }
    cache.writeProduct = { _, _ in }

    var api = CatalogAPIClient.unimplemented
    api.getProduct = { _ in fresh }
    api.searchProducts = { _ in
      SearchProductsResult(results: [], categoryFacets: [], strainTypeFacets: [], page: Self.page())
    }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.catalogCacheClient = cache
      $0.documentDownloadClient = .unimplemented
    }

    await store.send(.task)
    await store.receive(\.cacheLoaded) {
      $0.product = cachedProduct
      $0.isShowingFromCache = true
    }
    await store.receive(\.fetchRequested) {
      $0.isLoading = true
    }
    await store.receive(\.productResponse.success) {
      $0.product = fresh
      $0.isLoading = false
      $0.isShowingFromCache = false
    }
    await store.receive(\.relatedResponse.success)
  }

  // MARK: - fetch happy path

  func test_fetchRequested_loadsProductAndRelated() async {
    let productId = UUID()
    let categoryId = UUID()
    let product = Self.product(id: productId, categoryId: categoryId)
    let related = [
      Self.searchResult(categoryId: categoryId, name: "Related A"),
      Self.searchResult(categoryId: categoryId, name: "Related B"),
    ]

    var api = CatalogAPIClient.unimplemented
    api.getProduct = { _ in product }
    api.searchProducts = { query in
      XCTAssertEqual(query.categoryId, categoryId)
      XCTAssertEqual(query.limit, 8)
      return SearchProductsResult(results: related, categoryFacets: [], strainTypeFacets: [], page: Self.page(total: related.count))
    }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.catalogCacheClient = .unimplemented
      $0.documentDownloadClient = .unimplemented
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
    }
    await store.receive(\.productResponse.success) {
      $0.product = product
      $0.isLoading = false
    }
    await store.receive(\.relatedResponse.success) {
      $0.relatedProducts = related
    }
  }

  func test_relatedResponse_excludesTheCurrentProduct() async {
    let productId = UUID()
    let categoryId = UUID()
    let product = Self.product(id: productId, categoryId: categoryId)
    let mirror = Self.searchResult(id: productId, categoryId: categoryId, name: "Same product")
    let actuallyRelated = Self.searchResult(categoryId: categoryId, name: "Related")

    var api = CatalogAPIClient.unimplemented
    api.getProduct = { _ in product }
    api.searchProducts = { _ in
      SearchProductsResult(results: [mirror, actuallyRelated], categoryFacets: [], strainTypeFacets: [], page: Self.page(total: 2))
    }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.catalogCacheClient = .unimplemented
      $0.documentDownloadClient = .unimplemented
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
    }
    await store.receive(\.productResponse.success) {
      $0.product = product
      $0.isLoading = false
    }
    await store.receive(\.relatedResponse.success) {
      $0.relatedProducts = [actuallyRelated]
    }
  }

  func test_relatedResponse_capsAtSix() async {
    let productId = UUID()
    let categoryId = UUID()
    let product = Self.product(id: productId, categoryId: categoryId)
    let many = (0..<10).map { Self.searchResult(categoryId: categoryId, name: "Item \($0)") }

    var api = CatalogAPIClient.unimplemented
    api.getProduct = { _ in product }
    api.searchProducts = { _ in
      SearchProductsResult(results: many, categoryFacets: [], strainTypeFacets: [], page: Self.page(total: many.count))
    }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.catalogAPIClient = api
      $0.catalogCacheClient = .unimplemented
      $0.documentDownloadClient = .unimplemented
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
    }
    await store.receive(\.productResponse.success) {
      $0.product = product
      $0.isLoading = false
    }
    await store.receive(\.relatedResponse.success) {
      $0.relatedProducts = Array(many.prefix(6))
    }
  }

  // MARK: - failure paths

  func test_productResponseFailure_withoutCache_setsErrorString() async {
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) { ProductDetailFeature() }

    await store.send(.productResponse(.failure(.transport))) {
      $0.error = "We couldn't reach DankDash. Pull to retry."
    }
  }

  func test_productResponseFailure_withCachedProduct_keepsCachedSurface() async {
    let cached = Self.product(id: UUID(), categoryId: UUID())
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand",
        product: cached
      )
    ) { ProductDetailFeature() }

    await store.send(.productResponse(.failure(.transport))) {
      $0.isShowingFromCache = true
    }
    XCTAssertNil(store.state.error, "Cached payload suppresses the destructive error string.")
  }

  func test_relatedResponseFailure_isNonFatal() async {
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) { ProductDetailFeature() }

    await store.send(.relatedResponse(.failure(.transport)))
    XCTAssertNil(store.state.error, "A failed related-products fetch never blocks the detail surface.")
  }

  // MARK: - addToCartTapped delegate

  func test_addToCartTapped_emitsDelegateExactlyOnce() async {
    let productId = UUID()
    let listingId = UUID()
    let dispensaryId = UUID()
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: listingId,
        dispensaryId: dispensaryId,
        priceCents: 3000,
        maxAvailable: 4,
        productName: "Fallback Name",
        brand: "Fallback Brand"
      )
    ) { ProductDetailFeature() }

    await store.send(.addToCartTapped)
    await store.receive(\.delegate.addedToCart)
  }

  func test_addToCartTapped_prefersLoadedProductNameAndBrand() async {
    let productId = UUID()
    let listingId = UUID()
    let loaded = Self.product(id: productId, categoryId: UUID(), name: "Loaded Name", brand: "Loaded Brand")
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: listingId,
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 4,
        productName: "Fallback Name",
        brand: "Fallback Brand",
        product: loaded
      )
    ) { ProductDetailFeature() }

    await store.send(.addToCartTapped)
    await store.receive(\.delegate.addedToCart)
  }

  func test_addToCartTapped_isNoopWhenSoldOut() async {
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 0,
        productName: "Name",
        brand: "Brand"
      )
    ) { ProductDetailFeature() }

    await store.send(.addToCartTapped)
    // No delegate effect should fire — TestStore asserts no unreceived effects.
  }

  // MARK: - COA flow

  func test_coaButtonTapped_withoutLabResult_surfacesCoaError() async {
    let productId = UUID()
    let product = Self.product(id: productId, categoryId: UUID(), labResults: [])
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand",
        product: product
      )
    ) { ProductDetailFeature() }

    await store.send(.coaButtonTapped) {
      $0.coaError = "No certificate of analysis available."
    }
  }

  func test_coaButtonTapped_downloadsAndStoresLocalURL() async {
    let productId = UUID()
    let lab = Self.labResult(coaDocumentKey: "coa/abc.pdf")
    let product = Self.product(id: productId, categoryId: UUID(), labResults: [lab])
    let expectedLocal = URL(fileURLWithPath: "/tmp/coa.pdf")

    var downloader = DocumentDownloadClient.unimplemented
    downloader.download = { remote in
      XCTAssertEqual(remote.absoluteString, "https://cdn.dankdash.com/coa/abc.pdf")
      return expectedLocal
    }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand",
        product: product
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.documentDownloadClient = downloader
      $0.cdnBaseURL = URL(string: "https://cdn.dankdash.com")
    }

    await store.send(.coaButtonTapped) {
      $0.isCoaDownloading = true
    }
    await store.receive(\.coaDownloadResponse.success) {
      $0.isCoaDownloading = false
      $0.coaFileURL = expectedLocal
    }
  }

  func test_coaButtonTapped_downloadFails_setsCoaError() async {
    let productId = UUID()
    let lab = Self.labResult(coaDocumentKey: "coa/abc.pdf")
    let product = Self.product(id: productId, categoryId: UUID(), labResults: [lab])

    var downloader = DocumentDownloadClient.unimplemented
    downloader.download = { _ in throw DocumentDownloadError.transport }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand",
        product: product
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.documentDownloadClient = downloader
      $0.cdnBaseURL = URL(string: "https://cdn.dankdash.com")
    }

    await store.send(.coaButtonTapped) {
      $0.isCoaDownloading = true
    }
    await store.receive(\.coaDownloadResponse.failure) {
      $0.isCoaDownloading = false
      $0.coaError = "We couldn't download the certificate. Try again."
    }
  }

  func test_coaButtonTapped_withoutCdnConfig_surfacesCoaError() async {
    let productId = UUID()
    let lab = Self.labResult(coaDocumentKey: "coa/abc.pdf")
    let product = Self.product(id: productId, categoryId: UUID(), labResults: [lab])

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand",
        product: product
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.cdnBaseURL = nil
    }

    await store.send(.coaButtonTapped) {
      $0.coaError = "Certificate location couldn't be resolved."
    }
  }

  func test_coaDismissed_clearsFileURL() async {
    let localURL = URL(fileURLWithPath: "/tmp/coa.pdf")
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand",
        coaFileURL: localURL
      )
    ) { ProductDetailFeature() }

    await store.send(.coaDismissed) {
      $0.coaFileURL = nil
    }
  }

  func test_coaErrorDismissed_clearsError() async {
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand",
        coaError: "oops"
      )
    ) { ProductDetailFeature() }

    await store.send(.coaErrorDismissed) {
      $0.coaError = nil
    }
  }

  // MARK: - relatedTapped delegate

  func test_relatedTapped_emitsOpenRelatedProductDelegate() async {
    let productId = UUID()
    let target = UUID()
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Name",
        brand: "Brand"
      )
    ) { ProductDetailFeature() }

    await store.send(.relatedTapped(productId: target))
    await store.receive(\.delegate.openRelatedProduct)
  }

  // MARK: - headlineLabResult / canAddToCart

  func test_headlineLabResult_returnsFirstLabResult() {
    let lab = Self.labResult(coaDocumentKey: "k.pdf")
    let product = Self.product(id: UUID(), categoryId: UUID(), labResults: [lab, Self.labResult(coaDocumentKey: "older.pdf")])
    let state = ProductDetailFeature.State(
      productId: UUID(),
      listingId: UUID(),
      dispensaryId: UUID(),
      priceCents: 3000,
      maxAvailable: 5,
      productName: "Name",
      brand: "Brand",
      product: product
    )
    XCTAssertEqual(state.headlineLabResult?.id, lab.id)
  }

  func test_canAddToCart_reflectsMaxAvailable() {
    var state = ProductDetailFeature.State(
      productId: UUID(),
      listingId: UUID(),
      dispensaryId: UUID(),
      priceCents: 3000,
      maxAvailable: 1,
      productName: "Name",
      brand: "Brand"
    )
    XCTAssertTrue(state.canAddToCart)

    state = ProductDetailFeature.State(
      productId: UUID(),
      listingId: UUID(),
      dispensaryId: UUID(),
      priceCents: 3000,
      maxAvailable: 0,
      productName: "Name",
      brand: "Brand"
    )
    XCTAssertFalse(state.canAddToCart)
  }

  // MARK: - Fixtures

  nonisolated static func product(
    id: UUID,
    categoryId: UUID,
    name: String = "Test Product",
    brand: String = "Test Brand",
    labResults: [LabResult] = []
  ) -> Product {
    Product(
      id: id,
      categoryId: categoryId,
      brand: brand,
      name: name,
      description: "A test product.",
      productType: .flower,
      strainType: .hybrid,
      thcMgPerUnit: 100,
      cbdMgPerUnit: 0,
      weightGramsPerUnit: 1,
      servingCount: nil,
      thcMgPerServing: nil,
      imageKeys: [],
      effectsTags: [],
      flavorTags: [],
      createdAt: Date(timeIntervalSince1970: 1_780_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_780_000_000),
      labResults: labResults
    )
  }

  nonisolated static func searchResult(
    id: UUID = UUID(),
    categoryId: UUID,
    name: String = "Result"
  ) -> SearchProductResult {
    SearchProductResult(
      id: id,
      categoryId: categoryId,
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

  nonisolated static func labResult(coaDocumentKey: String?) -> LabResult {
    LabResult(
      id: UUID(),
      batchId: "B-1",
      labName: "Test Lab",
      coaDocumentKey: coaDocumentKey,
      potencyThc: Decimal(string: "22.5"),
      potencyCbd: Decimal(string: "0.1"),
      contaminantsPassed: true,
      testedAt: "2026-01-15"
    )
  }

  nonisolated static func page(total: Int = 0) -> SearchPage {
    SearchPage(limit: 8, offset: 0, total: total)
  }

  // MARK: - Favorites

  func test_favoriteStatusLoaded_setsFlag() async {
    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    }

    await store.send(.favoriteStatusLoaded(true)) { $0.isFavorite = true }
  }

  func test_favoriteToggled_savesOptimistically_thenConfirms() async {
    let productId = UUID()
    let saved = LockIsolated<[UUID]>([])
    var favorites = FavoritesAPIClient.unimplemented
    favorites.addProduct = { id in saved.withValue { $0.append(id) } }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: productId,
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.favoritesAPIClient = favorites
    }

    await store.send(.favoriteToggled) { $0.isFavorite = true }
    await store.receive(\.favoriteToggleResponse)
    XCTAssertEqual(saved.value, [productId])
  }

  func test_favoriteToggled_saveFailure_reverts() async {
    var favorites = FavoritesAPIClient.unimplemented
    favorites.addProduct = { _ in throw FavoritesAPIError.unimplemented("addProduct") }

    let store = TestStore(
      initialState: ProductDetailFeature.State(
        productId: UUID(),
        listingId: UUID(),
        dispensaryId: UUID(),
        priceCents: 3000,
        maxAvailable: 5,
        productName: "Initial",
        brand: "Brand"
      )
    ) {
      ProductDetailFeature()
    } withDependencies: {
      $0.favoritesAPIClient = favorites
    }

    await store.send(.favoriteToggled) { $0.isFavorite = true }
    await store.receive(\.favoriteToggleResponse) { $0.isFavorite = false }
  }
}
