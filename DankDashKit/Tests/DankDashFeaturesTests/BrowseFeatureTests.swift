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

  // MARK: - search → product detail (listing resolution)

  func test_searchDelegateOpenProduct_resolvesListingAndEnablesCart() async {
    let productId = UUID()
    let listingId = UUID()
    let dispensaryId = UUID()
    let hit = Self.makeSearchHit(id: productId, name: "Blue Dream 3.5g", brand: "Sunny Side")
    let listings = [
      Self.makeListing(
        listingId: listingId,
        dispensaryId: dispensaryId,
        dispensaryName: "The Grove",
        priceCents: 4200,
        quantityAvailable: 9
      )
    ]
    let store = TestStore(
      initialState: BrowseFeature.State(search: SearchFeature.State(results: [hit]))
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.catalogAPIClient.getProductListings = { @Sendable _ in listings }
    }
    store.exhaustivity = .off

    await store.send(.search(.delegate(.openProduct(productId: productId))))
    XCTAssertTrue(store.state.isResolvingProduct, "Spinner shows during the resolve round-trip.")

    await store.receive(\.productListingsResolved)
    XCTAssertFalse(store.state.isResolvingProduct)
    let detail = store.state.productDetail
    XCTAssertEqual(detail?.productId, productId)
    XCTAssertEqual(detail?.listingId, listingId)
    XCTAssertEqual(detail?.dispensaryId, dispensaryId)
    XCTAssertEqual(detail?.priceCents, 4200)
    XCTAssertEqual(detail?.maxAvailable, 9)
    XCTAssertEqual(detail?.productName, "Blue Dream 3.5g")
    XCTAssertEqual(detail?.brand, "Sunny Side")
    XCTAssertEqual(detail?.dispensaryName, "The Grove")
    XCTAssertTrue(detail?.canAddToCart ?? false, "A resolved listing makes add-to-cart live from search.")
  }

  func test_searchDelegateOpenProduct_prefersCartDispensaryOverCheapest() async {
    let productId = UUID()
    let cartDispensaryId = UUID()
    let cheaperListingId = UUID()
    let cartListingId = UUID()
    let hit = Self.makeSearchHit(id: productId, name: "OG Kush", brand: "Rove")
    // Cheapest is at a different store; the store the cart already belongs to
    // is pricier — the picker must still choose the cart's store so the
    // single-dispensary draft isn't cleared.
    let listings = [
      Self.makeListing(
        listingId: cheaperListingId,
        dispensaryId: UUID(),
        dispensaryName: "Capitol Cannabis",
        priceCents: 3800,
        quantityAvailable: 4
      ),
      Self.makeListing(
        listingId: cartListingId,
        dispensaryId: cartDispensaryId,
        dispensaryName: "North Loop Cannabis",
        priceCents: 4500,
        quantityAvailable: 6
      ),
    ]
    var initial = BrowseFeature.State(search: SearchFeature.State(results: [hit]))
    initial.cart.dispensaryId = cartDispensaryId
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.catalogAPIClient.getProductListings = { @Sendable _ in listings }
    }
    store.exhaustivity = .off

    await store.send(.search(.delegate(.openProduct(productId: productId))))
    await store.receive(\.productListingsResolved)

    XCTAssertEqual(store.state.productDetail?.listingId, cartListingId)
    XCTAssertEqual(store.state.productDetail?.dispensaryId, cartDispensaryId)
  }

  func test_searchDelegateOpenProduct_noInStockListing_setsUnavailableError() async {
    let productId = UUID()
    let hit = Self.makeSearchHit(id: productId, name: "Sold Out Strain", brand: "Rare")
    // A listing exists but is out of stock — not buyable.
    let listings = [
      Self.makeListing(
        listingId: UUID(),
        dispensaryId: UUID(),
        dispensaryName: "The Grove",
        priceCents: 5000,
        quantityAvailable: 0
      )
    ]
    let store = TestStore(
      initialState: BrowseFeature.State(search: SearchFeature.State(results: [hit]))
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.catalogAPIClient.getProductListings = { @Sendable _ in listings }
    }
    store.exhaustivity = .off

    await store.send(.search(.delegate(.openProduct(productId: productId))))
    await store.receive(\.productListingsResolved)

    XCTAssertNil(store.state.productDetail, "No buyable listing → no detail pushed.")
    XCTAssertEqual(store.state.productResolveError, "Sold Out Strain is unavailable right now.")
    XCTAssertFalse(store.state.isResolvingProduct)
  }

  func test_searchDelegateOpenProduct_transportFailure_setsError() async {
    let productId = UUID()
    let hit = Self.makeSearchHit(id: productId, name: "Anything", brand: "Brand")
    struct Boom: Error {}
    let store = TestStore(
      initialState: BrowseFeature.State(search: SearchFeature.State(results: [hit]))
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.catalogAPIClient.getProductListings = { @Sendable _ in throw Boom() }
    }
    store.exhaustivity = .off

    await store.send(.search(.delegate(.openProduct(productId: productId))))
    await store.receive(\.productListingsResolved)

    XCTAssertNil(store.state.productDetail)
    XCTAssertEqual(store.state.productResolveError, "We couldn't reach DankDash. Try again.")
    XCTAssertFalse(store.state.isResolvingProduct)
  }

  func test_searchDelegateOpenProduct_unknownHit_isNoop() async {
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    // No matching hit in search.results → nothing to resolve, no network call.
    await store.send(.search(.delegate(.openProduct(productId: UUID()))))
    XCTAssertNil(store.state.productDetail)
    XCTAssertFalse(store.state.isResolvingProduct)
  }

  func test_productResolveErrorDismissed_clearsError() async {
    let store = TestStore(
      initialState: BrowseFeature.State(productResolveError: "Something went wrong")
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.productResolveErrorDismissed)
    XCTAssertNil(store.state.productResolveError)
  }

  func test_searchResolvedThenAddToCart_appendsLine() async {
    let productId = UUID()
    let listingId = UUID()
    let dispensaryId = UUID()
    let hit = Self.makeSearchHit(id: productId, name: "Gelato 3.5g", brand: "Cresco")
    let listings = [
      Self.makeListing(
        listingId: listingId,
        dispensaryId: dispensaryId,
        dispensaryName: "The Grove",
        priceCents: 5500,
        quantityAvailable: 3
      )
    ]
    let store = TestStore(
      initialState: BrowseFeature.State(search: SearchFeature.State(results: [hit]))
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.catalogAPIClient.getProductListings = { @Sendable _ in listings }
    }
    store.exhaustivity = .off

    await store.send(.search(.delegate(.openProduct(productId: productId))))
    await store.receive(\.productListingsResolved)

    // Add-to-cart works end-to-end from a search-resolved detail.
    await store.send(.productDetail(.delegate(.addedToCart(
      listingId: listingId,
      productId: productId,
      productName: "Gelato 3.5g",
      brand: "Cresco",
      priceCents: 5500,
      maxAvailable: 3
    ))))
    XCTAssertEqual(store.state.cart.draft.lines.count, 1)
    XCTAssertEqual(store.state.cart.draft.lines.first?.listingId, listingId)
    XCTAssertEqual(store.state.cart.dispensaryId, dispensaryId)
    XCTAssertEqual(store.state.addedToCartToast, "Gelato 3.5g added to cart")
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
    XCTAssertEqual(store.state.cart.draft.lines.count, 1)
    XCTAssertEqual(store.state.cart.draft.lines.first?.listingId, listingId)
    XCTAssertEqual(store.state.cart.draft.lines.first?.priceCents, 3500)
    XCTAssertEqual(store.state.cart.draft.lines.first?.quantity, 1)
    XCTAssertEqual(store.state.cart.dispensaryId, dispensaryId, "First addedToCart pins the cart's dispensary so promotion can run.")
    XCTAssertEqual(
      store.state.cart.productInfo[listingId],
      ListingProductInfo(name: "Sour Diesel", brand: "Brand"),
      "productInfo snapshot is captured so the cart row can render after the draft is cleared on promotion."
    )
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

  // MARK: - dispensary switch clears draft

  func test_addedToCartFromDifferentDispensary_clearsExistingDraft() async {
    let firstDispensary = UUID()
    let secondDispensary = UUID()
    let firstListing = UUID()
    let secondListing = UUID()
    var initial = BrowseFeature.State()
    initial.cart.draft.add(
      LocalCartDraft.Line(
        listingId: firstListing,
        productId: UUID(),
        productName: "Original Strain",
        brand: "Brand A",
        priceCents: 3000,
        quantity: 1,
        maxAvailable: 5
      )
    )
    initial.cart.dispensaryId = firstDispensary
    initial.productDetail = ProductDetailFeature.State(
      productId: UUID(),
      listingId: secondListing,
      dispensaryId: secondDispensary,
      priceCents: 4000,
      maxAvailable: 3,
      productName: "New Strain",
      brand: "Brand B"
    )
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.productDetail(.delegate(.addedToCart(
      listingId: secondListing,
      productId: UUID(),
      productName: "New Strain",
      brand: "Brand B",
      priceCents: 4000,
      maxAvailable: 3
    ))))
    XCTAssertEqual(store.state.cart.draft.lines.count, 1, "Switching dispensaries clears the old draft.")
    XCTAssertEqual(store.state.cart.draft.lines.first?.listingId, secondListing)
    XCTAssertEqual(store.state.cart.dispensaryId, secondDispensary)
  }

  // MARK: - tabs: Orders

  func test_tabSelected_orders_switchesToOrdersTab() async {
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.tabSelected(.orders)) {
      $0.selectedTab = .orders
    }
  }

  // MARK: - cart → checkout hand-off

  func test_cartCheckoutRequestedDelegate_mountsCheckoutHandoff() async {
    let cartId = UUID()
    let addressId = UUID()
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.cart(.delegate(.checkoutRequested(cartId: cartId, deliveryAddressId: addressId))))
    XCTAssertEqual(store.state.checkoutHandoff?.cartId, cartId)
    XCTAssertEqual(store.state.checkoutHandoff?.deliveryAddressId, addressId)
  }

  func test_checkoutHandoffDelegateCompleted_jumpsToOrdersAndPushesDetail() async {
    let cartId = UUID()
    let addressId = UUID()
    let orderId = UUID()
    var initial = BrowseFeature.State(
      checkoutHandoff: CheckoutHandoffFeature.State(cartId: cartId, deliveryAddressId: addressId)
    )
    initial.cart.draft.add(
      LocalCartDraft.Line(
        listingId: UUID(),
        productId: UUID(),
        productName: "x",
        brand: "y",
        priceCents: 1000,
        quantity: 1,
        maxAvailable: 5
      )
    )
    initial.cart.dispensaryId = UUID()
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.checkoutHandoff(.delegate(.completed(orderId: orderId))))
    XCTAssertEqual(store.state.selectedTab, .orders)
    XCTAssertEqual(store.state.orderDetail?.orderId, orderId)
    XCTAssertNil(store.state.checkoutHandoff, "Hand-off sheet dismisses once the order is created.")
    XCTAssertTrue(store.state.cart.draft.isEmpty, "Post-checkout the local cart is consumed.")
    XCTAssertNil(store.state.cart.dispensaryId)
  }

  func test_cartTestOrderPlacedDelegate_jumpsToOrdersAndPushesDetail() async {
    let orderId = UUID()
    var initial = BrowseFeature.State()
    initial.cart.draft.add(
      LocalCartDraft.Line(
        listingId: UUID(),
        productId: UUID(),
        productName: "x",
        brand: "y",
        priceCents: 1000,
        quantity: 1,
        maxAvailable: 5
      )
    )
    initial.cart.dispensaryId = UUID()
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.cart(.delegate(.testOrderPlaced(orderId: orderId))))
    XCTAssertEqual(store.state.selectedTab, .orders)
    XCTAssertEqual(store.state.orderDetail?.orderId, orderId)
    XCTAssertTrue(store.state.cart.draft.isEmpty, "Test order consumes the local cart, same as a hand-off.")
    XCTAssertNil(store.state.cart.dispensaryId)
  }

  func test_checkoutHandoffDelegateDismissed_unmountsSheet() async {
    let initial = BrowseFeature.State(
      checkoutHandoff: CheckoutHandoffFeature.State(cartId: UUID(), deliveryAddressId: UUID())
    )
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.checkoutHandoff(.delegate(.dismissed)))
    XCTAssertNil(store.state.checkoutHandoff)
  }

  func test_checkoutHandoffDismissedAction_unmountsSheet() async {
    let initial = BrowseFeature.State(
      checkoutHandoff: CheckoutHandoffFeature.State(cartId: UUID(), deliveryAddressId: UUID())
    )
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.checkoutHandoffDismissed) {
      $0.checkoutHandoff = nil
    }
  }

  // MARK: - orders tab → detail

  func test_orderHistoryDelegateOpenOrder_pushesOrderDetail() async {
    let orderId = UUID()
    let store = TestStore(initialState: BrowseFeature.State(selectedTab: .orders)) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.orderHistory(.delegate(.openOrder(orderId: orderId))))
    XCTAssertEqual(store.state.orderDetail?.orderId, orderId)
  }

  func test_orderDetailDismissed_clearsOrderDetail() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        selectedTab: .orders,
        orderDetail: OrderDetailFeature.State(orderId: orderId)
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.orderDetailDismissed) {
      $0.orderDetail = nil
    }
  }

  // MARK: - reorder

  func test_orderDetailDelegateReorderRequested_seedsCartAndSwitchesTab() async {
    let orderId = UUID()
    let dispensaryId = UUID()
    let listingA = UUID()
    let listingB = UUID()
    let productA = UUID()

    let orderItems: [OrderItem] = [
      OrderItem(
        id: UUID(),
        listingId: listingA,
        productSnapshot: .object([
          "id": .string(productA.uuidString),
          "name": .string("Sour Diesel 1g"),
          "brand": .string("North Star")
        ]),
        quantity: 2,
        unitPriceCents: 3500,
        lineSubtotalCents: 7000,
        thcMgTotal: Decimal(string: "200")!,
        cbdMgTotal: Decimal(string: "0")!,
        weightGramsTotal: Decimal(string: "2")!,
        cannabisTaxCents: 700,
        salesTaxCents: 490,
        createdAt: Date(timeIntervalSinceReferenceDate: 0)
      ),
      OrderItem(
        id: UUID(),
        listingId: listingB,
        productSnapshot: .object([:]),
        quantity: 1,
        unitPriceCents: 4500,
        lineSubtotalCents: 4500,
        thcMgTotal: Decimal(string: "100")!,
        cbdMgTotal: Decimal(string: "0")!,
        weightGramsTotal: Decimal(string: "1")!,
        cannabisTaxCents: 450,
        salesTaxCents: 315,
        createdAt: Date(timeIntervalSinceReferenceDate: 0)
      )
    ]

    var initial = BrowseFeature.State(
      selectedTab: .orders,
      orderDetail: OrderDetailFeature.State(orderId: orderId)
    )
    initial.orderDetail?.tracking.order = Order(
      id: orderId,
      shortCode: "DD-7777",
      userId: UUID(),
      dispensaryId: dispensaryId,
      deliveryAddressId: UUID(),
      status: .delivered,
      subtotalCents: 11500,
      cannabisTaxCents: 1150,
      salesTaxCents: 805,
      deliveryFeeCents: 599,
      driverTipCents: 0,
      discountCents: 0,
      totalCents: 14054,
      items: orderItems,
      placedAt: Date(timeIntervalSinceReferenceDate: 0),
      statusChangedAt: Date(timeIntervalSinceReferenceDate: 0),
      createdAt: Date(timeIntervalSinceReferenceDate: 0),
      updatedAt: Date(timeIntervalSinceReferenceDate: 0)
    )
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.orderDetail(.delegate(.reorderRequested(orderId: orderId))))
    XCTAssertEqual(store.state.selectedTab, .cart)
    XCTAssertNil(store.state.orderDetail, "Reorder tears down the detail sheet.")
    XCTAssertEqual(store.state.cart.draft.lines.count, 2)
    XCTAssertEqual(store.state.cart.dispensaryId, dispensaryId)

    let lineA = store.state.cart.draft.lines.first { $0.listingId == listingA }
    XCTAssertEqual(lineA?.productName, "Sour Diesel 1g")
    XCTAssertEqual(lineA?.brand, "North Star")
    XCTAssertEqual(lineA?.priceCents, 3500)
    XCTAssertEqual(lineA?.quantity, 2)

    let lineB = store.state.cart.draft.lines.first { $0.listingId == listingB }
    XCTAssertEqual(lineB?.productName, "Reorder item", "Missing snapshot fields fall back to placeholder copy.")

    XCTAssertEqual(
      store.state.cart.productInfo[listingA],
      ListingProductInfo(name: "Sour Diesel 1g", brand: "North Star"),
      "Reorder seeds the cart's productInfo from each order item's productSnapshot."
    )
    XCTAssertEqual(
      store.state.cart.productInfo[listingB]?.name,
      "Reorder item",
      "Empty snapshot falls back to placeholder copy in productInfo too."
    )
  }

  func test_orderDetailDelegateReorderRequestedWithoutOrder_isNoop() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: BrowseFeature.State(
        selectedTab: .orders,
        orderDetail: OrderDetailFeature.State(orderId: orderId)
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.orderDetail(.delegate(.reorderRequested(orderId: orderId))))
    XCTAssertEqual(store.state.selectedTab, .orders, "No order loaded → no seeding, no tab change.")
    XCTAssertTrue(store.state.cart.draft.isEmpty)
  }

  // MARK: - openOrderTracking external entry

  func test_openOrderTracking_setsOrdersTabAndPushesDetail() async {
    let orderId = UUID()
    let store = TestStore(initialState: BrowseFeature.State()) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.openOrderTracking(orderId: orderId)) {
      $0.selectedTab = .orders
      $0.orderDetail = OrderDetailFeature.State(orderId: orderId)
    }
  }

  func test_openOrderTracking_alsoDismissesHandoffSheet() async {
    let orderId = UUID()
    let initial = BrowseFeature.State(
      checkoutHandoff: CheckoutHandoffFeature.State(cartId: UUID(), deliveryAddressId: UUID())
    )
    let store = TestStore(initialState: initial) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }

    await store.send(.openOrderTracking(orderId: orderId)) {
      $0.checkoutHandoff = nil
      $0.selectedTab = .orders
      $0.orderDetail = OrderDetailFeature.State(orderId: orderId)
    }
  }

  func test_productDetailOpenRelatedProduct_resolvesListingAndSwapsDetail() async {
    let originalProductId = UUID()
    let originalListingId = UUID()
    let dispensaryId = UUID()
    let relatedId = UUID()
    let relatedListingId = UUID()
    let relatedHit = Self.makeSearchHit(id: relatedId, name: "Related Strain", brand: "Brand")
    let listings = [
      Self.makeListing(
        listingId: relatedListingId,
        dispensaryId: UUID(),
        dispensaryName: "The Grove",
        priceCents: 3900,
        quantityAvailable: 8
      )
    ]
    let store = TestStore(
      initialState: BrowseFeature.State(
        productDetail: ProductDetailFeature.State(
          productId: originalProductId,
          listingId: originalListingId,
          dispensaryId: dispensaryId,
          priceCents: 3000,
          maxAvailable: 5,
          productName: "Original",
          brand: "Brand",
          relatedProducts: [relatedHit]
        )
      )
    ) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.catalogAPIClient.getProductListings = { @Sendable _ in listings }
    }
    store.exhaustivity = .off

    await store.send(.productDetail(.delegate(.openRelatedProduct(productId: relatedId))))
    await store.receive(\.productListingsResolved)

    XCTAssertEqual(store.state.productDetail?.productId, relatedId)
    XCTAssertEqual(store.state.productDetail?.listingId, relatedListingId)
    XCTAssertEqual(store.state.productDetail?.maxAvailable, 8, "Related drill-down resolves a real listing so the cart is enabled.")
    XCTAssertTrue(store.state.productDetail?.canAddToCart ?? false)
  }

  // MARK: - account tab routing

  func test_accountDelegateSignOutRequested_bubblesToBrowseDelegate() async {
    let store = TestStore(initialState: BrowseFeature.State(selectedTab: .account)) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.account(.delegate(.signOutRequested)))
    await store.receive(\.delegate.signOutRequested)
  }

  func test_accountDelegateShowOrders_switchesToOrdersTab() async {
    let store = TestStore(initialState: BrowseFeature.State(selectedTab: .account)) {
      BrowseFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
    }
    store.exhaustivity = .off

    await store.send(.account(.delegate(.showOrders)))
    XCTAssertEqual(store.state.selectedTab, .orders)
  }

  // MARK: - fixtures

  static func makeSearchHit(id: UUID, name: String, brand: String) -> SearchProductResult {
    SearchProductResult(
      id: id,
      categoryId: UUID(),
      brand: brand,
      name: name,
      productType: .flower,
      strainType: .hybrid,
      thcMgPerUnit: 100,
      cbdMgPerUnit: 0,
      weightGramsPerUnit: 3.5,
      servingCount: nil,
      thcMgPerServing: nil,
      imageKeys: [],
      effectsTags: [],
      flavorTags: []
    )
  }

  static func makeListing(
    listingId: UUID,
    dispensaryId: UUID,
    dispensaryName: String,
    priceCents: Int,
    quantityAvailable: Int
  ) -> ProductListing {
    ProductListing(
      listingId: listingId,
      dispensaryId: dispensaryId,
      dispensaryName: dispensaryName,
      sku: "SKU-\(listingId.uuidString.prefix(8))",
      priceCents: priceCents,
      compareAtPriceCents: nil,
      quantityAvailable: quantityAvailable
    )
  }
}
