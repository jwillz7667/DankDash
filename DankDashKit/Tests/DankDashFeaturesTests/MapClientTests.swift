import XCTest
import Foundation
import DankDashDomain
@testable import DankDashFeatures

final class MapClientTests: XCTestCase {
  // MARK: - computeBoundingRegion

  func test_computeBoundingRegion_emptyReturnsNil() {
    XCTAssertNil(computeBoundingRegion(for: []))
  }

  func test_computeBoundingRegion_singleCoordinateUsesMinimumSpan() {
    let coord = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let region = computeBoundingRegion(for: [coord])
    let unwrapped = try? XCTUnwrap(region)
    XCTAssertEqual(unwrapped?.center.latitude ?? 0, 44.9778, accuracy: 0.0001)
    XCTAssertEqual(unwrapped?.center.longitude ?? 0, -93.2650, accuracy: 0.0001)
    XCTAssertEqual(unwrapped?.latitudeSpan ?? 0, 0.01, accuracy: 1e-9)
    XCTAssertEqual(unwrapped?.longitudeSpan ?? 0, 0.01, accuracy: 1e-9)
  }

  func test_computeBoundingRegion_threeCoordsCentersAndPads() {
    let dispensary = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let customer = Coordinate(latitude: 44.9836, longitude: -93.2766)
    let driver = Coordinate(latitude: 44.9805, longitude: -93.2708)
    let region = computeBoundingRegion(for: [dispensary, customer, driver])
    let unwrapped = try? XCTUnwrap(region)

    let expectedCenterLat = (44.9778 + 44.9836) / 2
    let expectedCenterLng = (-93.2650 + -93.2766) / 2
    XCTAssertEqual(unwrapped?.center.latitude ?? 0, expectedCenterLat, accuracy: 0.0001)
    XCTAssertEqual(unwrapped?.center.longitude ?? 0, expectedCenterLng, accuracy: 0.0001)

    let expectedLatSpan = max(0.01, (44.9836 - 44.9778) * 1.6)
    let expectedLngSpan = max(0.01, (-93.2650 - -93.2766) * 1.6)
    XCTAssertEqual(unwrapped?.latitudeSpan ?? 0, expectedLatSpan, accuracy: 0.0001)
    XCTAssertEqual(unwrapped?.longitudeSpan ?? 0, expectedLngSpan, accuracy: 0.0001)
  }

  func test_computeBoundingRegion_paddingIsAtLeastMinimum() {
    let identical = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let region = computeBoundingRegion(for: [identical, identical, identical])
    let unwrapped = try? XCTUnwrap(region)
    XCTAssertEqual(unwrapped?.latitudeSpan ?? 0, 0.01, accuracy: 1e-9)
    XCTAssertEqual(unwrapped?.longitudeSpan ?? 0, 0.01, accuracy: 1e-9)
  }

  // MARK: - MapRegion + MapClient surface

  func test_mapRegion_isEquatable() {
    let a = MapRegion(
      center: Coordinate(latitude: 44.98, longitude: -93.27),
      latitudeSpan: 0.05,
      longitudeSpan: 0.05
    )
    let b = MapRegion(
      center: Coordinate(latitude: 44.98, longitude: -93.27),
      latitudeSpan: 0.05,
      longitudeSpan: 0.05
    )
    XCTAssertEqual(a, b)

    let c = MapRegion(
      center: Coordinate(latitude: 44.98, longitude: -93.27),
      latitudeSpan: 0.10,
      longitudeSpan: 0.05
    )
    XCTAssertNotEqual(a, c)
  }

  func test_live_matchesComputeBoundingRegion() {
    let coords = [
      Coordinate(latitude: 44.9778, longitude: -93.2650),
      Coordinate(latitude: 44.9836, longitude: -93.2766)
    ]
    let viaLive = MapClient.live.boundingRegion(coords)
    let viaPure = computeBoundingRegion(for: coords)
    XCTAssertEqual(viaLive, viaPure)
  }

  func test_unimplemented_returnsNil() {
    let coords = [Coordinate(latitude: 44.9778, longitude: -93.2650)]
    let region = MapClient.unimplemented.boundingRegion(coords)
    XCTAssertNil(region)
  }
}
