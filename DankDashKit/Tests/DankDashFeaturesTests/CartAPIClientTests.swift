import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class CartAPIClientTests: XCTestCase {
  func test_unimplementedClient_everyMethodThrows() async {
    let client = CartAPIClient.unimplemented
    let cartId = UUID()
    let itemId = UUID()
    let listingId = UUID()
    let dispensaryId = UUID()
    let addressId = UUID()
    await assertThrows(
      try await client.createCart(dispensaryId),
      expectedMatch: "createCart"
    )
    await assertThrows(
      try await client.getCart(cartId),
      expectedMatch: "getCart"
    )
    await assertThrows(
      try await client.addItem(cartId, listingId, 1),
      expectedMatch: "addItem"
    )
    await assertThrows(
      try await client.patchItem(cartId, itemId, 2),
      expectedMatch: "patchItem"
    )
    await assertThrows(
      try await client.removeItem(cartId, itemId),
      expectedMatch: "removeItem"
    )
    await assertThrows(
      try await client.validate(cartId, addressId),
      expectedMatch: "validate"
    )
    await assertThrows(
      try await client.deleteCart(cartId),
      expectedMatch: "deleteCart"
    )
  }

  func test_customClient_passesArgumentsThrough() async throws {
    let probe = Locker<(UUID, UUID, Int)?>(value: nil)
    let stubCart = makeStubCart()
    let client = CartAPIClient(
      createCart: { _ in stubCart },
      getCart: { _ in stubCart },
      addItem: { cartId, listingId, qty in
        await probe.set((cartId, listingId, qty))
        return stubCart
      },
      patchItem: { _, _, _ in stubCart },
      removeItem: { _, _ in stubCart },
      validate: { _, _ in throw CartAPIError.malformedPayload("ignored") },
      deleteCart: { _ in () }
    )

    let cartId = UUID()
    let listingId = UUID()
    _ = try await client.addItem(cartId, listingId, 3)
    let observed = await probe.value
    XCTAssertEqual(observed?.0, cartId)
    XCTAssertEqual(observed?.1, listingId)
    XCTAssertEqual(observed?.2, 3)
  }

  func test_malformedPayloadError_isEquatable() {
    XCTAssertEqual(CartAPIError.malformedPayload("Cart"), CartAPIError.malformedPayload("Cart"))
    XCTAssertNotEqual(
      CartAPIError.malformedPayload("Cart"),
      CartAPIError.malformedPayload("ComplianceEvaluation")
    )
  }

  // MARK: - Helpers

  private func assertThrows<T>(
    _ expression: @autoclosure () async throws -> T,
    expectedMatch: String,
    file: StaticString = #file,
    line: UInt = #line
  ) async {
    do {
      _ = try await expression()
      XCTFail("expected to throw containing \(expectedMatch)", file: file, line: line)
    } catch let error as CartAPIError {
      if case let .unimplemented(name) = error {
        XCTAssertTrue(
          name.contains(expectedMatch),
          "unimplemented(\(name)) did not match \(expectedMatch)",
          file: file, line: line
        )
      } else {
        XCTFail("unexpected CartAPIError: \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error type: \(error)", file: file, line: line)
    }
  }

  private func makeStubCart() -> Cart {
    Cart(
      id: UUID(),
      userId: UUID(),
      dispensaryId: UUID(),
      items: [],
      subtotalCents: 0,
      expiresAt: Date(timeIntervalSinceReferenceDate: 0).addingTimeInterval(1800),
      createdAt: Date(timeIntervalSinceReferenceDate: 0),
      updatedAt: Date(timeIntervalSinceReferenceDate: 0)
    )
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
