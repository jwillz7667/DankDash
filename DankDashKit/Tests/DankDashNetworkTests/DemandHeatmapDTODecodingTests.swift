import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class DemandHeatmapDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_heatmap_decodesAndProjectsCells() throws {
    let json = """
    {
      "cells": [
        {
          "cellId": "8a283082aab8fff",
          "polygon": [
            [-93.2650, 44.9778],
            [-93.2600, 44.9778],
            [-93.2625, 44.9810]
          ],
          "demandScore": "0.72"
        },
        {
          "cellId": "8a283082aab9fff",
          "polygon": [
            [-93.2700, 44.9810],
            [-93.2650, 44.9810],
            [-93.2675, 44.9850]
          ],
          "demandScore": "0.15"
        }
      ]
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DemandHeatmapResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(domain.count, 2)
    XCTAssertEqual(domain[0].cellId, "8a283082aab8fff")
    XCTAssertEqual(domain[0].demandScore, Decimal(string: "0.72"))
    XCTAssertEqual(domain[0].polygon.count, 3)
    XCTAssertEqual(domain[0].polygon[0].latitude, 44.9778)
    XCTAssertEqual(domain[0].polygon[0].longitude, -93.2650)
  }

  func test_heatmap_dropsDegenerateRing() throws {
    let json = """
    {
      "cells": [
        {
          "cellId": "8a283082aab8fff",
          "polygon": [
            [-93.2650, 44.9778],
            [-93.2600, 44.9778]
          ],
          "demandScore": "0.72"
        },
        {
          "cellId": "8a283082aab9fff",
          "polygon": [
            [-93.2700, 44.9810],
            [-93.2650, 44.9810],
            [-93.2675, 44.9850]
          ],
          "demandScore": "0.15"
        }
      ]
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DemandHeatmapResponseDTO.self, from: json)
    let domain = dto.toDomain()
    XCTAssertEqual(domain.count, 1, "two-point ring is degenerate; dropped silently")
  }

  func test_heatmap_dropsOutOfRangeScore() throws {
    let json = """
    {
      "cells": [
        {
          "cellId": "8a283082aab8fff",
          "polygon": [
            [-93.2650, 44.9778],
            [-93.2600, 44.9778],
            [-93.2625, 44.9810]
          ],
          "demandScore": "1.5"
        }
      ]
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DemandHeatmapResponseDTO.self, from: json)
    XCTAssertTrue(
      dto.toDomain().isEmpty,
      "out-of-range scores drop; server-side wrong, not just visually off"
    )
  }

  func test_heatmap_emptyResponseIsValid() throws {
    let json = """
    { "cells": [] }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DemandHeatmapResponseDTO.self, from: json)
    XCTAssertTrue(
      dto.toDomain().isEmpty,
      "empty cells is the happy path in a low-demand suburb; render empty overlay"
    )
  }
}
