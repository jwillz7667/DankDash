import XCTest
@testable import DankDashStorage

/// Each test instantiates a `UserDefaultsStore` backed by a unique suite
/// so the host's `.standard` defaults are never touched and runs in
/// parallel can't collide on shared keys.
final class UserDefaultsStoreTests: XCTestCase {
  private var suiteName: String!
  private var store: UserDefaultsStore!

  override func setUp() {
    super.setUp()
    suiteName = "test.\(UUID().uuidString)"
    store = UserDefaultsStore(suiteName: suiteName)
  }

  override func tearDown() {
    UserDefaults().removePersistentDomain(forName: suiteName)
    store = nil
    suiteName = nil
    super.tearDown()
  }

  func test_string_roundTripsAndClearsOnNil() {
    XCTAssertNil(store.string(forKey: .lastUsedEmail))
    store.setString("you@dankdash.test", forKey: .lastUsedEmail)
    XCTAssertEqual(store.string(forKey: .lastUsedEmail), "you@dankdash.test")
    store.setString(nil, forKey: .lastUsedEmail)
    XCTAssertNil(store.string(forKey: .lastUsedEmail))
  }

  func test_bool_defaultsToFalseWhenUnset() {
    XCTAssertFalse(store.bool(forKey: .lastSeenAppVersion))
    store.setBool(true, forKey: .lastSeenAppVersion)
    XCTAssertTrue(store.bool(forKey: .lastSeenAppVersion))
  }

  func test_date_storesAndReads() {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    XCTAssertNil(store.date(forKey: .ageGatePassedAt))
    store.setDate(now, forKey: .ageGatePassedAt)
    XCTAssertEqual(store.date(forKey: .ageGatePassedAt), now)
  }

  func test_ageGate_passesWhenDateRecorded() {
    XCTAssertFalse(store.hasPassedAgeGate)
    store.markAgeGatePassed(at: Date(timeIntervalSince1970: 1_700_000_000))
    XCTAssertTrue(store.hasPassedAgeGate)
    store.clearAgeGate()
    XCTAssertFalse(store.hasPassedAgeGate)
  }

  func test_lastUsedEmail_convenienceMirrorsString() {
    store.setLastUsedEmail("driver@dankdash.test")
    XCTAssertEqual(store.lastUsedEmail, "driver@dankdash.test")
    store.setLastUsedEmail(nil)
    XCTAssertNil(store.lastUsedEmail)
  }
}
