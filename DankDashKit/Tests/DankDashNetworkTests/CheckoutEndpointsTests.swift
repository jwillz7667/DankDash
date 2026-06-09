import XCTest
@testable import DankDashNetwork

/// Endpoint-shape tests for the checkout catalog: capabilities probe +
/// the order-creating checkout call. Path templating, method/auth flags,
/// and the strict request-body encoding (optionals omitted, not nulled)
/// are asserted directly so a wire-field rename can't slip through.
final class CheckoutEndpointsTests: XCTestCase {
  func test_capabilities_getsV1CheckoutCapabilities_authed() {
    let endpoint = CheckoutEndpoints.capabilities()

    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/checkout/capabilities")
    XCTAssertTrue(endpoint.requiresAuth)
    XCTAssertNil(endpoint.body)
    XCTAssertTrue(endpoint.queryItems.isEmpty)
  }

  func test_checkout_postsToCartScopedPath_withBody() throws {
    let cartId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010")!
    let addressId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030")!
    let endpoint = CheckoutEndpoints.checkout(
      cartId: cartId,
      body: CheckoutRequestDTO(deliveryAddressId: addressId, driverTipCents: 0)
    )

    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/carts/0190b7a4-9c00-72f5-a6b0-1c6f77ce0010/checkout")
    XCTAssertTrue(endpoint.requiresAuth)

    let body = try XCTUnwrap(endpoint.body)
    let json = try body.encode(using: JSONEncoder())
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
    XCTAssertEqual(payload["deliveryAddressId"] as? String, "0190b7a4-9c00-72f5-a6b0-1c6f77ce0030")
    XCTAssertEqual(payload["driverTipCents"] as? Int, 0)
    // Strict server: nil optionals must be omitted, never sent as null.
    XCTAssertFalse(payload.keys.contains("paymentMethodId"))
    XCTAssertFalse(payload.keys.contains("deliveryInstructions"))
  }

  func test_checkout_encodesPresentOptionalFields() throws {
    let cartId = UUID()
    let addressId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030")!
    let methodId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0070")!
    let endpoint = CheckoutEndpoints.checkout(
      cartId: cartId,
      body: CheckoutRequestDTO(
        deliveryAddressId: addressId,
        driverTipCents: 500,
        paymentMethodId: methodId,
        deliveryInstructions: "Leave at door"
      )
    )

    let body = try XCTUnwrap(endpoint.body)
    let json = try body.encode(using: JSONEncoder())
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: json) as? [String: Any])
    XCTAssertEqual(payload["driverTipCents"] as? Int, 500)
    XCTAssertEqual(payload["paymentMethodId"] as? String, "0190b7a4-9c00-72f5-a6b0-1c6f77ce0070")
    XCTAssertEqual(payload["deliveryInstructions"] as? String, "Leave at door")
  }
}
