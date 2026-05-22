import XCTest
@testable import DankDashDomain

final class LocalCartDraftTests: XCTestCase {
  private func makeLine(
    listing: UUID = UUID(),
    product: UUID = UUID(),
    price: Int = 4500,
    quantity: Int = 1,
    maxAvailable: Int = 10
  ) -> LocalCartDraft.Line {
    LocalCartDraft.Line(
      listingId: listing,
      productId: product,
      productName: "Sour Diesel — 1g preroll",
      brand: "Test Co",
      priceCents: price,
      quantity: quantity,
      maxAvailable: maxAvailable
    )
  }

  func test_emptyDraft() {
    let draft = LocalCartDraft()
    XCTAssertTrue(draft.isEmpty)
    XCTAssertEqual(draft.totalQuantity, 0)
    XCTAssertEqual(draft.totalCents, 0)
  }

  func test_addAppendsNewLine() {
    var draft = LocalCartDraft()
    draft.add(makeLine(price: 1200, quantity: 1, maxAvailable: 3))
    XCTAssertEqual(draft.lines.count, 1)
    XCTAssertEqual(draft.lines.first?.quantity, 1)
    XCTAssertEqual(draft.totalCents, 1200)
  }

  func test_addIncrementsExistingLine() {
    let listing = UUID()
    var draft = LocalCartDraft()
    draft.add(makeLine(listing: listing, price: 1000, quantity: 1, maxAvailable: 5))
    draft.add(makeLine(listing: listing, price: 1000, quantity: 1, maxAvailable: 5))
    XCTAssertEqual(draft.lines.count, 1)
    XCTAssertEqual(draft.lines.first?.quantity, 2)
    XCTAssertEqual(draft.totalCents, 2000)
  }

  func test_addClampsToMaxAvailable() {
    let listing = UUID()
    var draft = LocalCartDraft()
    draft.add(makeLine(listing: listing, quantity: 1, maxAvailable: 2))
    draft.add(makeLine(listing: listing, quantity: 1, maxAvailable: 2))
    draft.add(makeLine(listing: listing, quantity: 1, maxAvailable: 2))
    XCTAssertEqual(draft.lines.first?.quantity, 2, "Quantity clamped to maxAvailable")
  }

  func test_addRefusesZeroAvailableListing() {
    var draft = LocalCartDraft()
    draft.add(makeLine(maxAvailable: 0))
    XCTAssertTrue(draft.isEmpty, "A listing with no stock cannot enter the draft")
  }

  func test_setQuantityClampsAndAdjusts() {
    let listing = UUID()
    var draft = LocalCartDraft()
    draft.add(makeLine(listing: listing, quantity: 1, maxAvailable: 5))
    draft.setQuantity(3, for: listing)
    XCTAssertEqual(draft.lines.first?.quantity, 3)
    draft.setQuantity(99, for: listing)
    XCTAssertEqual(draft.lines.first?.quantity, 5, "Setting above max clamps to max")
  }

  func test_setQuantityZeroRemovesLine() {
    let listing = UUID()
    var draft = LocalCartDraft()
    draft.add(makeLine(listing: listing, quantity: 2, maxAvailable: 5))
    draft.setQuantity(0, for: listing)
    XCTAssertTrue(draft.isEmpty)
  }

  func test_setQuantityIgnoresUnknownListing() {
    var draft = LocalCartDraft()
    draft.add(makeLine(quantity: 1, maxAvailable: 5))
    draft.setQuantity(99, for: UUID())
    XCTAssertEqual(draft.lines.count, 1)
    XCTAssertEqual(draft.lines.first?.quantity, 1)
  }

  func test_removeDropsLine() {
    let listing = UUID()
    var draft = LocalCartDraft()
    draft.add(makeLine(listing: listing, quantity: 2, maxAvailable: 5))
    draft.remove(listingId: listing)
    XCTAssertTrue(draft.isEmpty)
  }

  func test_totalsCombineLines() {
    var draft = LocalCartDraft()
    draft.add(makeLine(price: 1000, quantity: 2, maxAvailable: 5))
    draft.add(makeLine(price: 2500, quantity: 1, maxAvailable: 5))
    XCTAssertEqual(draft.totalQuantity, 3)
    XCTAssertEqual(draft.totalCents, 1000 * 2 + 2500)
  }

  func test_clearEmptiesDraft() {
    var draft = LocalCartDraft()
    draft.add(makeLine(quantity: 1, maxAvailable: 3))
    draft.clear()
    XCTAssertTrue(draft.isEmpty)
  }
}
