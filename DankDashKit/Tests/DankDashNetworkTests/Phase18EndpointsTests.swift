import XCTest
@testable import DankDashNetwork

/// Endpoint-shape tests. The catalogs are exercised end-to-end by the
/// APIClient tests, but the non-obvious bits — query-param composition,
/// path templating, method/auth flags, encoded request bodies — deserve
/// direct assertions so refactors that "rename one little field" can't
/// silently break the wire.
final class Phase18EndpointsTests: XCTestCase {
  // MARK: - Cart

  func test_cart_createPostsToV1Carts_withDispensaryBody() throws {
    let dispensaryId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0001")!
    let endpoint = CartEndpoints.createCart(dispensaryId: dispensaryId)

    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/carts")
    XCTAssertTrue(endpoint.requiresAuth)

    let body = try XCTUnwrap(endpoint.body)
    let json = try body.encode(using: JSONEncoder())
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: String]
    )
    XCTAssertEqual(payload["dispensaryId"], "0190b7a4-9c00-72f5-a6b0-1c6f77ce0001")
  }

  func test_cart_validateAttachesDeliveryAddressIdAsQueryParam() {
    let cartId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010")!
    let addressId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030")!
    let endpoint = CartEndpoints.validate(cartId: cartId, deliveryAddressId: addressId)

    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/carts/0190b7a4-9c00-72f5-a6b0-1c6f77ce0010/validate")
    XCTAssertEqual(endpoint.queryItems.count, 1)
    XCTAssertEqual(endpoint.queryItems.first?.name, "deliveryAddressId")
    XCTAssertEqual(
      endpoint.queryItems.first?.value,
      "0190b7a4-9c00-72f5-a6b0-1c6f77ce0030"
    )
    XCTAssertNil(endpoint.body, "validate body is empty; address rides as a query param")
  }

  func test_cart_deleteReturnsEmptyResponseType() {
    let cartId = UUID()
    let endpoint = CartEndpoints.deleteCart(cartId: cartId)
    XCTAssertEqual(endpoint.method, .DELETE)
    XCTAssertEqual(endpoint.path, "v1/carts/\(cartId.uuidString.lowercased())")
    XCTAssertTrue(endpoint.requiresAuth)
  }

  func test_cart_patchItemTemplatesBothIds() {
    let cartId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0010")!
    let itemId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0301")!
    let endpoint = CartEndpoints.patchItem(
      cartId: cartId,
      itemId: itemId,
      body: PatchCartItemRequestDTO(quantity: 0)
    )
    XCTAssertEqual(endpoint.method, .PATCH)
    XCTAssertEqual(
      endpoint.path,
      "v1/carts/0190b7a4-9c00-72f5-a6b0-1c6f77ce0010/items/0190b7a4-9c00-72f5-a6b0-1c6f77ce0301"
    )
  }

  // MARK: - Orders

  func test_orders_listOmitsAbsentQueryItems() {
    let endpoint = OrdersEndpoints.listOrders()
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/orders")
    XCTAssertTrue(endpoint.queryItems.isEmpty)
    XCTAssertTrue(endpoint.requiresAuth)
  }

  func test_orders_listAttachesEachProvidedQueryItem() {
    let endpoint = OrdersEndpoints.listOrders(
      status: "active",
      limit: 25,
      cursor: "abc"
    )
    let pairs = endpoint.queryItems.map { ($0.name, $0.value ?? "") }
    XCTAssertEqual(pairs.count, 3)
    XCTAssertTrue(pairs.contains(where: { $0.0 == "status" && $0.1 == "active" }))
    XCTAssertTrue(pairs.contains(where: { $0.0 == "limit" && $0.1 == "25" }))
    XCTAssertTrue(pairs.contains(where: { $0.0 == "cursor" && $0.1 == "abc" }))
  }

  func test_orders_getOrderTemplatesId() {
    let id = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400")!
    let endpoint = OrdersEndpoints.getOrder(id: id)
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/orders/0190b7a4-9c00-72f5-a6b0-1c6f77ce0400")
  }

  // MARK: - Addresses

  func test_addresses_list() {
    let endpoint = AddressesEndpoints.listAddresses()
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/addresses")
    XCTAssertTrue(endpoint.requiresAuth)
  }

  func test_addresses_patchTemplatesId() {
    let id = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0030")!
    let endpoint = AddressesEndpoints.patchAddress(
      id: id,
      body: PatchAddressRequestDTO(isDefault: true)
    )
    XCTAssertEqual(endpoint.method, .PATCH)
    XCTAssertEqual(endpoint.path, "v1/addresses/0190b7a4-9c00-72f5-a6b0-1c6f77ce0030")
  }

  // MARK: - Handoff

  func test_handoff_postsToCheckoutHandoff() throws {
    let body = CheckoutHandoffRequestDTO(cartId: UUID(), deliveryAddressId: UUID())
    let endpoint = AuthHandoffEndpoints.createCheckoutHandoff(body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/auth/checkout-handoff")
    XCTAssertTrue(endpoint.requiresAuth)
    XCTAssertNotNil(endpoint.body)
  }

  // MARK: - Notifications

  func test_notifications_registerDevice() throws {
    let body = RegisterDeviceRequestDTO(apnsToken: "abc", deviceId: UUID())
    let endpoint = NotificationsEndpoints.registerDevice(body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/notifications/register-device")
    XCTAssertTrue(endpoint.requiresAuth)
  }
}
