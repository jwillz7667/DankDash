import XCTest
@testable import DankDashDomain

final class DemandHeatmapCellTests: XCTestCase {
  func test_idMirrorsCellId() {
    let cell = DemandHeatmapCell(
      cellId: "8a283082aab8fff",
      polygon: [
        Coordinate(latitude: 44.9778, longitude: -93.2650),
        Coordinate(latitude: 44.9800, longitude: -93.2650),
        Coordinate(latitude: 44.9800, longitude: -93.2600),
      ],
      demandScore: Decimal(string: "0.72") ?? 0
    )
    XCTAssertEqual(cell.id, cell.cellId)
  }

  func test_decimalDemandScorePreservesPrecision() {
    // Cannabis-numeric contract: never `Double`. A score of 0.123456789
    // should not silently round.
    let raw = "0.123456789"
    let score = Decimal(string: raw) ?? 0
    let cell = DemandHeatmapCell(cellId: "x", polygon: [], demandScore: score)
    XCTAssertEqual(cell.demandScore.description, raw)
  }
}
