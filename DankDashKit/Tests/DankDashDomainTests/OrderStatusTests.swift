import XCTest
@testable import DankDashDomain

/// `OrderStatus` is the 19-case mirror of the server's `order_status`
/// enum. Three contracts to cover:
///
///   - Wire raw values match (a rename breaks the realtime + REST
///     decoders silently).
///   - `canonicalOrder` is monotone non-decreasing through the happy
///     delivery path — the OrderStatusTimeline UI walks the path
///     forwards and uses `canonicalOrder` to decide which milestones
///     are already complete.
///   - `isTerminal` is true only for the seven documented terminal
///     states (`delivered` + six failure terminals). Polling on the
///     tracking screen stops on `isTerminal`, so a regression here
///     burns server cycles.
final class OrderStatusTests: XCTestCase {
  func test_rawValuesMatchWire() {
    XCTAssertEqual(OrderStatus.placed.rawValue, "placed")
    XCTAssertEqual(OrderStatus.paymentFailed.rawValue, "payment_failed")
    XCTAssertEqual(OrderStatus.accepted.rawValue, "accepted")
    XCTAssertEqual(OrderStatus.rejected.rawValue, "rejected")
    XCTAssertEqual(OrderStatus.prepping.rawValue, "prepping")
    XCTAssertEqual(OrderStatus.readyForPickup.rawValue, "ready_for_pickup")
    XCTAssertEqual(OrderStatus.awaitingDriver.rawValue, "awaiting_driver")
    XCTAssertEqual(OrderStatus.driverAssigned.rawValue, "driver_assigned")
    XCTAssertEqual(OrderStatus.enRoutePickup.rawValue, "en_route_pickup")
    XCTAssertEqual(OrderStatus.pickedUp.rawValue, "picked_up")
    XCTAssertEqual(OrderStatus.enRouteDropoff.rawValue, "en_route_dropoff")
    XCTAssertEqual(OrderStatus.arrivedAtDropoff.rawValue, "arrived_at_dropoff")
    XCTAssertEqual(OrderStatus.idScanPending.rawValue, "id_scan_pending")
    XCTAssertEqual(OrderStatus.idScanPassed.rawValue, "id_scan_passed")
    XCTAssertEqual(OrderStatus.idScanFailed.rawValue, "id_scan_failed")
    XCTAssertEqual(OrderStatus.delivered.rawValue, "delivered")
    XCTAssertEqual(OrderStatus.returnedToStore.rawValue, "returned_to_store")
    XCTAssertEqual(OrderStatus.canceled.rawValue, "canceled")
    XCTAssertEqual(OrderStatus.disputed.rawValue, "disputed")
  }

  func test_allCasesCountIsNineteen() {
    XCTAssertEqual(OrderStatus.allCases.count, 19)
  }

  func test_canonicalOrderMonotoneOnHappyDeliveryPath() {
    let happyPath: [OrderStatus] = [
      .placed,
      .accepted,
      .prepping,
      .awaitingDriver,
      .driverAssigned,
      .enRoutePickup,
      .pickedUp,
      .enRouteDropoff,
      .arrivedAtDropoff,
      .idScanPending,
      .idScanPassed,
      .delivered,
    ]
    let orders = happyPath.map(\.canonicalOrder)
    for (lhs, rhs) in zip(orders, orders.dropFirst()) {
      XCTAssertLessThan(lhs, rhs, "Happy-path canonicalOrder must be strictly increasing")
    }
  }

  func test_failureTerminalsSitAboveHappyPath() {
    let happyMax = OrderStatus.delivered.canonicalOrder
    let failureTerminals: [OrderStatus] = [
      .paymentFailed,
      .rejected,
      .canceled,
      .idScanFailed,
      .returnedToStore,
      .disputed,
    ]
    for state in failureTerminals {
      XCTAssertGreaterThan(
        state.canonicalOrder,
        happyMax,
        "Failure-terminal \(state) must not order below the happy path"
      )
    }
  }

  func test_isTerminalCoversExactlyTheSevenTerminalStates() {
    let expectedTerminals: Set<OrderStatus> = [
      .delivered,
      .paymentFailed,
      .rejected,
      .canceled,
      .idScanFailed,
      .returnedToStore,
      .disputed,
    ]
    for state in OrderStatus.allCases {
      XCTAssertEqual(
        state.isTerminal,
        expectedTerminals.contains(state),
        "\(state) isTerminal disagrees with the documented terminal set"
      )
    }
  }

  func test_displayLabelNonEmptyForEveryState() {
    for state in OrderStatus.allCases {
      XCTAssertFalse(state.displayLabel.isEmpty, "\(state) displayLabel empty")
    }
  }
}
