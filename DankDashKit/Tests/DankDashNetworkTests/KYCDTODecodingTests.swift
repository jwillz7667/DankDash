import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class KYCDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  // MARK: - Endpoint shape

  func test_start_postsKycStart_withNoBody() {
    let endpoint = KYCEndpoints.start()
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/identity/kyc/start")
    XCTAssertTrue(endpoint.requiresAuth)
    XCTAssertNil(endpoint.body)
  }

  // MARK: - Response decoding

  func test_startResponse_decodesAndProjectsToDomain() throws {
    let json = """
    {
      "inquiryId": "inq_9c00_72f5",
      "inquiryUrl": "https://withpersona.com/verify?inquiry-id=inq_9c00_72f5&reference-id=0190b7a4"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(KYCStartResponseDTO.self, from: json)
    let domain = try XCTUnwrap(dto.toDomain())
    XCTAssertEqual(domain.inquiryId, "inq_9c00_72f5")
    XCTAssertEqual(
      domain.inquiryURL.absoluteString,
      "https://withpersona.com/verify?inquiry-id=inq_9c00_72f5&reference-id=0190b7a4"
    )
  }

  func test_startResponse_returnsNilOnEmptyInquiryId() throws {
    let json = """
    { "inquiryId": "", "inquiryUrl": "https://withpersona.com/verify?inquiry-id=x" }
    """.data(using: .utf8)!
    let dto = try decoder.decode(KYCStartResponseDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }

  func test_startResponse_returnsNilOnMalformedUrl() throws {
    let json = """
    { "inquiryId": "inq_1", "inquiryUrl": "not a url" }
    """.data(using: .utf8)!
    let dto = try decoder.decode(KYCStartResponseDTO.self, from: json)
    XCTAssertNil(
      dto.toDomain(),
      "a scheme-less URL must reject the projection so Safari is never handed a bad URL"
    )
  }
}
