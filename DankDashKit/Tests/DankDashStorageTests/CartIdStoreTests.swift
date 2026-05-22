import XCTest
@testable import DankDashStorage

/// Each test instantiates a fresh `CartIdStore` backed by a unique
/// `UserDefaults` suite so the host's `.standard` defaults are never
/// touched and parallel runs cannot collide on shared keys.
final class CartIdStoreTests: XCTestCase {
  private var suiteName: String!
  private var store: CartIdStore!

  override func setUp() {
    super.setUp()
    suiteName = "test.cartIdStore.\(UUID().uuidString)"
    store = CartIdStore(suiteName: suiteName)
  }

  override func tearDown() {
    UserDefaults().removePersistentDomain(forName: suiteName)
    store = nil
    suiteName = nil
    super.tearDown()
  }

  // MARK: - Basic round-trip

  func test_cartId_returnsNilWhenUnset() {
    XCTAssertNil(store.cartId(forDispensaryId: UUID()))
  }

  func test_set_thenGet_roundTripsTheCartId() {
    let dispensary = UUID()
    let cart = UUID()
    store.set(cartId: cart, forDispensaryId: dispensary)

    XCTAssertEqual(store.cartId(forDispensaryId: dispensary), cart)
  }

  func test_set_overwritesPreviousCartIdForSameDispensary() {
    let dispensary = UUID()
    let first = UUID()
    let second = UUID()
    store.set(cartId: first, forDispensaryId: dispensary)
    store.set(cartId: second, forDispensaryId: dispensary)

    XCTAssertEqual(store.cartId(forDispensaryId: dispensary), second)
  }

  func test_multipleDispensaries_areIndependent() {
    let dispensaryA = UUID()
    let dispensaryB = UUID()
    let cartA = UUID()
    let cartB = UUID()

    store.set(cartId: cartA, forDispensaryId: dispensaryA)
    store.set(cartId: cartB, forDispensaryId: dispensaryB)

    XCTAssertEqual(store.cartId(forDispensaryId: dispensaryA), cartA)
    XCTAssertEqual(store.cartId(forDispensaryId: dispensaryB), cartB)
  }

  // MARK: - Clear

  func test_clearDispensary_removesOnlyThatEntry() {
    let dispensaryA = UUID()
    let dispensaryB = UUID()
    store.set(cartId: UUID(), forDispensaryId: dispensaryA)
    let cartB = UUID()
    store.set(cartId: cartB, forDispensaryId: dispensaryB)

    store.clear(dispensaryId: dispensaryA)

    XCTAssertNil(store.cartId(forDispensaryId: dispensaryA))
    XCTAssertEqual(store.cartId(forDispensaryId: dispensaryB), cartB)
  }

  func test_clearDispensary_isIdempotentForMissingEntry() {
    XCTAssertNoThrow(store.clear(dispensaryId: UUID()))
  }

  func test_clearAll_removesEveryEntry() {
    let dispensaryA = UUID()
    let dispensaryB = UUID()
    store.set(cartId: UUID(), forDispensaryId: dispensaryA)
    store.set(cartId: UUID(), forDispensaryId: dispensaryB)

    store.clearAll()

    XCTAssertNil(store.cartId(forDispensaryId: dispensaryA))
    XCTAssertNil(store.cartId(forDispensaryId: dispensaryB))
  }

  // MARK: - Defensive reads

  /// If a previous app version (or a hand-rolled defaults edit) leaves
  /// a non-UUID value under a dispensary key, the lookup must return nil
  /// instead of crashing — fallback is "create a fresh server cart",
  /// which is harmless.
  func test_cartId_returnsNilForMalformedStoredValue() {
    let suite = UserDefaults(suiteName: suiteName)!
    let dispensary = UUID()
    suite.set(
      [CartIdStore.normalize(dispensary): "not-a-uuid"],
      forKey: "dankdash.cart.dispensaryToCart"
    )

    XCTAssertNil(store.cartId(forDispensaryId: dispensary))
  }

  /// Case differences in the dispensary id (uppercase vs lowercase
  /// `uuidString`) must resolve to the same logical key — otherwise the
  /// browse flow could create a second cart on a relaunch where the id
  /// re-rendered with different casing.
  func test_dispensaryIdCaseIsNormalized() {
    let raw = UUID()
    let upper = UUID(uuidString: raw.uuidString.uppercased())!
    let lower = UUID(uuidString: raw.uuidString.lowercased())!
    let cart = UUID()

    store.set(cartId: cart, forDispensaryId: upper)
    XCTAssertEqual(store.cartId(forDispensaryId: lower), cart)
  }

  // MARK: - Custom defaults key

  /// Caller can pin a custom key so a future Phase-19 store (cart id per
  /// dispensary + user) can't collide with this one in the same suite.
  func test_customKey_isolatesStoreInstancesInSameSuite() {
    let alt = CartIdStore(suiteName: suiteName, key: "test.alternate.key")
    let dispensary = UUID()
    let cart = UUID()
    store.set(cartId: cart, forDispensaryId: dispensary)

    XCTAssertNil(alt.cartId(forDispensaryId: dispensary))
    XCTAssertEqual(store.cartId(forDispensaryId: dispensary), cart)
  }
}
