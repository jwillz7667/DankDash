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
    let detail = OrderDetail(order: order, events: [], driver: nil)
    XCTAssertEqual(detail, OrderDetail(order: order, events: [], driver: nil))
  }

  func test_customClient_passesArgumentsThrough() async throws {
    let probe = Locker<ListOrdersQuery?>(value: nil)
    let client = OrdersAPIClient(
      listOrders: { query in
        await probe.set(query)
        return OrderListPage(items: [], nextCursor: nil)
      },
      getOrder: { _ in throw OrdersAPIError.malformedPayload("Order") }
    )

    let query = ListOrdersQuery(status: .active, limit: 25, cursor: "page-2")
    _ = try await client.listOrders(query)
    let observed = await probe.value
    XCTAssertEqual(observed?.status, .active)
    XCTAssertEqual(observed?.limit, 25)
    XCTAssertEqual(observed?.cursor, "page-2")
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
