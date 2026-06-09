import XCTest
import Foundation
import DankDashNetwork
@testable import DankDashFeatures

final class CheckoutAPIClientTests: XCTestCase {
  func test_unimplementedClient_throwsOnCapabilities() async {
    let client = CheckoutAPIClient.unimplemented
    do {
      _ = try await client.capabilities()
      XCTFail("expected to throw")
    } catch let error as CheckoutAPIError {
      guard case let .unimplemented(name) = error else {
        XCTFail("unexpected case: \(error)")
        return
      }
      XCTAssertTrue(name.contains("capabilities"))
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }

  func test_unimplementedClient_throwsOnCheckout() async {
    let client = CheckoutAPIClient.unimplemented
    do {
      _ = try await client.checkout(UUID(), UUID(), 0)
      XCTFail("expected to throw")
    } catch let error as CheckoutAPIError {
      guard case let .unimplemented(name) = error else {
        XCTFail("unexpected case: \(error)")
        return
      }
      XCTAssertTrue(name.contains("checkout"))
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }

  func test_customClient_capabilitiesReturnsValue() async throws {
    let client = CheckoutAPIClient(
      capabilities: { true },
      checkout: { _, _, _ in UUID() }
    )

    let enabled = try await client.capabilities()
    XCTAssertTrue(enabled)
  }

  func test_customClient_checkoutPassesArgsThroughAndReturnsOrderId() async throws {
    let probe = Locker<(UUID, UUID, Int)?>(value: nil)
    let orderId = UUID()
    let client = CheckoutAPIClient(
      capabilities: { false },
      checkout: { cartId, addressId, tip in
        await probe.set((cartId, addressId, tip))
        return orderId
      }
    )

    let cartId = UUID()
    let addressId = UUID()
    let result = try await client.checkout(cartId, addressId, 250)

    let observed = await probe.value
    XCTAssertEqual(observed?.0, cartId)
    XCTAssertEqual(observed?.1, addressId)
    XCTAssertEqual(observed?.2, 250)
    XCTAssertEqual(result, orderId)
  }

  func test_errors_areEquatable() {
    XCTAssertEqual(
      CheckoutAPIError.malformedResponse("order.id"),
      CheckoutAPIError.malformedResponse("order.id")
    )
    XCTAssertNotEqual(
      CheckoutAPIError.malformedResponse("order.id"),
      CheckoutAPIError.unimplemented("checkout")
    )
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
