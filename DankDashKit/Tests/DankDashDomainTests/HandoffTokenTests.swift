import XCTest
@testable import DankDashDomain

final class HandoffTokenTests: XCTestCase {
  private func makeToken(expiresAt: Date) -> HandoffToken {
    HandoffToken(
      token: "stub.jwt.token",
      // swiftlint:disable:next force_unwrapping
      exchangeUrl: URL(string: "https://app.dankdash.com/checkout?handoff=stub")!,
      expiresAt: expiresAt
    )
  }

  func test_notExpiredWhenNowBeforeExpiry() {
    let now = Date(timeIntervalSince1970: 1_000)
    let token = makeToken(expiresAt: Date(timeIntervalSince1970: 1_300))
    XCTAssertFalse(token.isExpired(asOf: now))
  }

  func test_expiredWhenNowExactlyAtExpiry() {
    // `<=` on expiresAt: equality counts as expired so the next click
    // mints a fresh token instead of racing the server's clock.
    let stamp = Date(timeIntervalSince1970: 1_000)
    let token = makeToken(expiresAt: stamp)
    XCTAssertTrue(token.isExpired(asOf: stamp))
  }

  func test_expiredWhenNowAfterExpiry() {
    let token = makeToken(expiresAt: Date(timeIntervalSince1970: 1_000))
    XCTAssertTrue(token.isExpired(asOf: Date(timeIntervalSince1970: 1_500)))
  }

  func test_codableRoundTrip() throws {
    let original = makeToken(expiresAt: Date(timeIntervalSince1970: 1_700_000_000))
    let data = try JSONEncoder().encode(original)
    let back = try JSONDecoder().decode(HandoffToken.self, from: data)
    XCTAssertEqual(back.token, original.token)
    XCTAssertEqual(back.exchangeUrl, original.exchangeUrl)
    XCTAssertEqual(back.expiresAt, original.expiresAt)
  }
}
