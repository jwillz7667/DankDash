import XCTest
@testable import DankDashDomain

final class CoordinateTests: XCTestCase {
  func test_distanceToSelfIsZero() {
    let point = Coordinate(latitude: 44.987, longitude: -93.273)
    XCTAssertEqual(point.distanceMeters(to: point), 0, accuracy: 0.001)
  }

  func test_distanceIsSymmetric() {
    let a = Coordinate(latitude: 44.98, longitude: -93.27)
    let b = Coordinate(latitude: 44.99, longitude: -93.25)
    XCTAssertEqual(a.distanceMeters(to: b), b.distanceMeters(to: a), accuracy: 0.001)
  }

  func test_oneDegreeOfLatitudeIsRoughly111km() {
    // A degree of latitude is ~111.2 km everywhere on the globe — a stable
    // anchor for the haversine implementation independent of longitude.
    let a = Coordinate(latitude: 44.0, longitude: -93.0)
    let b = Coordinate(latitude: 45.0, longitude: -93.0)
    XCTAssertEqual(a.distanceMeters(to: b), 111_195, accuracy: 500)
  }

  func test_shortMovementMatchesThrottleGate() {
    // ~222 m north — the fixture the DriverShiftFeature idle-publish tests
    // rely on to clear the 150 m movement gate. Guard the magnitude so a
    // regression in the math doesn't silently flip that gate.
    let from = Coordinate(latitude: 44.98, longitude: -93.27)
    let to = Coordinate(latitude: 44.982, longitude: -93.27)
    let meters = from.distanceMeters(to: to)
    XCTAssertGreaterThan(meters, 200)
    XCTAssertLessThan(meters, 245)
  }
}
