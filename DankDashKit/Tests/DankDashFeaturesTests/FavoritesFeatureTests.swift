import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class FavoritesFeatureTests: XCTestCase {
  // MARK: - Loading

  func test_task_loadsPageIntoState() async {
    let page = FavoritesPage(
      items: [Self.dispensaryFavorite(name: "Bloom"), Self.productFavorite(name: "Sour Tangie")],
      limit: 50,
      offset: 0,
      total: 2
    )
    var favorites = FavoritesAPIClient.unimplemented
    favorites.list = { _, _ in page }

    let store = TestStore(initialState: FavoritesFeature.State()) {
      FavoritesFeature()
    } withDependencies: {
      $0.favoritesAPIClient = favorites
    }

    await store.send(.task) { $0.isLoading = true }
    await store.receive(\.favoritesResponse.success) {
      $0.isLoading = false
      $0.hasLoaded = true
      $0.items = page.items
    }
  }

  func test_task_failure_setsErrorAndMarksLoaded() async {
    var favorites = FavoritesAPIClient.unimplemented
    favorites.list = { _, _ in throw FavoritesAPIError.unimplemented("list") }

    let store = TestStore(initialState: FavoritesFeature.State()) {
      FavoritesFeature()
    } withDependencies: {
      $0.favoritesAPIClient = favorites
    }

    await store.send(.task) { $0.isLoading = true }
    await store.receive(\.favoritesResponse.failure) {
      $0.isLoading = false
      $0.hasLoaded = true
      $0.error = FavoritesFeature.userMessage(for: .transport)
    }
  }

  // MARK: - Unfavorite

  func test_unfavorite_optimisticallyRemoves_thenConfirms() async {
    let dispensary = Self.dispensaryFavorite(name: "Bloom")
    let product = Self.productFavorite(name: "Sour Tangie")
    let removed = LockIsolated<[UUID]>([])
    var favorites = FavoritesAPIClient.unimplemented
    favorites.removeProduct = { id in removed.withValue { $0.append(id) } }

    let store = TestStore(
      initialState: FavoritesFeature.State(items: [dispensary, product], hasLoaded: true)
    ) {
      FavoritesFeature()
    } withDependencies: {
      $0.favoritesAPIClient = favorites
    }

    await store.send(.unfavoriteTapped(id: product.id)) {
      $0.items = [dispensary]
    }
    await store.receive(\.unfavoriteResponse)
    XCTAssertEqual(removed.value, [product.id])
  }

  func test_unfavorite_failure_restoresRowAtOriginalIndex() async {
    let dispensary = Self.dispensaryFavorite(name: "Bloom")
    let product = Self.productFavorite(name: "Sour Tangie")
    var favorites = FavoritesAPIClient.unimplemented
    favorites.removeDispensary = { _ in throw FavoritesAPIError.unimplemented("removeDispensary") }

    let store = TestStore(
      initialState: FavoritesFeature.State(items: [dispensary, product], hasLoaded: true)
    ) {
      FavoritesFeature()
    } withDependencies: {
      $0.favoritesAPIClient = favorites
    }

    // Remove the first (dispensary) row; the failure restores it at index 0.
    await store.send(.unfavoriteTapped(id: dispensary.id)) {
      $0.items = [product]
    }
    await store.receive(\.unfavoriteResponse) {
      $0.items = [dispensary, product]
    }
  }

  // MARK: - Fixtures

  static func dispensaryFavorite(name: String) -> FavoriteItem {
    .dispensary(
      favoritedAt: Date(timeIntervalSince1970: 1_780_000_000),
      Dispensary(
        id: UUID(),
        legalName: name,
        dba: nil,
        licenseNumber: "MN-0001",
        licenseType: .microbusiness,
        addressLine1: "1 Main",
        addressLine2: nil,
        city: "Minneapolis",
        region: "MN",
        postalCode: "55401",
        location: Coordinate(latitude: 44.97, longitude: -93.26),
        deliveryPolygon: GeoPolygon(rings: []),
        hours: DispensaryHours(mon: nil, tue: nil, wed: nil, thu: nil, fri: nil, sat: nil, sun: nil),
        phone: nil,
        email: nil,
        logoImageKey: nil,
        heroImageKey: nil,
        brandColorHex: nil,
        isAcceptingOrders: true,
        isOpenNow: true,
        opensAt: nil,
        ratingAvg: nil,
        ratingCount: 0,
        status: .active,
        createdAt: Date(timeIntervalSince1970: 1_780_000_000),
        updatedAt: Date(timeIntervalSince1970: 1_780_000_000)
      )
    )
  }

  static func productFavorite(name: String) -> FavoriteItem {
    .product(
      favoritedAt: Date(timeIntervalSince1970: 1_780_000_000),
      MenuProductSummary(
        id: UUID(),
        categoryId: UUID(),
        brand: "Sunny Side",
        name: name,
        description: nil,
        productType: .flower,
        strainType: .sativa,
        thcMgPerUnit: Decimal(string: "24.5")!,
        cbdMgPerUnit: Decimal(string: "0.1")!,
        weightGramsPerUnit: Decimal(string: "3.5")!,
        servingCount: nil,
        thcMgPerServing: nil,
        imageKeys: [],
        effectsTags: [],
        flavorTags: []
      )
    )
  }
}
