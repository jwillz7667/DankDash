import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class NotificationPreferencesAPIClientTests: XCTestCase {
  func test_unimplementedClient_everyMethodThrows() async {
    let client = NotificationPreferencesAPIClient.unimplemented
    await assertThrows(try await client.getPreferences(), expectedMatch: "getPreferences")
    await assertThrows(
      try await client.updatePreferences(.single(.push, to: false)),
      expectedMatch: "updatePreferences"
    )
  }

  func test_getPreferences_returnsServerRow() async throws {
    let row = NotificationPreferences(promotionsEnabled: false, smsEnabled: false)
    let client = NotificationPreferencesAPIClient(
      getPreferences: { row },
      updatePreferences: { _ in .allOn }
    )

    let observed = try await client.getPreferences()
    XCTAssertEqual(observed, row)
  }

  func test_updatePreferences_passesPatchThroughAndReturnsRow() async throws {
    let probe = Locker<NotificationPreferencesUpdate?>(value: nil)
    let returned = NotificationPreferences(pushEnabled: false)
    let client = NotificationPreferencesAPIClient(
      getPreferences: { .allOn },
      updatePreferences: { update in
        await probe.set(update)
        return returned
      }
    )

    let patch = NotificationPreferencesUpdate.single(.push, to: false)
    let observed = try await client.updatePreferences(patch)
    XCTAssertEqual(observed, returned)
    let sent = await probe.value
    XCTAssertEqual(sent, patch)
  }

  // MARK: - Helpers

  private func assertThrows<T>(
    _ expression: @autoclosure () async throws -> T,
    expectedMatch: String,
    file: StaticString = #file,
    line: UInt = #line
  ) async {
    do {
      _ = try await expression()
      XCTFail("expected to throw containing \(expectedMatch)", file: file, line: line)
    } catch let error as NotificationPreferencesAPIError {
      if case let .unimplemented(name) = error {
        XCTAssertTrue(
          name.contains(expectedMatch),
          "unimplemented(\(name)) did not match \(expectedMatch)",
          file: file, line: line
        )
      } else {
        XCTFail("unexpected NotificationPreferencesAPIError: \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error type: \(error)", file: file, line: line)
    }
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
