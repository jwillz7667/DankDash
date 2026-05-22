import XCTest
import DankDashDomain
@testable import DankDashNetwork

/// Wire-shape pinning for the dispatch-offer surface. Phase 19 wires
/// the DTOs but the offer card itself lights up in Phase 20 — these
/// tests guard the encoding/decoding contract so the rebuild surface
/// stays narrow when Phase 20 attaches the reducer.
final class DispatchOfferDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  func test_offerResponse_decodesAndProjectsToDomain() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0B00",
      "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
      "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
      "offeredAt": "2026-05-20T13:10:00.000Z",
      "expiresAt": "2026-05-20T13:10:30.000Z",
      "payoutEstimateCents": 1500,
      "distanceMiles": "1.234",
      "status": "offered",
      "respondedAt": null,
      "declineReason": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DispatchOfferResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.payoutEstimateCents, 1_500)
    XCTAssertEqual(domain.distanceMiles, Decimal(string: "1.234"))
    XCTAssertEqual(domain.status, .offered)
    XCTAssertNil(domain.respondedAt)
  }

  func test_offerResponse_refusesMalformedDistance() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0B01",
      "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
      "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
      "offeredAt": "2026-05-20T13:10:00.000Z",
      "expiresAt": "2026-05-20T13:10:30.000Z",
      "payoutEstimateCents": 1500,
      "distanceMiles": "one point two",
      "status": "offered",
      "respondedAt": null,
      "declineReason": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DispatchOfferResponseDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }

  func test_offerResponse_acceptedRowCarriesRespondedAt() throws {
    let json = """
    {
      "id": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0B02",
      "orderId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0400",
      "driverId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0900",
      "offeredAt": "2026-05-20T13:10:00.000Z",
      "expiresAt": "2026-05-20T13:10:30.000Z",
      "payoutEstimateCents": 1500,
      "distanceMiles": "1.234",
      "status": "accepted",
      "respondedAt": "2026-05-20T13:10:14.000Z",
      "declineReason": null
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(DispatchOfferResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.status, .accepted)
    XCTAssertNotNil(domain.respondedAt)
  }

  // MARK: - Decline body

  func test_declineRequest_omitsReasonWhenNil() throws {
    let body = DeclineOfferRequestDTO(reason: nil)
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertNil(
      json["reason"],
      "nil reason is omitted entirely so the strict-schema server doesn't see a key it has to interpret"
    )
  }

  func test_declineRequest_capsReasonAt280Chars() throws {
    let long = String(repeating: "a", count: 500)
    let body = DeclineOfferRequestDTO(reason: long)
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let reason = try XCTUnwrap(json["reason"] as? String)
    XCTAssertEqual(reason.count, 280, "iOS clamps to the same 280-char cap the server enforces")
  }

  func test_declineRequest_trimsWhitespace() throws {
    let body = DeclineOfferRequestDTO(reason: "   \n   ")
    let data = try encoder.encode(body)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertNil(
      json["reason"],
      "whitespace-only reasons are equivalent to nil — sending '   ' would set a useless decline_reason row"
    )
  }
}
