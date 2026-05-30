import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class HandoffAPIClientTests: XCTestCase {
  func test_unimplementedClient_throwsOnCreate() async {
    let client = HandoffAPIClient.unimplemented
    do {
      _ = try await client.createCheckoutHandoff(UUID(), UUID())
      XCTFail("expected to throw")
    } catch let error as HandoffAPIError {
      guard case let .unimplemented(name) = error else {
        XCTFail("unexpected case: \(error)")
        return
      }
      XCTAssertTrue(name.contains("createCheckoutHandoff"))
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }

  func test_customClient_passesIdsThrough() async throws {
    let probe = Locker<(UUID, UUID)?>(value: nil)
    let token = HandoffToken(
      token: "jwt.signed.token",
      exchangeUrl: URL(string: "https://app.dankdash.com/checkout?handoff=abc")!,
      expiresAt: Date(timeIntervalSinceReferenceDate: 0).addingTimeInterval(300)
    )
    let client = HandoffAPIClient(
      createCheckoutHandoff: { cartId, addressId in
        await probe.set((cartId, addressId))
        return token
      }
    )

    let cartId = UUID()
    let addressId = UUID()
    let result = try await client.createCheckoutHandoff(cartId, addressId)
    let observed = await probe.value
    XCTAssertEqual(observed?.0, cartId)
    XCTAssertEqual(observed?.1, addressId)
    XCTAssertEqual(result, token)
  }

  func test_malformedPayloadError_isEquatable() {
    XCTAssertEqual(
      HandoffAPIError.malformedPayload("HandoffToken"),
      HandoffAPIError.malformedPayload("HandoffToken")
    )
    XCTAssertNotEqual(
      HandoffAPIError.malformedPayload("HandoffToken"),
      HandoffAPIError.unimplemented("createCheckoutHandoff")
    )
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
