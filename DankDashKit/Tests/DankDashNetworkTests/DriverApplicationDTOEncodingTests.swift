import XCTest
import DankDashDomain
@testable import DankDashNetwork

/// Encoding-side pinning for the (deferred) driver application
/// submission. The endpoint itself is documented as deferred; on a 404
/// the iOS reducer falls through to `.pending` with a `queued` flag.
/// These tests guard the wire shape so once the endpoint lands the
/// reducer pushes the right body without a follow-up touch.
final class DriverApplicationDTOEncodingTests: XCTestCase {
  private let encoder = JSONEncoder()

  private func makeCompleteDraft() -> DriverApplicationDraft {
    let vehicle = Vehicle(
      make: "Honda",
      model: "Civic",
      year: 2021,
      plate: "ABC123",
      color: "Blue"
    )
    var documents: [DocumentSlot: DraftDocument] = [:]
    for slot in DocumentSlot.allCases {
      documents[slot] = DraftDocument(
        id: UUID(),
        slot: slot,
        localFileURL: URL(fileURLWithPath: "/tmp/\(slot.rawValue).jpg"),
        mimeType: "image/jpeg",
        capturedAt: Date(timeIntervalSince1970: 0),
        sizeBytes: 1024
      )
    }
    return DriverApplicationDraft(
      vehicle: vehicle,
      licenseNumber: "MN-12345678",
      documents: documents
    )
  }

  func test_request_buildsFromCompleteDraft() throws {
    let draft = makeCompleteDraft()
    let dto = try XCTUnwrap(DriverApplicationRequestDTO.from(draft))
    XCTAssertEqual(dto.vehicleMake, "Honda")
    XCTAssertEqual(dto.vehicleYear, 2021)
    XCTAssertEqual(dto.licenseNumber, "MN-12345678")
    XCTAssertEqual(dto.documents.count, 3)
    let kinds = Set(dto.documents.map(\.kind))
    XCTAssertEqual(kinds, ["drivers_license", "vehicle_insurance", "vehicle_registration"])
  }

  func test_request_returnsNilForIncompleteDraft() {
    let draft = DriverApplicationDraft(
      vehicle: Vehicle(),
      licenseNumber: "",
      documents: [:]
    )
    XCTAssertNil(DriverApplicationRequestDTO.from(draft))
  }

  func test_request_returnsNilForMissingDocumentSlot() {
    var draft = makeCompleteDraft()
    var documents = draft.documents
    documents.removeValue(forKey: .vehicleInsurance)
    draft = DriverApplicationDraft(
      vehicle: draft.vehicle,
      licenseNumber: draft.licenseNumber,
      documents: documents
    )
    XCTAssertNil(DriverApplicationRequestDTO.from(draft))
  }

  func test_request_encodesFlatVehicleFields() throws {
    let dto = try XCTUnwrap(DriverApplicationRequestDTO.from(makeCompleteDraft()))
    let data = try encoder.encode(dto)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["vehicleMake"] as? String, "Honda")
    XCTAssertEqual(json["vehicleYear"] as? Int, 2021)
    XCTAssertEqual(json["licenseNumber"] as? String, "MN-12345678")
    let documents = try XCTUnwrap(json["documents"] as? [[String: Any]])
    XCTAssertEqual(documents.count, 3)
  }

  func test_responseDTO_decodesQueueShape() throws {
    let json = """
    {
      "applicationId": "0190B7A4-9C00-72F5-A6B0-1C6F77CE0C00",
      "status": "pending",
      "queuePosition": 3
    }
    """.data(using: .utf8)!
    let dto = try JSONDecoder().decode(DriverApplicationResponseDTO.self, from: json)
    XCTAssertEqual(dto.status, "pending")
    XCTAssertEqual(dto.queuePosition, 3)
  }
}
