import XCTest
@testable import DankDashDomain

final class SearchResultTests: XCTestCase {
  func test_searchPageHasNextPageReportsCorrectly() {
    XCTAssertTrue(SearchPage(limit: 24, offset: 0, total: 100).hasNextPage)
    XCTAssertTrue(SearchPage(limit: 24, offset: 24, total: 100).hasNextPage)
    XCTAssertFalse(SearchPage(limit: 24, offset: 96, total: 100).hasNextPage)
    XCTAssertFalse(SearchPage(limit: 24, offset: 0, total: 24).hasNextPage)
    XCTAssertFalse(SearchPage(limit: 24, offset: 0, total: 0).hasNextPage)
  }

  func test_geoPolygonOuterAndHoles() {
    let outer = [
      Coordinate(latitude: 0, longitude: 0),
      Coordinate(latitude: 1, longitude: 0),
      Coordinate(latitude: 1, longitude: 1),
      Coordinate(latitude: 0, longitude: 0),
    ]
    let hole = [
      Coordinate(latitude: 0.4, longitude: 0.4),
      Coordinate(latitude: 0.5, longitude: 0.4),
      Coordinate(latitude: 0.5, longitude: 0.5),
      Coordinate(latitude: 0.4, longitude: 0.4),
    ]
    let polygon = GeoPolygon(rings: [outer, hole])
    XCTAssertEqual(polygon.outerRing.count, 4)
    XCTAssertEqual(polygon.holes.count, 1)
    XCTAssertEqual(polygon.holes.first?.count, 4)
  }

  func test_emptyGeoPolygonOuterRingIsEmpty() {
    XCTAssertTrue(GeoPolygon(rings: []).outerRing.isEmpty)
  }
}
