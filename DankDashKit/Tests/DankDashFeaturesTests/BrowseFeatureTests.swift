import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class BrowseFeatureTests: XCTestCase {
  // MARK: - tabs

  func test_tabSelected_updatesSelectedTab() async {
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.tabSelected(.search)) {
      $0.selectedTab = .search
    }
    await store.send(.tabSelected(.cart)) {
      $0.selectedTab = .cart
    }
  }

  // MARK: - feed → storefront

  func test_feedDelegateOpenDispensary_pushesStorefront() async {
    let dispensaryId = UUID()
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.feed(.delegate(.openDispensary(id: dispensaryId))))
    XCTAssertEqual(store.state.storefront?.dispensaryId, dispensaryId)
  }

  func test_storefrontDismissed_clearsStorefrontAndProductDetail() async {
    let dispensaryId = UUID()
    let productId = UUID()
    let listingId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        storefront: StorefrontFeature.State(dispensaryId: dispensaryId),
        productDetail: ProductDetailFeature.State(
          productId: productId,
          listingId: listingId,
          dispensaryId: dispensaryId,
          priceCents: 3000,
          maxAvailable: 5,
          productName: "x",
          brand: "y"
        )
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.storefrontDismissed) {
      $0.storefront = nil
      $0.productDetail = nil
    }
  }

  // MARK: - storefront → product detail

  func test_storefrontDelegateOpenProduct_pushesProductDetailFromMenuItem() async {
    let dispensaryId = UUID()
    let listingId = UUID()
    let productId = UUID()
    let menuItem = MenuItem(
      listingId: listingId,
      sku: "SKU-1",
      priceCents: 4500,
      compareAtPriceCents: nil,
      quantityAvailable: 7,
      product: MenuProductSummary(
        id: productId,
        categoryId: UUID(),
        brand: "Test Brand",
        name: "Test Product",
        description: nil,
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
    )
    let store = TestStore(
      initialState: BrowseFeature.State(
        storefront: StorefrontFeature.State(
          dispensaryId: dispensaryId,
          menuItems: [menuItem]
        )
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.storefront(.delegate(.openProduct(productId: productId, listingId: listingId))))
    let detail = store.state.productDetail
    XCTAssertEqual(detail?.productId, productId)
    XCTAssertEqual(detail?.listingId, listingId)
    XCTAssertEqual(detail?.dispensaryId, dispensaryId)
    XCTAssertEqual(detail?.priceCents, 4500)
    XCTAssertEqual(detail?.maxAvailable, 7)
    XCTAssertEqual(detail?.productName, "Test Product")
    XCTAssertEqual(detail?.brand, "Test Brand")
  }

  func test_storefrontDelegateOpenProduct_noMatchingListing_isNoop() async {
    let dispensaryId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        storefront: StorefrontFeature.State(dispensaryId: dispensaryId)
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.storefront(.delegate(.openProduct(productId: UUID(), listingId: UUID()))))
    XCTAssertNil(store.state.productDetail)
  }

  // MARK: - search → product detail (no listing pin)

  func test_searchDelegateOpenProduct_pushesDetailWithDisabledCart() async {
    let productId = UUID()
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.search(.delegate(.openProduct(productId: productId))))
    XCTAssertEqual(store.state.productDetail?.productId, productId)
    XCTAssertEqual(store.state.productDetail?.maxAvailable, 0, "Search drill-down has no listing pin → cart disabled.")
    XCTAssertFalse(store.state.productDetail?.canAddToCart ?? true)
  }

  // MARK: - product detail → cart

  func test_productDetailAddedToCart_appendsLineAndShowsToast() async {
    let productId = UUID()
    let listingId = UUID()
    let dispensaryId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        productDetail: ProductDetailFeature.State(
          productId: productId,
          listingId: listingId,
          dispensaryId: dispensaryId,
          priceCents: 3500,
          maxAvailable: 5,
          productName: "Sour Diesel",
          brand: "Brand"
        )
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.productDetail(.delegate(.addedToCart(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel",
      brand: "Brand",
      priceCents: 3500,
      maxAvailable: 5
    ))))
    XCTAssertEqual(store.state.addedToCartToast, "Sour Diesel added to cart")
    XCTAssertEqual(store.state.cart.lines.count, 1)
    XCTAssertEqual(store.state.cart.lines.first?.listingId, listingId)
    XCTAssertEqual(store.state.cart.lines.first?.priceCents, 3500)
    XCTAssertEqual(store.state.cart.lines.first?.quantity, 1)
  }

  func test_toastDismissed_clearsToast() async {
    let store = TestStore(
      initialState: BrowseFeature.State(addedToCartToast: "Item added")
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.toastDismissed)
    XCTAssertNil(store.state.addedToCartToast)
  }

  func test_productDetailDismissed_clearsProductDetail() async {
    let dispensaryId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        storefront: StorefrontFeature.State(dispensaryId: dispensaryId),
        productDetail: ProductDetailFeature.State(
          productId: UUID(),
          listingId: UUID(),
          dispensaryId: dispensaryId,
          priceCents: 3000,
          maxAvailable: 5,
          productName: "x",
          brand: "y"
        )
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.productDetailDismissed)
    XCTAssertNil(store.state.productDetail)
    XCTAssertNotNil(store.state.storefront, "Dismissing the product detail keeps the storefront under it.")
  }

  // MARK: - related product navigation

  func test_productDetailOpenRelatedProduct_swapsDetailWithDisabledCart() async {
    let originalProductId = UUID()
    let listingId = UUID()
    let dispensaryId = UUID()
    let relatedId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        productDetail: ProductDetailFeature.State(
          productId: originalProductId,
          listingId: listingId,
          dispensaryId: dispensaryId,
          priceCents: 3000,
          maxAvailable: 5,
          productName: "Original",
          brand: "Brand"
        )
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.productDetail(.delegate(.openRelatedProduct(productId: relatedId))))
    XCTAssertEqual(store.state.productDetail?.productId, relatedId)
    XCTAssertEqual(store.state.productDetail?.maxAvailable, 0, "Related products drilled into from a non-storefront detail have no listing pin.")
  }
}
