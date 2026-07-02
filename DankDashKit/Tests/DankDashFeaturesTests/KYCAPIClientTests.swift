import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class KYCAPIClientTests: XCTestCase {
  func test_unimplementedClient_throwsOnStart() async {
    let client = KYCAPIClient.unimplemented
    do {
      _ = try await client.startInquiry()
      XCTFail("expected to throw")
    } catch let error as KYCAPIError {
      guard case let .unimplemented(name) = error else {
        XCTFail("unexpected case: \(error)")
        return
      }
      XCTAssertTrue(name.contains("startInquiry"))
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }

  func test_customClient_returnsInquiry() async throws {
    let inquiry = KYCInquiry(
      inquiryId: "inq_abc",
      inquiryURL: URL(string: "https://withpersona.com/verify?inquiry-id=inq_abc")!
    )
    let client = KYCAPIClient(startInquiry: { inquiry })

    let result = try await client.startInquiry()
    XCTAssertEqual(result, inquiry)
  }

  func test_apiErrors_areEquatable() {
    XCTAssertEqual(
      KYCAPIError.malformedPayload("KYCInquiry"),
      KYCAPIError.malformedPayload("KYCInquiry")
    )
    XCTAssertNotEqual(
      KYCAPIError.malformedPayload("KYCInquiry"),
      KYCAPIError.unimplemented("startInquiry")
    )
  }
}
