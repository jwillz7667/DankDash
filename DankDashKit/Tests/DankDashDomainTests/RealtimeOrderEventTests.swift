import XCTest
import Foundation
@testable import DankDashDomain

final class RealtimeOrderEventTests: XCTestCase {
  func test_orderId_extractsFromAllVariants() {
    let id = UUID()
    let statusEvent = RealtimeOrderEvent.statusChanged(
      orderId: id,
      status: .delivered,
      occurredAt: Date(timeIntervalSinceReferenceDate: 0)
    )
    XCTAssertEqual(statusEvent.orderId, id)

    let driverEvent = RealtimeOrderEvent.driverAssigned(
      orderId: id,
      driver: DriverPublicProfile(
        id: UUID(),
        displayName: "Sam",
        avatarKey: nil,
        vehicleSummary: nil,
        maskedPhone: nil
      ),
      occurredAt: Date(timeIntervalSinceReferenceDate: 0)
    )
    XCTAssertEqual(driverEvent.orderId, id)

    let locationEvent = RealtimeOrderEvent.driverLocation(
      orderId: id,
      coordinate: Coordinate(latitude: 44.98, longitude: -93.27),
      capturedAt: Date(timeIntervalSinceReferenceDate: 0)
    )
    XCTAssertEqual(locationEvent.orderId, id)

    let etaEvent = RealtimeOrderEvent.etaUpdated(
      orderId: id,
      etaMinutes: 12,
      updatedAt: Date(timeIntervalSinceReferenceDate: 0)
    )
    XCTAssertEqual(etaEvent.orderId, id)
  }

  func test_equatable_isPerCase() {
    let id = UUID()
    let occurredAt = Date(timeIntervalSinceReferenceDate: 0)
    let a = RealtimeOrderEvent.statusChanged(orderId: id, status: .delivered, occurredAt: occurredAt)
    let b = RealtimeOrderEvent.statusChanged(orderId: id, status: .delivered, occurredAt: occurredAt)
    XCTAssertEqual(a, b)

    let c = RealtimeOrderEvent.statusChanged(orderId: id, status: .prepping, occurredAt: occurredAt)
    XCTAssertNotEqual(a, c)

    let coordinate = Coordinate(latitude: 44.98, longitude: -93.27)
    let d = RealtimeOrderEvent.driverLocation(orderId: id, coordinate: coordinate, capturedAt: occurredAt)
    XCTAssertNotEqual(a, d)
  }
}
