import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class LocalCartDraftFeatureTests: XCTestCase {
  func test_addLine_appendsNewLine() async {
    let store = TestStore(initialState: LocalCartDraftFeature.State()) {
      LocalCartDraftFeature()
    }
    let listingId = UUID()
    let productId = UUID()
    let expectedLine = LocalCartDraft.Line(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel 3.5g",
      brand: "Brand",
      priceCents: 3500,
      quantity: 1,
      maxAvailable: 10
    )

    await store.send(.addLine(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel 3.5g",
      brand: "Brand",
      priceCents: 3500,
      maxAvailable: 10
    )) {
      $0.draft.lines = [expectedLine]
    }
  }

  func test_addLine_bumpsExistingQuantity() async {
    let listingId = UUID()
    let productId = UUID()
    let existing = LocalCartDraft.Line(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel 3.5g",
      brand: "Brand",
      priceCents: 3500,
      quantity: 2,
      maxAvailable: 10
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [existing]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.addLine(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel 3.5g",
      brand: "Brand",
      priceCents: 3500,
      maxAvailable: 10
    )) {
      $0.draft.lines[0].quantity = 3
    }
  }

  func test_addLine_clampsToMaxAvailable() async {
    let listingId = UUID()
    let productId = UUID()
    let existing = LocalCartDraft.Line(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel 3.5g",
      brand: "Brand",
      priceCents: 3500,
      quantity: 5,
      maxAvailable: 5
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [existing]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.addLine(
      listingId: listingId,
      productId: productId,
      productName: "Sour Diesel 3.5g",
      brand: "Brand",
      priceCents: 3500,
      maxAvailable: 5
    ))
    // Quantity stays at 5 — no observable state change.
  }

  func test_addLine_rejectsSoldOut() async {
    let store = TestStore(initialState: LocalCartDraftFeature.State()) {
      LocalCartDraftFeature()
    }

    await store.send(.addLine(
      listingId: UUID(),
      productId: UUID(),
      productName: "Sold Out",
      brand: "Brand",
      priceCents: 3500,
      maxAvailable: 0
    ))
    XCTAssertTrue(store.state.draft.isEmpty)
  }

  func test_setQuantity_updatesExistingLine() async {
    let listingId = UUID()
    let existing = LocalCartDraft.Line(
      listingId: listingId,
      productId: UUID(),
      productName: "Sour Diesel",
      brand: "Brand",
      priceCents: 3500,
      quantity: 2,
      maxAvailable: 10
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [existing]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.setQuantity(listingId: listingId, quantity: 5)) {
      $0.draft.lines[0].quantity = 5
    }
  }

  func test_setQuantity_clampsToMaxAvailable() async {
    let listingId = UUID()
    let existing = LocalCartDraft.Line(
      listingId: listingId,
      productId: UUID(),
      productName: "Sour Diesel",
      brand: "Brand",
      priceCents: 3500,
      quantity: 1,
      maxAvailable: 3
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [existing]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.setQuantity(listingId: listingId, quantity: 99)) {
      $0.draft.lines[0].quantity = 3
    }
  }

  func test_setQuantity_zeroOrNegative_removesLine() async {
    let listingId = UUID()
    let existing = LocalCartDraft.Line(
      listingId: listingId,
      productId: UUID(),
      productName: "Sour Diesel",
      brand: "Brand",
      priceCents: 3500,
      quantity: 2,
      maxAvailable: 10
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [existing]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.setQuantity(listingId: listingId, quantity: 0)) {
      $0.draft.lines = []
    }
  }

  func test_removeLine_removesById() async {
    let listing1 = UUID()
    let listing2 = UUID()
    let line1 = LocalCartDraft.Line(
      listingId: listing1, productId: UUID(),
      productName: "A", brand: "Brand", priceCents: 1000, quantity: 1, maxAvailable: 5
    )
    let line2 = LocalCartDraft.Line(
      listingId: listing2, productId: UUID(),
      productName: "B", brand: "Brand", priceCents: 2000, quantity: 1, maxAvailable: 5
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [line1, line2]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.removeLine(listingId: listing1)) {
      $0.draft.lines = [line2]
    }
  }

  func test_clearAll_emptiesDraft() async {
    let line = LocalCartDraft.Line(
      listingId: UUID(), productId: UUID(),
      productName: "A", brand: "Brand", priceCents: 1000, quantity: 1, maxAvailable: 5
    )
    let store = TestStore(
      initialState: LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [line]))
    ) {
      LocalCartDraftFeature()
    }

    await store.send(.clearAll) {
      $0.draft.lines = []
    }
  }

  func test_derivedTotals_reflectLines() {
    let line1 = LocalCartDraft.Line(
      listingId: UUID(), productId: UUID(),
      productName: "A", brand: "Brand", priceCents: 1000, quantity: 2, maxAvailable: 5
    )
    let line2 = LocalCartDraft.Line(
      listingId: UUID(), productId: UUID(),
      productName: "B", brand: "Brand", priceCents: 2500, quantity: 3, maxAvailable: 5
    )
    let state = LocalCartDraftFeature.State(draft: LocalCartDraft(lines: [line1, line2]))
    XCTAssertEqual(state.totalQuantity, 5)
    XCTAssertEqual(state.totalCents, 2000 + 7500)
    XCTAssertEqual(state.lines.count, 2)
    XCTAssertFalse(state.isEmpty)
  }
}
