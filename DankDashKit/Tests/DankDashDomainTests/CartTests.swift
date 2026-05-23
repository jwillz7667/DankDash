import XCTest
@testable import DankDashDomain

final class CartTests: XCTestCase {
  private func makeItem(quantity: Int = 1, lineSubtotal: Int = 4500) -> CartItem {
    CartItem(
      id: UUID(),
      listingId: UUID(),
      quantity: quantity,
      unitPriceCents: 4500,
      lineSubtotalCents: lineSubtotal,
      createdAt: Date(timeIntervalSince1970: 0),
      updatedAt: Date(timeIntervalSince1970: 0)
    )
  }

  private func makeCart(items: [CartItem] = []) -> Cart {
    Cart(
      id: UUID(),
      userId: UUID(),
      dispensaryId: UUID(),
      items: items,
      subtotalCents: items.reduce(0) { $0 + $1.lineSubtotalCents },
      expiresAt: Date(timeIntervalSince1970: 1800),
      createdAt: Date(timeIntervalSince1970: 0),
      updatedAt: Date(timeIntervalSince1970: 0)
    )
  }

  func test_isEmptyTrueForNoItems() {
    XCTAssertTrue(makeCart().isEmpty)
  }

  func test_isEmptyFalseWhenItemsPresent() {
    XCTAssertFalse(makeCart(items: [makeItem()]).isEmpty)
  }

  func test_totalQuantitySumsAcrossLines() {
    let cart = makeCart(items: [
      makeItem(quantity: 1),
      makeItem(quantity: 3),
      makeItem(quantity: 2),
    ])
    XCTAssertEqual(cart.totalQuantity, 6)
  }
}
