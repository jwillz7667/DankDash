import XCTest
import Foundation
import DankDashStorage
@testable import DankDashFeatures

final class CartIdStoreClientTests: XCTestCase {
  // MARK: - .live binding with isolated UserDefaults

  func test_live_setAndReadRoundTrips() async {
    let (store, suite) = makeIsolatedStore()
    defer { teardown(suite: suite) }
    let client = CartIdStoreClient.live(store: store)
    let dispensaryId = UUID()
    let cartId = UUID()

    let missBefore = await client.cartId(dispensaryId)
    XCTAssertNil(missBefore)

    await client.setCartId(cartId, dispensaryId)
    let hit = await client.cartId(dispensaryId)
    XCTAssertEqual(hit, cartId)
  }

  func test_live_setOverwritesPriorEntry() async {
    let (store, suite) = makeIsolatedStore()
    defer { teardown(suite: suite) }
    let client = CartIdStoreClient.live(store: store)
    let dispensaryId = UUID()
    let first = UUID()
    let second = UUID()

    await client.setCartId(first, dispensaryId)
    await client.setCartId(second, dispensaryId)
    let hit = await client.cartId(dispensaryId)
    XCTAssertEqual(hit, second)
  }

  func test_live_clearScopedToDispensary() async {
    let (store, suite) = makeIsolatedStore()
    defer { teardown(suite: suite) }
    let client = CartIdStoreClient.live(store: store)
    let dispensaryA = UUID()
    let dispensaryB = UUID()
    let cartA = UUID()
    let cartB = UUID()

    await client.setCartId(cartA, dispensaryA)
    await client.setCartId(cartB, dispensaryB)

    await client.clear(dispensaryA)
    let aAfter = await client.cartId(dispensaryA)
    let bAfter = await client.cartId(dispensaryB)
    XCTAssertNil(aAfter)
    XCTAssertEqual(bAfter, cartB)
  }

  func test_live_clearAllWipesEverything() async {
    let (store, suite) = makeIsolatedStore()
    defer { teardown(suite: suite) }
    let client = CartIdStoreClient.live(store: store)
    let dispensaryA = UUID()
    let dispensaryB = UUID()

    await client.setCartId(UUID(), dispensaryA)
    await client.setCartId(UUID(), dispensaryB)

    await client.clearAll()
    let aAfter = await client.cartId(dispensaryA)
    let bAfter = await client.cartId(dispensaryB)
    XCTAssertNil(aAfter)
    XCTAssertNil(bAfter)
  }

  // MARK: - .unimplemented

  func test_unimplemented_readsAlwaysMiss() async {
    let client = CartIdStoreClient.unimplemented
    let hit = await client.cartId(UUID())
    await client.setCartId(UUID(), UUID())
    await client.clear(UUID())
    await client.clearAll()
    XCTAssertNil(hit)
  }

  // MARK: - Helpers

  private func makeIsolatedStore() -> (CartIdStore, String) {
    let suiteName = "com.dankdash.tests.CartIdStoreClient.\(UUID().uuidString)"
    let store = CartIdStore(suiteName: suiteName, key: "dankdash.cart.dispensaryToCart.test")
    return (store, suiteName)
  }

  private func teardown(suite: String) {
    UserDefaults().removePersistentDomain(forName: suite)
  }
}
