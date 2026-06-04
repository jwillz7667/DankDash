import XCTest
import Security
@testable import DankDashStorage

final class BiometricAccessControlTests: XCTestCase {
  func test_makeAccessControl_returnsObject() throws {
    // The Security framework will return a SecAccessControl on macOS even
    // though we have no biometrics — the flag combination is valid; only
    // the ACL eval at SecItemAdd time would fail on a device without Touch ID.
    let accessControl = try BiometricAccessControl.makeAccessControl()
    XCTAssertEqual(CFGetTypeID(accessControl), SecAccessControlGetTypeID())
  }
}
