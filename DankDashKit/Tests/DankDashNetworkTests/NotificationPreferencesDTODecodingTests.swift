import XCTest
import DankDashDomain
@testable import DankDashNetwork

final class NotificationPreferencesDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  // MARK: - Response decoding

  func test_response_decodesAndProjectsToDomain() throws {
    let dto = try decoder.decode(
      NotificationPreferencesResponseDTO.self,
      from: Self.savedJSON.data(using: .utf8)!
    )
    let domain = dto.toDomain()
    XCTAssertTrue(domain.orderUpdatesEnabled)
    XCTAssertFalse(domain.promotionsEnabled)
    XCTAssertTrue(domain.pushEnabled)
    XCTAssertFalse(domain.smsEnabled)
    XCTAssertTrue(domain.emailEnabled)
    XCTAssertNotNil(domain.updatedAt, "a saved row carries a timestamp")
  }

  func test_response_nullUpdatedAt_projectsNilTimestamp() throws {
    let dto = try decoder.decode(
      NotificationPreferencesResponseDTO.self,
      from: Self.unsavedJSON.data(using: .utf8)!
    )
    let domain = dto.toDomain()
    XCTAssertNil(domain.updatedAt, "an unsaved (synthesized) row has null updatedAt")
    for toggle in NotificationToggle.allCases {
      XCTAssertTrue(domain.value(for: toggle), "synthesized defaults are all-on")
    }
  }

  func test_response_malformedUpdatedAt_degradesToNilWithoutDroppingPayload() throws {
    let bad = Self.savedJSON.replacingOccurrences(
      of: "\"2026-05-19T20:00:00.000Z\"",
      with: "\"not-a-timestamp\""
    )
    let dto = try decoder.decode(NotificationPreferencesResponseDTO.self, from: bad.data(using: .utf8)!)
    let domain = dto.toDomain()
    XCTAssertNil(domain.updatedAt, "a malformed timestamp must not crash or drop the toggles")
    XCTAssertFalse(domain.promotionsEnabled, "the valid toggles still project")
  }

  // MARK: - Request encoding

  func test_request_fromSingleTogglePatch_emitsExactlyOneKey() throws {
    let body = UpdateNotificationPreferencesRequestDTO(.single(.promotions, to: false))
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: encoder.encode(body)) as? [String: Any]
    )
    XCTAssertEqual(payload.keys.sorted(), ["promotionsEnabled"])
    XCTAssertEqual(payload["promotionsEnabled"] as? Bool, false)
  }

  func test_request_omitsNilTogglesViaEncodeIfPresent() throws {
    let body = UpdateNotificationPreferencesRequestDTO(pushEnabled: false, emailEnabled: true)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: encoder.encode(body)) as? [String: Any]
    )
    XCTAssertEqual(payload.keys.sorted(), ["emailEnabled", "pushEnabled"])
    XCTAssertEqual(payload["pushEnabled"] as? Bool, false)
    XCTAssertEqual(payload["emailEnabled"] as? Bool, true)
  }

  func test_request_fullFiveTogglePatch_emitsAllKeys() throws {
    let update = NotificationPreferencesUpdate(
      orderUpdatesEnabled: false,
      promotionsEnabled: false,
      pushEnabled: false,
      smsEnabled: false,
      emailEnabled: false
    )
    let body = UpdateNotificationPreferencesRequestDTO(update)
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: encoder.encode(body)) as? [String: Any]
    )
    XCTAssertEqual(
      payload.keys.sorted(),
      ["emailEnabled", "orderUpdatesEnabled", "promotionsEnabled", "pushEnabled", "smsEnabled"]
    )
  }

  // MARK: - Fixtures

  private static let savedJSON = """
  {
    "orderUpdatesEnabled": true,
    "promotionsEnabled": false,
    "pushEnabled": true,
    "smsEnabled": false,
    "emailEnabled": true,
    "updatedAt": "2026-05-19T20:00:00.000Z"
  }
  """

  private static let unsavedJSON = """
  {
    "orderUpdatesEnabled": true,
    "promotionsEnabled": true,
    "pushEnabled": true,
    "smsEnabled": true,
    "emailEnabled": true,
    "updatedAt": null
  }
  """
}
