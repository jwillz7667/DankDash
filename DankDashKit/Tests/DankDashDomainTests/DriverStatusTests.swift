import XCTest
@testable import DankDashDomain

/// ``DriverStatus`` mirrors the server `driver_status` enum verbatim.
/// A rename of any raw value silently breaks the realtime `/driver`
/// namespace decoder, the shift home reducer's status pill, and the
/// admin-side patch responses — so the raw values are a wire contract,
/// not an implementation detail.
final class DriverStatusTests: XCTestCase {
  func test_rawValuesMatchWire() {
    XCTAssertEqual(DriverStatus.offline.rawValue, "offline")
    XCTAssertEqual(DriverStatus.online.rawValue, "online")
    XCTAssertEqual(DriverStatus.enRoutePickup.rawValue, "en_route_pickup")
    XCTAssertEqual(DriverStatus.enRouteDropoff.rawValue, "en_route_dropoff")
    XCTAssertEqual(DriverStatus.onBreak.rawValue, "on_break")
    XCTAssertEqual(DriverStatus.unavailable.rawValue, "unavailable")
  }

  func test_allCasesCountIsSix() {
    XCTAssertEqual(DriverStatus.allCases.count, 6)
  }

  func test_isAvailableForOffers_onlyOnlineQualifies() {
    for status in DriverStatus.allCases {
      XCTAssertEqual(
        status.isAvailableForOffers,
        status == .online,
        "\(status) availability disagrees with the offer-pool contract"
      )
    }
  }

  func test_isOnActiveDelivery_coversEnRouteStates() {
    let active: Set<DriverStatus> = [.enRoutePickup, .enRouteDropoff]
    for status in DriverStatus.allCases {
      XCTAssertEqual(
        status.isOnActiveDelivery,
        active.contains(status),
        "\(status) active-delivery flag disagrees with documented set"
      )
    }
  }

  func test_displayLabelNonEmptyForEveryCase() {
    for status in DriverStatus.allCases {
      XCTAssertFalse(status.displayLabel.isEmpty, "\(status) displayLabel empty")
    }
  }
}
