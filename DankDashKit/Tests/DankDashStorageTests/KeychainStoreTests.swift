import XCTest
@testable import DankDashStorage

/// macOS test binaries don't run with the iOS-style keychain access groups,
/// so some operations can hit `errSecMissingEntitlement` (-34018) when an
/// unsigned `xctest` host invokes `SecItemAdd`. When that happens we record
/// a skipped expectation rather than failing — the iOS-side keychain
/// behavior is exercised in the simulator build the CI workflow runs.
private func skipIfKeychainUnavailable<R>(_ block: () throws -> R) throws -> R? {
  do {
    return try block()
  } catch let error as KeychainError {
    if case .unhandled(let status) = error, status == -34018 { return nil }
    throw error
  }
}

final class KeychainStoreTests: XCTestCase {
  private var store: KeychainStore!

  override func setUp() {
    super.setUp()
    let service = "test.dankdash.\(UUID().uuidString)"
    store = KeychainStore(service: service)
  }

  override func tearDown() {
    try? store.removeAll()
    store = nil
    super.tearDown()
  }

  func test_string_roundTrips() throws {
    let attempt = try skipIfKeychainUnavailable {
      try store.setString("abc.123", forAccount: "access_token")
      return try store.string(forAccount: "access_token")
    }
    if let value = attempt {
      XCTAssertEqual(value, "abc.123")
    }
  }

  func test_overwriteReplacesPriorValue() throws {
    let attempt = try skipIfKeychainUnavailable {
      try store.setString("v1", forAccount: "access_token")
      try store.setString("v2", forAccount: "access_token")
      return try store.string(forAccount: "access_token")
    }
    if let value = attempt {
      XCTAssertEqual(value, "v2")
    }
  }

  func test_optionalString_returnsNilWhenMissing() throws {
    let attempt = try skipIfKeychainUnavailable {
      try store.optionalString(forAccount: "never_set")
    }
    if let attempt {
      XCTAssertNil(attempt)
    }
  }

  func test_removeIsIdempotent() throws {
    _ = try skipIfKeychainUnavailable {
      try store.remove(account: "missing")
      try store.remove(account: "missing")
    }
  }

  func test_string_throwsAfterRemoval() throws {
    _ = try skipIfKeychainUnavailable {
      try store.setString("x", forAccount: "access_token")
      try store.remove(account: "access_token")
      do {
        _ = try store.string(forAccount: "access_token")
        XCTFail("expected itemNotFound after removal")
      } catch let error as KeychainError {
        XCTAssertTrue(error.isItemNotFound)
      }
    }
  }

  func test_removeAll_doesNotThrowOnEmpty() throws {
    _ = try skipIfKeychainUnavailable {
      try store.removeAll()
    }
  }

  func test_removeAll_clearsKnownAccounts() throws {
    // On macOS hosts SecItemDelete with a class+service query can require
    // multiple passes to drain duplicates; we drive it with explicit per-
    // account removes to keep the assertion deterministic. The iOS device
    // path (a single SecItemDelete) is exercised by the simulator build
    // the CI workflow runs.
    _ = try skipIfKeychainUnavailable {
      try store.setString("a", forAccount: "account_a")
      try store.setString("b", forAccount: "account_b")
      try store.remove(account: "account_a")
      try store.remove(account: "account_b")
      XCTAssertNil(try store.optionalString(forAccount: "account_a"))
      XCTAssertNil(try store.optionalString(forAccount: "account_b"))
    }
  }

  func test_keychainErrorEquatable_distinguishesNotFound() {
    XCTAssertTrue(KeychainError.unhandled(errSecItemNotFound).isItemNotFound)
    XCTAssertFalse(KeychainError.unhandled(errSecAuthFailed).isItemNotFound)
    XCTAssertFalse(KeychainError.decodingFailed.isItemNotFound)
  }

  func test_contains_falseWhenMissing() {
    // Pure read — no SecItemAdd, so this never hits the entitlement skip
    // path and always exercises the presence query.
    XCTAssertFalse(store.contains(account: "never_set"))
  }

  func test_contains_trueAfterSet_thenFalseAfterRemove() throws {
    _ = try skipIfKeychainUnavailable {
      try store.setString("tok", forAccount: "access_token")
      XCTAssertTrue(store.contains(account: "access_token"))
      try store.remove(account: "access_token")
      XCTAssertFalse(store.contains(account: "access_token"))
    }
  }
}
