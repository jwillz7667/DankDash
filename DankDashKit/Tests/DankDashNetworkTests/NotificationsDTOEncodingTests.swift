import XCTest
@testable import DankDashNetwork

final class NotificationsDTOEncodingTests: XCTestCase {
  private let encoder = JSONEncoder()

  func test_registerDeviceRequest_encodesLowercaseDeviceId() throws {
    let deviceId = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE9001")!
    let token = String(repeating: "ab", count: 32) // 64 lowercase hex chars
    let body = RegisterDeviceRequestDTO(apnsToken: token, deviceId: deviceId, appVariant: .consumer)
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: String]
    )
    XCTAssertEqual(payload["apnsToken"], token)
    XCTAssertEqual(payload["deviceId"], "0190b7a4-9c00-72f5-a6b0-1c6f77ce9001")
    XCTAssertEqual(payload["platform"], "ios")
    XCTAssertEqual(payload["appVariant"], "consumer")
  }

  func test_registerDeviceRequest_encodesDriverVariant() throws {
    let body = RegisterDeviceRequestDTO(
      apnsToken: String(repeating: "cd", count: 32),
      deviceId: UUID(),
      appVariant: .driver
    )
    let json = try encoder.encode(body)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: json) as? [String: String]
    )
    XCTAssertEqual(payload["appVariant"], "driver")
  }

  func test_registerDeviceRequest_defaultPlatformIsIOS() throws {
    let body = RegisterDeviceRequestDTO(
      apnsToken: "0123456789abcdef",
      deviceId: UUID(),
      appVariant: .consumer
    )
    XCTAssertEqual(body.platform, "ios")
  }
}
