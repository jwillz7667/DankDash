import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class OrdersAPIClientTests: XCTestCase {
  func test_unimplementedClient_everyMethodThrows() async {
    let client = OrdersAPIClient.unimplemented
    await assertThrows(
      try await client.listOrders(ListOrdersQuery()),
      expectedMatch: "listOrders"
    )
    await assertThrows(
      try await client.getOrder(UUID()),
      expectedMatch: "getOrder"
    )
    await assertThrows(
      try await client.rateOrder(UUID(), OrderRatingInput(rating: 5)),
      expectedMatch: "rateOrder"
    )
  }

  func test_listOrdersQuery_defaultsAreStable() {
    let query = ListOrdersQuery()
    XCTAssertEqual(query.status, .all)
    XCTAssertNil(query.limit)
    XCTAssertNil(query.cursor)
  }

  func test_listOrdersStatusFilter_rawValuesMatchWire() {
    XCTAssertEqual(OrderListStatusFilter.active.rawValue, "active")
    XCTAssertEqual(OrderListStatusFilter.completed.rawValue, "completed")
    XCTAssertEqual(OrderListStatusFilter.all.rawValue, "all")
    XCTAssertEqual(OrderListStatusFilter.allCases.count, 3)
  }

  func test_orderListPage_isEquatableValueType() {
    let page = OrderListPage(items: [], nextCursor: "abc")
    XCTAssertEqual(page, OrderListPage(items: [], nextCursor: "abc"))
    XCTAssertNotEqual(page, OrderListPage(items: [], nextCursor: nil))
  }

  func test_orderDetail_isEquatableValueType() {
    let order = makeStubOrder()
    let dispensaryCoordinate = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let dropoffCoordinate = Coordinate(latitude: 44.9483, longitude: -93.2920)
    func makeDetail() -> OrderDetail {
      OrderDetail(
        order: order,
        events: [],
        driver: nil,
        dispensaryName: "Green Thumb",
        dispensaryCoordinate: dispensaryCoordinate,
        dropoffCoordinate: dropoffCoordinate,
        dropoffLabel: "123 Nicollet Ave"
      )
    }
    XCTAssertEqual(makeDetail(), makeDetail())
  }

  func test_customClient_passesArgumentsThrough() async throws {
    let probe = Locker<ListOrdersQuery?>(value: nil)
    let client = OrdersAPIClient(
      listOrders: { query in
        await probe.set(query)
        return OrderListPage(items: [], nextCursor: nil)
      },
      getOrder: { _ in throw OrdersAPIError.malformedPayload("Order") },
      rateOrder: { _, _ in throw OrdersAPIError.malformedPayload("Order") }
    )

    let query = ListOrdersQuery(status: .active, limit: 25, cursor: "page-2")
    _ = try await client.listOrders(query)
    let observed = await probe.value
    XCTAssertEqual(observed?.status, .active)
    XCTAssertEqual(observed?.limit, 25)
    XCTAssertEqual(observed?.cursor, "page-2")
  }

  func test_rateOrder_forwardsOrderIdAndInput() async throws {
    let probe = Locker<(UUID, OrderRatingInput)?>(value: nil)
    let stub = makeStubOrder()
    let client = OrdersAPIClient(
      listOrders: { _ in OrderListPage(items: [], nextCursor: nil) },
      getOrder: { _ in throw OrdersAPIError.malformedPayload("Order") },
      rateOrder: { id, input in
        await probe.set((id, input))
        return stub
      }
    )

    let orderId = UUID()
    let returned = try await client.rateOrder(
      orderId,
      OrderRatingInput(rating: 4, review: "Smooth delivery")
    )
    let observed = await probe.value
    XCTAssertEqual(observed?.0, orderId)
    XCTAssertEqual(observed?.1.rating, 4)
    XCTAssertEqual(observed?.1.review, "Smooth delivery")
    XCTAssertNil(observed?.1.driverRating)
    XCTAssertEqual(returned, stub)
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
    } catch let error as OrdersAPIError {
      if case let .unimplemented(name) = error {
        XCTAssertTrue(
          name.contains(expectedMatch),
          "unimplemented(\(name)) did not match \(expectedMatch)",
          file: file, line: line
        )
      } else {
        XCTFail("unexpected OrdersAPIError: \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error type: \(error)", file: file, line: line)
    }
  }

  private func makeStubOrder() -> Order {
    Order(
      id: UUID(),
      shortCode: "ABC123",
      userId: UUID(),
      dispensaryId: UUID(),
      deliveryAddressId: UUID(),
      status: .placed,
      subtotalCents: 5000,
      cannabisTaxCents: 500,
      salesTaxCents: 250,
      deliveryFeeCents: 0,
      driverTipCents: 0,
      discountCents: 0,
      totalCents: 5750,
      items: [],
      placedAt: Date(timeIntervalSinceReferenceDate: 0),
      statusChangedAt: Date(timeIntervalSinceReferenceDate: 0),
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
